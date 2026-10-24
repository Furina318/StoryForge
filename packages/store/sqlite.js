'use strict';
/**
 * SQLite 仓储（better-sqlite3，同步 API）
 *
 * 这个文件同时被两处使用：
 *   - apps/desktop/db.js：Electron 主进程打开真实数据库；
 *   - 未来 packages/core 的测试：直接 new Database(':memory:') 后 createRepo()。
 *
 * v2 起是多项目的：每个项目一份完整资产（章节卡、角色、世界观、伏笔、状态卡）。
 * 对外暴露"项目级 overlay"，形状与 apps/ui/store.js 的 localStorage 快照一致：
 *   { project, chapters: { c3: { status, title, card, blocks } },
 *     entities: [...], worldRules: [...], foreshadows: [...],
 *     waivers: [...], gate: {...}, confirmed: [...], kv: { lastChapterId: 'c3' } }
 */

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const SFBlocks = require('../blocks/versioning.js');

const SCHEMA = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
const META_SEEDED = 'seeded_at';
const META_VERSION = 'schema_version';
const SCHEMA_VERSION = '6';
const now = () => new Date().toISOString();

function tableExists(db, name) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name);
}

function dropAll(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  db.pragma('foreign_keys = OFF');
  tables.forEach((t) => db.exec('DROP TABLE IF EXISTS "' + t.name + '"'));
  db.pragma('foreign_keys = ON');
}

/**
 * 原型阶段的迁移策略：结构变了几次，而库里的都是演示数据。
 * 版本对不上就整库重建（下次启动重新播种），不做列级迁移——
 * 等真的有用户数据时，这里必须换成一组不可回退的 migration。
 */
function columnsOf(db, table) {
  return db.prepare('PRAGMA table_info(' + table + ')').all().map((c) => c.name);
}

function addColumn(db, table, name, ddl) {
  if (columnsOf(db, table).indexOf(name) >= 0) return;
  db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + name + ' ' + ddl);
}

/**
 * 迁移策略（v3 起不再整库重建 —— 库里已经有用户真正在写的小说了）：
 *  * v1（没有 chapter_count）-> 重建，那时候只有演示数据。
 *  * v2 -> v3 全部是加列/加表 + 回填，不删任何一行。
 *  * 回填：block.project_id / created_at、chapter.current_rev = 1、每章第 1 版快照。
 */
function migrate(db) {
  const hasProject = tableExists(db, 'project');
  if (!hasProject) return;
  const cols = columnsOf(db, 'project');
  if (cols.indexOf('chapter_count') < 0) { dropAll(db); return; }

  const versioned = tableExists(db, 'meta')
    ? (db.prepare('SELECT v FROM meta WHERE k = ?').get(META_VERSION) || {}).v
    : null;
  /* --- v5 -> v6：书库的书要能存封面（联网下载的 epub 自带封面） --- */
  if (tableExists(db, 'book')) {
    addColumn(db, 'book', 'cover', 'TEXT');
  }
  if (versioned === '6') return;
  if (versioned === '5') return;

  /* --- v3 -> v4：角色弧线（可选） --- */
  if (tableExists(db, 'entity')) {
    addColumn(db, 'entity', 'arc_json', 'TEXT');
  }

  /* v4 -> v5 只加新表（book / book_toc / book_mark / book_source），
     schema.sql 里的 CREATE TABLE IF NOT EXISTS 会建，这里不用补列。 */
  if (versioned === '4') return;

  if (versioned === '3') return;

  /* --- v2 -> v3 --- */
  if (tableExists(db, 'block')) {
    addColumn(db, 'block', 'project_id', 'TEXT');
    addColumn(db, 'block', 'superseded_by', 'TEXT');
    addColumn(db, 'block', 'deleted_at', 'TEXT');
    addColumn(db, 'block', 'created_at', 'TEXT');
    db.exec("UPDATE block SET project_id = (SELECT chapter.project_id FROM chapter WHERE chapter.id = block.chapter_id) WHERE project_id IS NULL");
    db.exec('UPDATE block SET created_at = updated_at WHERE created_at IS NULL');
  }
  if (tableExists(db, 'chapter')) {
    addColumn(db, 'chapter', 'current_rev', 'INTEGER NOT NULL DEFAULT 1');
    addColumn(db, 'chapter', 'summary', 'TEXT');
    addColumn(db, 'chapter', 'summary_rev', 'INTEGER');
  }
}

/** 给还没有任何快照的章补一条 rev=1（幂等，每次启动都能跑） */
function backfillRevs(db) {
  if (!tableExists(db, 'block_rev') || !tableExists(db, 'chapter')) return;
  const chapters = db.prepare('SELECT id FROM chapter').all();
  const has = db.prepare('SELECT 1 AS n FROM block_rev WHERE chapter_id = ? LIMIT 1');
  const ins = db.prepare('INSERT OR IGNORE INTO block_rev (chapter_id, rev, block_id, ord) VALUES (?, ?, ?, ?)');
  const blocks = db.prepare('SELECT id, ord FROM block WHERE chapter_id = ? AND superseded_by IS NULL AND deleted_at IS NULL ORDER BY ord');
  db.transaction(() => {
    chapters.forEach((c) => {
      if (has.get(c.id)) return;
      blocks.all(c.id).forEach((b) => ins.run(c.id, 1, b.id, b.ord));
    });
  })();
}

function open(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  db.exec(SCHEMA);
  db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
    .run(META_VERSION, SCHEMA_VERSION);
  backfillRevs(db);
  return createRepo(db, dbPath);
}

function blockMeta(b) {
  const meta = {};
  ['actors', 'place', 'moveTo', 'scene'].forEach((k) => {
    if (b[k] !== undefined) meta[k] = b[k];
  });
  return meta;
}

function decodeBlock(row) {
  let meta = {};
  try { meta = JSON.parse(row.meta_json || '{}'); } catch { meta = {}; }
  return Object.assign({ id: row.id, text: row.text, src: row.src || 'human' }, meta);
}

function parseJson(s, fallback) {
  try { const v = JSON.parse(s || ''); return v == null ? fallback : v; } catch { return fallback; }
}

function createRepo(db, dbPath) {
  /* ---------------- 投影 ---------------- */

  function projectRow(r) {
    const extra = parseJson(r.card_json, {});
    return {
      id: r.id,
      name: r.name,
      genre: r.genre || '',
      logline: r.logline || '',
      sellPoint: extra.sellPoint || r.sell_point || '',
      desire: extra.desire || r.desire || '',
      conflict: extra.conflict || r.conflict || '',
      conflicts: extra.conflicts || [],
      conflictLead: extra.conflictLead || '',
      style: extra.style || {},
      cover: extra.cover || '',
      targetWords: r.target_words || 0,
      chapterCount: r.chapter_count || 0,
      isDemo: !!r.is_demo,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    };
  }

  /* 表结构不随内容膨胀：多维阻力与文风卡都进 card_json，读的时候再摊开 */
  const EXTRA_KEYS = ['sellPoint', 'desire', 'conflict', 'conflicts', 'conflictLead', 'style', 'wordsPerChapter', 'cover'];
  function extrasOf(p, base) {
    const out = Object.assign({}, base || {});
    EXTRA_KEYS.forEach((k) => {
      if (p && Object.prototype.hasOwnProperty.call(p, k)) out[k] = p[k];
    });
    return out;
  }

  const insertProjectStmt = () => db.prepare(`INSERT INTO project
    (id, name, genre, logline, sell_point, desire, conflict, target_words, chapter_count,
     is_demo, card_json, created_at, updated_at)
    VALUES (@id, @name, @genre, @logline, @sell_point, @desire, @conflict, @target_words,
     @chapter_count, @is_demo, @card_json, @created_at, @updated_at)`);

  function insertProject(p, ts) {
    insertProjectStmt().run({
      id: p.id,
      name: p.name || '未命名',
      genre: p.genre || '',
      logline: p.logline || '',
      sell_point: p.sellPoint || '',
      desire: p.desire || '',
      conflict: p.conflict || '',
      target_words: p.targetWords || 0,
      chapter_count: p.chapterCount || 0,
      is_demo: p.isDemo ? 1 : 0,
      card_json: JSON.stringify(extrasOf(p, p.card || {})),
      created_at: p.createdAt || ts,
      updated_at: ts
    });
  }

  const insertChapters = (pid, chapters, ts) => {
    const insCh = db.prepare(`INSERT OR REPLACE INTO chapter
      (id, project_id, idx, title, status, card_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const insBlk = db.prepare(`INSERT OR REPLACE INTO block
      (id, chapter_id, project_id, ord, text, src, meta_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insRev = db.prepare('INSERT OR REPLACE INTO block_rev (chapter_id, rev, block_id, ord) VALUES (?, ?, ?, ?)');
    (chapters || []).forEach((c) => {
      insCh.run(c.id, pid, c.idx, c.title, c.status, JSON.stringify(c.card || {}), ts);
      (c.blocks || []).forEach((b, i) => {
        const ord = (i + 1) * 10;
        insBlk.run(b.id, c.id, pid, ord, b.text, b.src || 'human', JSON.stringify(blockMeta(b)), ts, ts);
        insRev.run(c.id, 1, b.id, ord);
      });
    });
  };

  const insertAssets = (pid, seed, ts) => {
    const insEnt = db.prepare(`INSERT OR REPLACE INTO entity
      (id, project_id, kind, name, role, desire, wound, voice, secret, note, arc_json, ord, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    (seed.entities || []).forEach((e, i) => {
      insEnt.run(e.id, pid, e.kind || '配角', e.name, e.role || '', e.desire || '', e.wound || '',
        e.voice || '', e.secret || '', e.note || '', arcJsonOf(e),
        e.ord != null ? e.ord : i, ts);
    });

    const insWorld = db.prepare(`INSERT OR REPLACE INTO world_rule
      (id, project_id, kind, name, text, ord, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    (seed.worldRules || []).forEach((w, i) => {
      insWorld.run(w.id, pid, w.kind || '规则', w.name, w.text || '', w.ord != null ? w.ord : i, ts);
    });

    const insState = db.prepare(`INSERT OR REPLACE INTO entity_state
      (id, project_id, entity, field, from_value, to_value, chapter, block_id, quote, confidence,
       checked, kind, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    (seed.proposedStates || []).forEach((p) => {
      insState.run(p.id, pid, p.entity, p.field, p.from || '', p.to || '', p.chapter || null,
        p.block || null, p.quote || '', p.conf || 0, p.checked ? 1 : 0, 'proposed', ts);
    });
    // 已确认状态也要落库：Electron 与浏览器若从两个地方读"进上下文的状态"，迟早对不上。
    (seed.confirmedStates || []).forEach((c, i) => {
      insState.run(c.id || ('cs' + (i + 1)), pid, c.entity, c.field, c.from || '',
        c.value || c.to || '', c.chapter || null, c.block || null, c.quote || '', 1, 1, 'confirmed', ts);
    });

    const insFs = db.prepare(`INSERT OR REPLACE INTO foreshadow
      (id, project_id, title, planted_chapter, planted_block, quote, due_chapter, status,
       related_json, note, ord, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    (seed.foreshadows || []).forEach((f, i) => {
      insFs.run(f.id, pid, f.title, f.plantedChapter || null, f.plantedBlock || null, f.quote || '',
        f.due || null, f.status || 'planted', JSON.stringify(f.related || []), f.note || '',
        f.ord != null ? f.ord : i, ts);
    });
  };

  /* ---------------- 播种 ---------------- */

  function isEmpty() {
    const r = db.prepare('SELECT COUNT(*) AS n FROM project').get();
    return !r || r.n === 0;
  }

  const seedTx = db.transaction((seed) => {
    const ts = now();
    insertProject(Object.assign({}, seed.project, { isDemo: !!seed.project.isDemo }), ts);
    insertChapters(seed.project.id, seed.chapters, ts);
    insertAssets(seed.project.id, seed, ts);
    const last = (seed.kv && seed.kv.lastChapterId) || (seed.chapters[0] && seed.chapters[0].id) || '';
    db.prepare('INSERT INTO kv (project_id, k, v) VALUES (?, ?, ?)')
      .run(seed.project.id, 'lastChapterId', last);
    db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
      .run(META_SEEDED, ts);
  });

  function seedIfEmpty(seed) {
    if (!isEmpty()) return false;
    /* 只在第一次建库时播种；用户把项目删光了不该被偷偷塞回示例 */
    const done = db.prepare('SELECT v FROM meta WHERE k = ?').get(META_SEEDED);
    if (done) return false;
    seedTx(seed);
    return true;
  }

  /* ---------------- 项目 ---------------- */

  // 字数口径与界面一致：去掉空白后的字符数（LENGTH(REPLACE(...))）
  const wordsStmt = db.prepare(
    `SELECT chapter.project_id AS pid,
            SUM(LENGTH(REPLACE(REPLACE(block.text, ' ', ''), char(10), ''))) AS w
     FROM block JOIN chapter ON chapter.id = block.chapter_id GROUP BY chapter.project_id`);

  function wordsByProject() {
    const map = {};
    wordsStmt.all().forEach((r) => { map[r.pid] = r.w || 0; });
    return map;
  }

  function listProjects() {
    const words = wordsByProject();
    return db.prepare('SELECT * FROM project ORDER BY is_demo DESC, updated_at DESC').all().map((r) => {
      const p = projectRow(r);
      return {
        id: p.id, name: p.name, genre: p.genre, logline: p.logline,
        cover: p.cover || '',
        targetWords: p.targetWords, chapterCount: p.chapterCount, isDemo: p.isDemo,
        words: words[p.id] || 0, updatedAt: p.updatedAt
      };
    });
  }

  function getProject(pid) {
    const r = db.prepare('SELECT * FROM project WHERE id = ?').get(pid);
    return r ? projectRow(r) : null;
  }

  const createProjectTx = db.transaction((payload) => {
    const ts = now();
    const p = Object.assign({ createdAt: ts }, payload.project);
    insertProject(p, ts);
    insertChapters(p.id, payload.chapters || [], ts);
    /* payload 的资料卡一直放在顶层（entities / worldRules / foreshadows），
       之前这里只读 payload.assets，于是新建的项目一个资料卡都没有。 */
    insertAssets(p.id, payload.assets || payload, ts);
    db.prepare('INSERT INTO kv (project_id, k, v) VALUES (?, ?, ?) ON CONFLICT(project_id, k) DO UPDATE SET v = excluded.v')
      .run(p.id, 'lastChapterId', (payload.chapters && payload.chapters[0] && payload.chapters[0].id) || '');
    return p.id;
  });

  function createProject(payload) {
    if (!payload || !payload.project || !payload.project.id) throw new Error('createProject: missing project.id');
    return createProjectTx(payload);
  }

  const saveProjectMetaTx = db.transaction((pid, meta) => {
    /* 以前这里是直接覆盖：传 {style} 进来，名字会变成"未命名"、字数归零。
     * 现在先读现状再合并，且 card_json 里的扩展字段按 key 合并。 */
    const row = db.prepare('SELECT * FROM project WHERE id = ?').get(pid);
    if (!row) return false;
    const cur = projectRow(row);
    const merged = Object.assign({}, cur, meta || {});
    const extra = extrasOf(meta, parseJson(row.card_json, {}));
    db.prepare(`UPDATE project SET name = @name, genre = @genre, logline = @logline,
      sell_point = @sell_point, desire = @desire, conflict = @conflict,
      target_words = @target_words, chapter_count = @chapter_count,
      card_json = @card_json, updated_at = @updated_at
      WHERE id = @id`).run({
      id: pid,
      name: merged.name || '未命名',
      genre: merged.genre || '',
      logline: merged.logline || '',
      sell_point: merged.sellPoint || '',
      desire: merged.desire || '',
      conflict: merged.conflict || '',
      target_words: merged.targetWords || 0,
      chapter_count: merged.chapterCount || 0,
      card_json: JSON.stringify(extra),
      updated_at: now()
    });
    return true;
  });

  function saveProjectMeta(pid, meta) {
    saveProjectMetaTx(pid, meta || {});
    return true;
  }

  function deleteProject(pid) {
    /* kv 表没有外键（历史原因），不显式删就会留下孤儿行，
     * 之后用同一个 id 重新建项目（比如"载入示例项目"）会撞 UNIQUE。 */
    db.transaction(() => {
      db.prepare('DELETE FROM kv WHERE project_id = ?').run(pid);
      db.prepare('DELETE FROM project WHERE id = ?').run(pid);
    })();
    return true;
  }

  /* ---------------- 读：整项目 ---------------- */

  /* 示例项目自愈：只对 is_demo 且资料卡为 0 的项目补一次，避免老库里示例变成空壳。
     seed 由调用方（db.js）传进来，仓储层不自己去找示例数据。 */
  function healDemoAssets(pid, seed) {
    try {
      const row = db.prepare('SELECT is_demo FROM project WHERE id = ?').get(pid);
      if (!row || !row.is_demo) return false;
      const n = db.prepare('SELECT COUNT(*) AS c FROM entity WHERE project_id = ?').get(pid).c;
      if (n > 0) return false;
      if (!seed || !seed.entities) return false;
      insertAssets(pid, seed, now());
      return true;
    } catch (e) {
      return false;
    }
  }

  function loadProject(pid) {
    const pr = db.prepare('SELECT * FROM project WHERE id = ?').get(pid);
    if (!pr) return null;

    const chapters = {};
    db.prepare('SELECT * FROM chapter WHERE project_id = ? ORDER BY idx').all(pid).forEach((c) => {
      const rev = c.current_rev || 1;
      chapters[c.id] = {
        idx: c.idx,
        title: c.title,
        status: c.status,
        card: parseJson(c.card_json, {}),
        rev: rev,
        summary: c.summary || '',
        summaryRev: c.summary_rev || null,
        blocks: blocksAtRev(c.id, rev)
      };
    });

    const entities = db.prepare('SELECT * FROM entity WHERE project_id = ? ORDER BY ord, name').all(pid)
      .map((e) => {
        const raw = parseJson(e.arc_json, null);
        const out = {
          id: e.id, kind: e.kind, name: e.name, role: e.role || '', desire: e.desire || '',
          wound: e.wound || '', voice: e.voice || '', secret: e.secret || '', note: e.note || ''
        };
        /* 三种历史写法都读得出来：数组=多条线，{arcs:[...]}=多条线，对象=旧的单条 */
        if (Array.isArray(raw)) out.arcs = raw;
        else if (raw && Array.isArray(raw.arcs)) out.arcs = raw.arcs;
        else if (raw && (raw.from || raw.to || (raw.beats || []).length)) out.arc = raw;
        return out;
      });

    const worldRules = db.prepare('SELECT * FROM world_rule WHERE project_id = ? ORDER BY ord, name').all(pid)
      .map((w) => ({ id: w.id, kind: w.kind, name: w.name, text: w.text || '' }));

    const foreshadows = db.prepare('SELECT * FROM foreshadow WHERE project_id = ? ORDER BY ord, id').all(pid)
      .map((f) => ({
        id: f.id, title: f.title, plantedChapter: f.planted_chapter, plantedBlock: f.planted_block,
        quote: f.quote || '', due: f.due_chapter, status: f.status,
        related: parseJson(f.related_json, []), note: f.note || ''
      }));

    const gate = {};
    const proposedStates = [];
    db.prepare("SELECT * FROM entity_state WHERE project_id = ? AND kind = 'proposed' ORDER BY id").all(pid)
      .forEach((s) => {
        gate[s.id] = !!s.checked;
        proposedStates.push({
          id: s.id, entity: s.entity, field: s.field, from: s.from_value || '',
          to: s.to_value || '', chapter: s.chapter, block: s.block_id, quote: s.quote || '',
          conf: s.confidence || 0, checked: !!s.checked
        });
      });

    const confirmed = db.prepare("SELECT * FROM entity_state WHERE project_id = ? AND kind = 'confirmed' ORDER BY id")
      .all(pid).map((s) => ({
        id: s.id, entity: s.entity, field: s.field, value: s.to_value,
        chapter: s.chapter, block: s.block_id, quote: s.quote
      }));

    const waivers = db.prepare('SELECT * FROM waiver WHERE project_id = ?').all(pid)
      .map((w) => ({ ruleId: w.rule_id, key: w.key, blockId: w.block_id, expired: !!w.expired }));

    const kv = {};
    db.prepare('SELECT * FROM kv WHERE project_id = ?').all(pid).forEach((r) => { kv[r.k] = r.v; });

    return { project: projectRow(pr), chapters, entities, worldRules, foreshadows, waivers, gate, kv, confirmed, proposedStates };
  }

  /* ---------------- 写 ---------------- */

  function projectIdOf(chapterId) {
    const r = db.prepare('SELECT project_id FROM chapter WHERE id = ?').get(chapterId);
    return r ? r.project_id : null;
  }

  const upsertChapterTx = db.transaction((pid, chapter) => {
    const ts = now();
    db.prepare(`INSERT INTO chapter (id, project_id, idx, title, status, card_json, updated_at)
      VALUES (@id, @project_id, @idx, @title, @status, @card_json, @updated_at)
      ON CONFLICT(id) DO UPDATE SET idx = excluded.idx, title = excluded.title,
        status = excluded.status, card_json = excluded.card_json, updated_at = excluded.updated_at`)
      .run({
        id: chapter.id,
        project_id: pid,
        idx: chapter.idx,
        title: chapter.title,
        status: chapter.status,
        card_json: JSON.stringify(chapter.card || {}),
        updated_at: ts
      });
    db.prepare('UPDATE project SET updated_at = ? WHERE id = ?').run(ts, pid);
  });

  /* 当前生效的那一版正文 */
  function blocksAtRev(chapterId, rev) {
    const rows = db.prepare(`SELECT b.* FROM block_rev r JOIN block b ON b.id = r.block_id
      WHERE r.chapter_id = ? AND r.rev = ? ORDER BY r.ord`).all(chapterId, rev);
    if (rows.length) return rows.map(decodeBlock);
    /* 兜底：快照缺了就从活 block 里读（老库/异常中断） */
    return db.prepare(`SELECT * FROM block WHERE chapter_id = ? AND superseded_by IS NULL
      AND deleted_at IS NULL ORDER BY ord`).all(chapterId).map(decodeBlock);
  }

  function currentRev(chapterId) {
    const r = db.prepare('SELECT current_rev FROM chapter WHERE id = ?').get(chapterId);
    return r ? (r.current_rev || 1) : 1;
  }

  /**
   * 把"编辑器里的下一版"提交成一个新版本。
   * 改字 -> 新 block + 老 block 写 superseded_by；删段 -> deleted_at；插入 -> 新 block。
   * 同时写一条 block_rev 快照与若干 patch（before/after 留着做 diff 与回滚）。
   */
  const commitChapterTx = db.transaction((pid, chapterId, nextBlocks, opts) => {
    const ts = now();
    const rev = currentRev(chapterId);
    const cur = blocksAtRev(chapterId, rev);
    const plan = SFBlocks.planCommit(cur, nextBlocks || []);
    if (!plan.changed) return { rev, blocks: cur, changed: false, renames: {} };

    const nextRev = rev + 1;
    const insBlk = db.prepare(`INSERT INTO block
      (id, chapter_id, project_id, ord, text, src, meta_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insPatch = db.prepare(`INSERT INTO patch
      (id, project_id, chapter_id, base_rev, applied_rev, target_block, op, before_text,
       after_text, rationale, source, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?)`);
    const rationale = (opts && opts.rationale) || '';
    const source = (opts && opts.source) || 'human';

    plan.replace.forEach((r) => {
      /* 改字只换文本：原来的 meta（抽取出来的 actors/place/moveTo）跟着搬过去，
       * 否则用户改一个错别字就会把这一段的场景标记抹掉，规则静默失灵。 */
      const oldRow = db.prepare('SELECT meta_json FROM block WHERE id = ?').get(r.oldId);
      insBlk.run(r.newId, chapterId, pid, r.ord, r.text, r.src || 'human',
        (oldRow && oldRow.meta_json) || '{}', ts, ts);
      db.prepare('UPDATE block SET superseded_by = ?, updated_at = ? WHERE id = ?')
        .run(r.newId, ts, r.oldId);
      insPatch.run(SFBlocks.uid('pa'), pid, chapterId, rev, nextRev, r.oldId, 'replace',
        '', r.text, rationale, source, ts);
    });
    plan.insert.forEach((r) => {
      insBlk.run(r.id, chapterId, pid, r.ord, r.text, r.src || 'human', '{}', ts, ts);
      insPatch.run(SFBlocks.uid('pa'), pid, chapterId, rev, nextRev, null, 'insert',
        '', r.text, rationale, source, ts);
    });
    plan.delete.forEach((id) => {
      const row = db.prepare('SELECT text FROM block WHERE id = ?').get(id);
      db.prepare('UPDATE block SET deleted_at = ?, updated_at = ? WHERE id = ?').run(ts, ts, id);
      insPatch.run(SFBlocks.uid('pa'), pid, chapterId, rev, nextRev, id, 'delete',
        row ? row.text : '', '', rationale, source, ts);
    });

    const insRev = db.prepare('INSERT OR REPLACE INTO block_rev (chapter_id, rev, block_id, ord) VALUES (?, ?, ?, ?)');
    plan.blocks.forEach((b) => insRev.run(chapterId, nextRev, b.id, b.ord));
    db.prepare('UPDATE chapter SET current_rev = ?, updated_at = ? WHERE id = ?').run(nextRev, ts, chapterId);
    db.prepare('UPDATE project SET updated_at = ? WHERE id = ?').run(ts, pid);

    return {
      rev: nextRev,
      /* 从快照读回来，这样带的是 decodeBlock 之后的完整 block（含 meta） */
      blocks: blocksAtRev(chapterId, nextRev),
      changed: true,
      renames: plan.renames
    };
  });

  function commitChapter(pid, chapterId, nextBlocks, opts) {
    const owner = pid || projectIdOf(chapterId);
    if (!owner) throw new Error('commitChapter: unknown project for ' + chapterId);
    return commitChapterTx(owner, chapterId, nextBlocks, opts || {});
  }

  /** 回滚 = 把 current_rev 指回旧快照，不删任何 block */
  function rollbackChapter(pid, chapterId, rev) {
    const exists = db.prepare('SELECT 1 AS n FROM block_rev WHERE chapter_id = ? AND rev = ? LIMIT 1')
      .get(chapterId, rev);
    if (!exists) throw new Error('没有第 ' + rev + ' 版的快照');
    db.prepare('UPDATE chapter SET current_rev = ?, updated_at = ? WHERE id = ?').run(rev, now(), chapterId);
    return { rev: rev, blocks: blocksAtRev(chapterId, rev) };
  }

  function listRevisions(chapterId) {
    return db.prepare(`SELECT r.rev, COUNT(*) AS blocks, SUM(LENGTH(b.text)) AS words,
        MAX(b.created_at) AS at
      FROM block_rev r JOIN block b ON b.id = r.block_id
      WHERE r.chapter_id = ? GROUP BY r.rev ORDER BY r.rev DESC`).all(chapterId)
      .map((x) => ({ rev: x.rev, blocks: x.blocks, words: x.words || 0, at: x.at }));
  }

  function listPatches(chapterId, limit) {
    return db.prepare(`SELECT * FROM patch WHERE chapter_id = ? ORDER BY created_at DESC LIMIT ?`)
      .all(chapterId, limit || 50).map((x) => ({
        id: x.id, baseRev: x.base_rev, appliedRev: x.applied_rev, targetBlock: x.target_block,
        op: x.op, before: x.before_text || '', after: x.after_text || '',
        rationale: x.rationale || '', source: x.source || '', status: x.status, at: x.created_at
      }));
  }

  /** 一段话的血缘：从最初那版到最新那版 */
  function blockLineage(blockId) {
    let id = blockId;
    for (let i = 0; i < 200; i++) {
      const prev = db.prepare('SELECT id FROM block WHERE superseded_by = ?').get(id);
      if (!prev) break;
      id = prev.id;
    }
    const chain = [];
    for (let i = 0; i < 200; i++) {
      const row = db.prepare('SELECT * FROM block WHERE id = ?').get(id);
      if (!row) break;
      chain.push({
        id: row.id, text: row.text, src: row.src, at: row.created_at || row.updated_at,
        deleted: !!row.deleted_at, current: !row.superseded_by && !row.deleted_at
      });
      if (!row.superseded_by) break;
      id = row.superseded_by;
    }
    return chain;
  }

  function saveSummary(pid, chapterId, text) {
    db.prepare('UPDATE chapter SET summary = ?, summary_rev = current_rev, updated_at = ? WHERE id = ?')
      .run(text || '', now(), chapterId);
    return true;
  }

  function saveChapter(pid, chapter) {
    if (!chapter || !chapter.id) throw new Error('saveChapter: missing chapter.id');
    const owner = pid || projectIdOf(chapter.id);
    if (!owner) throw new Error('saveChapter: unknown project for ' + chapter.id);
    upsertChapterTx(owner, {
      id: chapter.id, idx: chapter.idx, title: chapter.title,
      status: chapter.status, card: chapter.card || {}
    });
    /* 兼容老调用：带了 blocks 就走版本化提交，不再"删旧插新" */
    if (Array.isArray(chapter.blocks)) {
      const out = commitChapterTx(owner, chapter.id, chapter.blocks, {
        rationale: (chapter.patch && chapter.patch.rationale) || '',
        source: (chapter.patch && chapter.patch.source) || 'human'
      });
      return out;
    }
    return { rev: currentRev(chapter.id) };
  }

  function deleteChapter(chapterId) {
    db.prepare('DELETE FROM chapter WHERE id = ?').run(chapterId);
    return true;
  }

  /* 弧线：支持多条线（arcs）。没有线就写 null，别写 "{}" —— 读回来会被当成"有弧线" */
  function arcJsonOf(e) {
    const arcs = (e.arcs || []).filter((a) => a && (a.from || a.to || (a.beats || []).length || (a.forbidden || []).length));
    if (arcs.length) return JSON.stringify({ arcs });
    if (e.arc && (e.arc.from || e.arc.to || (e.arc.beats || []).length)) return JSON.stringify({ arcs: [e.arc] });
    return null;
  }

  const saveEntitiesTx = db.transaction((pid, list) => {
    db.prepare('DELETE FROM entity WHERE project_id = ?').run(pid);
    const ts = now();
    const ins = db.prepare(`INSERT INTO entity
      (id, project_id, kind, name, role, desire, wound, voice, secret, note, arc_json, ord, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    (list || []).forEach((e, i) => {
      ins.run(e.id, pid, e.kind || '配角', e.name || '未命名', e.role || '', e.desire || '',
        e.wound || '', e.voice || '', e.secret || '', e.note || '',
        arcJsonOf(e), i, ts);
    });
    db.prepare('UPDATE project SET updated_at = ? WHERE id = ?').run(ts, pid);
  });

  function saveEntities(pid, list) { saveEntitiesTx(pid, list || []); return true; }

  const saveWorldRulesTx = db.transaction((pid, list) => {
    db.prepare('DELETE FROM world_rule WHERE project_id = ?').run(pid);
    const ts = now();
    const ins = db.prepare(`INSERT INTO world_rule (id, project_id, kind, name, text, ord, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    (list || []).forEach((w, i) => {
      ins.run(w.id, pid, w.kind || '规则', w.name || '未命名', w.text || '', i, ts);
    });
    db.prepare('UPDATE project SET updated_at = ? WHERE id = ?').run(ts, pid);
  });

  function saveWorldRules(pid, list) { saveWorldRulesTx(pid, list || []); return true; }

  const saveForeshadowsTx = db.transaction((pid, list) => {
    db.prepare('DELETE FROM foreshadow WHERE project_id = ?').run(pid);
    const ts = now();
    const ins = db.prepare(`INSERT INTO foreshadow
      (id, project_id, title, planted_chapter, planted_block, quote, due_chapter, status,
       related_json, note, ord, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    (list || []).forEach((f, i) => {
      ins.run(f.id, pid, f.title || '未命名', f.plantedChapter || null, f.plantedBlock || null,
        f.quote || '', f.due || null, f.status || 'planted',
        JSON.stringify(f.related || []), f.note || '', i, ts);
    });
    db.prepare('UPDATE project SET updated_at = ? WHERE id = ?').run(ts, pid);
  });

  function saveForeshadows(pid, list) { saveForeshadowsTx(pid, list || []); return true; }

  const saveWaiversTx = db.transaction((pid, list) => {
    db.prepare('DELETE FROM waiver WHERE project_id = ?').run(pid);
    const ins = db.prepare(`INSERT INTO waiver (id, project_id, rule_id, key, block_id, expired, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    (list || []).forEach((w, i) => {
      ins.run(['w', pid, w.ruleId, w.key || w.blockId || i, i].join(':'),
        pid, w.ruleId, w.key || null, w.blockId || null, w.expired ? 1 : 0, now());
    });
  });

  function saveWaivers(pid, list) { saveWaiversTx(pid, list || []); return true; }

  const saveGateTx = db.transaction((pid, map) => {
    const upd = db.prepare('UPDATE entity_state SET checked = ?, updated_at = ? WHERE id = ? AND project_id = ?');
    Object.keys(map || {}).forEach((id) => { upd.run(map[id] ? 1 : 0, now(), id, pid); });
  });

  function saveGate(pid, map) { saveGateTx(pid, map || {}); return true; }

  /* 抽取出来的候选状态整批替换（只动 kind='proposed'，已确认的不碰） */
  const saveStatesTx = db.transaction((pid, list) => {
    const ts = now();
    db.prepare("DELETE FROM entity_state WHERE project_id = ? AND kind = 'proposed'").run(pid);
    const ins = db.prepare(`INSERT OR REPLACE INTO entity_state
      (id, project_id, entity, field, from_value, to_value, chapter, block_id, quote, confidence,
       checked, kind, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?)`);
    (list || []).forEach((s) => {
      ins.run(s.id, pid, s.entity, s.field, s.from || '', s.to || '', s.chapter || null,
        s.block || null, s.quote || '', s.conf == null ? 0.6 : s.conf, s.checked ? 1 : 0, ts);
    });
  });

  function saveStates(pid, list) { saveStatesTx(pid, list || []); return true; }

  function setKv(pid, k, v) {
    db.prepare(`INSERT INTO kv (project_id, k, v) VALUES (?, ?, ?)
      ON CONFLICT(project_id, k) DO UPDATE SET v = excluded.v`)
      .run(pid, k, v == null ? null : String(v));
    return true;
  }

  function resetAll() {
    db.transaction(() => {
      ['waiver', 'block', 'chapter', 'entity_state', 'foreshadow', 'entity', 'world_rule', 'kv', 'project']
        .forEach((t) => db.prepare('DELETE FROM ' + t).run());
      db.prepare('DELETE FROM meta WHERE k = ?').run(META_SEEDED);
    })();
    return true;
  }

  function stats() {
    const q = (sql) => (db.prepare(sql).get() || {}).n || 0;
    return {
      backend: 'sqlite',
      file: dbPath || ':memory:',
      projects: q('SELECT COUNT(*) AS n FROM project'),
      chapters: q('SELECT COUNT(*) AS n FROM chapter'),
      blocks: q('SELECT COUNT(*) AS n FROM block'),
      entities: q('SELECT COUNT(*) AS n FROM entity'),
      worldRules: q('SELECT COUNT(*) AS n FROM world_rule'),
      foreshadows: q('SELECT COUNT(*) AS n FROM foreshadow'),
      waivers: q('SELECT COUNT(*) AS n FROM waiver'),
      states: q('SELECT COUNT(*) AS n FROM entity_state'),
      seededAt: (db.prepare('SELECT v FROM meta WHERE k = ?').get(META_SEEDED) || {}).v || null
    };
  }

  /* ---------------- 书库（v5） ----------------
     刻意没有 project_id：书架和项目是平行的两套收藏。
     正文在磁盘（packages/library/sections.js），这里只存索引、目录、进度、标记。 */

  const BOOK_COLUMNS = [
    'id', 'title', 'author', 'cover', 'format', 'render', 'encoding',
    'src_path', 'src_name', 'src_size', 'src_hash', 'src_url', 'source_id',
    'section_count', 'char_count', 'toc_source', 'note', 'prefs_json',
    'progress_ord', 'progress_blk', 'last_read_at', 'added_at', 'updated_at'
  ];

  function bookToObj(r) {
    if (!r) return null;
    let prefs = {};
    try { prefs = JSON.parse(r.prefs_json || '{}') || {}; } catch (e) { prefs = {}; }
    return {
      id: r.id,
      title: r.title,
      author: r.author || '',
      cover: r.cover || '',
      format: r.format,
      render: r.render,
      encoding: r.encoding || '',
      srcPath: r.src_path || '',
      srcName: r.src_name || '',
      srcSize: r.src_size || 0,
      srcHash: r.src_hash || '',
      srcUrl: r.src_url || '',
      sourceId: r.source_id || '',
      sectionCount: r.section_count || 0,
      chars: r.char_count || 0,
      tocSource: r.toc_source || null,
      note: r.note || '',
      prefs,
      progressOrd: r.progress_ord || 0,
      progressBlk: r.progress_blk || 0,
      lastReadAt: r.last_read_at || null,
      addedAt: r.added_at,
      updatedAt: r.updated_at
    };
  }

  function listBooks() {
    return db.prepare('SELECT * FROM book ORDER BY COALESCE(last_read_at, added_at) DESC').all().map(bookToObj);
  }

  function getBook(id) {
    return bookToObj(db.prepare('SELECT * FROM book WHERE id = ?').get(id));
  }

  function upsertBook(b) {
    const ts = now();
    const row = {
      id: b.id,
      title: b.title || '未命名',
      author: b.author || null,
      cover: b.cover || null,
      format: b.format || 'txt',
      render: b.render || 'text',
      encoding: b.encoding || null,
      src_path: b.srcPath || null,
      src_name: b.srcName || null,
      src_size: b.srcSize == null ? null : b.srcSize,
      src_hash: b.srcHash || null,
      src_url: b.srcUrl || null,
      source_id: b.sourceId || null,
      section_count: b.sectionCount || 0,
      char_count: b.chars || 0,
      toc_source: b.tocSource || null,
      note: b.note || null,
      prefs_json: JSON.stringify(b.prefs || {}),
      progress_ord: b.progressOrd || 0,
      progress_blk: b.progressBlk || 0,
      last_read_at: b.lastReadAt || null,
      added_at: b.addedAt || ts,
      updated_at: ts
    };
    const update = BOOK_COLUMNS
      .filter((c) => c !== 'id' && c !== 'added_at')
      .map((c) => c + ' = excluded.' + c)
      .join(', ');
    db.prepare(
      'INSERT INTO book (' + BOOK_COLUMNS.join(', ') + ') VALUES (' +
      BOOK_COLUMNS.map((c) => '@' + c).join(', ') + ') ' +
      'ON CONFLICT(id) DO UPDATE SET ' + update
    ).run(row);
    return getBook(b.id);
  }

  function removeBook(id) {
    return db.prepare('DELETE FROM book WHERE id = ?').run(id).changes > 0;
  }

  function saveProgress(id, ord, blk) {
    db.prepare('UPDATE book SET progress_ord = ?, progress_blk = ?, last_read_at = ?, updated_at = ? WHERE id = ?')
      .run(Number(ord) || 0, Number(blk) || 0, now(), now(), id);
    return true;
  }

  /** 目录整体替换：重新导入一本同名书时不会留下旧目录 */
  function setToc(bookId, items) {
    const del = db.prepare('DELETE FROM book_toc WHERE book_id = ?');
    const ins = db.prepare('INSERT INTO book_toc (book_id, ord, title, anchor, page, url) VALUES (?, ?, ?, ?, ?, ?)');
    db.transaction(() => {
      del.run(bookId);
      (items || []).forEach((t, i) => {
        ins.run(bookId, i, t.title || ('第 ' + (i + 1) + ' 节'), t.anchor || null,
          t.page == null ? null : Number(t.page), t.url || null);
      });
    })();
    return true;
  }

  function listToc(bookId) {
    return db.prepare('SELECT ord, title, anchor, page, url FROM book_toc WHERE book_id = ? ORDER BY ord')
      .all(bookId)
      .map((r) => ({ ord: r.ord, title: r.title, anchor: r.anchor || '', page: r.page, url: r.url || '' }));
  }

  function searchBooks(q) {
    const k = '%' + String(q || '').trim() + '%';
    return db.prepare('SELECT id, title, author, format, render, section_count, char_count, progress_ord, progress_blk, last_read_at ' +
      'FROM book WHERE title LIKE ? OR author LIKE ? ORDER BY COALESCE(last_read_at, added_at) DESC LIMIT 50')
      .all(k, k).map(bookToObj);
  }

  function saveMark(m) {
    const ts = now();
    db.prepare('INSERT OR REPLACE INTO book_mark (id, book_id, kind, section_ord, ord, quote, note, created_at) ' +
      'VALUES (@id, @book_id, @kind, @section_ord, @ord, @quote, @note, @created_at)').run({
      id: m.id || ('mk_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
      book_id: m.bookId,
      kind: m.kind || 'excerpt',
      section_ord: m.sectionOrd == null ? null : Number(m.sectionOrd),
      ord: m.ord == null ? null : Number(m.ord),
      quote: String(m.quote || '').slice(0, 4000),
      note: m.note || null,
      created_at: ts
    });
    return true;
  }

  function listMarks(bookId) {
    return db.prepare('SELECT * FROM book_mark WHERE book_id = ? ORDER BY created_at DESC').all(bookId)
      .map((r) => ({
        id: r.id, bookId: r.book_id, kind: r.kind,
        sectionOrd: r.section_ord, ord: r.ord, quote: r.quote, note: r.note, createdAt: r.created_at
      }));
  }

  function listSources() {
    return db.prepare('SELECT * FROM book_source ORDER BY rowid').all().map((r) => ({
      id: r.id, name: r.name, spec: parseJson(r.spec_json, {}), enabled: !!r.enabled, note: r.note || ''
    }));
  }

  function upsertSource(s) {
    db.prepare('INSERT INTO book_source (id, name, spec_json, enabled, note, created_at) VALUES (?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET name = excluded.name, spec_json = excluded.spec_json, ' +
      'enabled = excluded.enabled, note = excluded.note')
      .run(s.id, s.name, JSON.stringify(s.spec || {}), s.enabled === false ? 0 : 1, s.note || null, now());
    return true;
  }

  function removeSource(id) {
    return db.prepare('DELETE FROM book_source WHERE id = ?').run(id).changes > 0;
  }

  return {
    raw: db,
    file: dbPath,
    seedIfEmpty,
    isEmpty,
    listProjects,
    getProject,
    createProject,
    saveProjectMeta,
    deleteProject,
    loadProject,
    healDemoAssets,
    saveChapter,
    commitChapter,
    rollbackChapter,
    listRevisions,
    listPatches,
    blockLineage,
    saveSummary,
    deleteChapter,
    saveEntities,
    saveWorldRules,
    saveForeshadows,
    saveWaivers,
    saveGate,
    saveStates,
    setKv,
    resetAll,
    stats,
    /* 书库（v5） */
    listBooks,
    getBook,
    upsertBook,
    removeBook,
    saveProgress,
    setToc,
    listToc,
    searchBooks,
    saveMark,
    listMarks,
    listSources,
    upsertSource,
    removeSource,
    close: () => db.close()
  };
}

module.exports = { open, createRepo };
