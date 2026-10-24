'use strict';
/**
 * 主进程侧的数据库门面：
 *  - 决定数据库文件位置（userData/workspace/storyforge.db）
 *  - 第一次打开时用 apps/ui/data.js 的演示项目播种
 *  - 把渲染进程的 op 分派给仓储（packages/store/sqlite.js）
 *
 * better-sqlite3 是可选依赖：装不上时这里抛错，main.js 会降级为"无数据库"，
 * 渲染进程看到 sfBridge.db 不存在，自动退回 localStorage 快照。
 */

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const paths = require('./paths.js');

const UI_DIR = path.join(__dirname, '..', 'ui');

let repo = null;
let initError = null;

/* ---------------- 备份 ---------------- */

const KEEP_BACKUPS = 20;

/* 备份放哪儿由 paths.js 说了算（用户可以在设置里改） */
function backupsDir() {
  return paths.backupRoot();
}

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
    p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

/**
 * 把当前库复制一份到 backups/。
 * 这是「数据丢了还能捞」的最后一道闸：启动时、删项目前、清空数据前都会调。
 */
function backup(reason) {
  try {
    const src = dbFile();
    if (!fs.existsSync(src)) return null;
    const size = fs.statSync(src).size;
    if (size < 8192) return null; /* 空库不值得备份 */
    const dir = backupsDir();
    fs.mkdirSync(dir, { recursive: true });
    const name = 'storyforge-' + stamp(new Date()) + (reason ? '-' + reason : '') + '.db';
    const dest = path.join(dir, name);
    fs.copyFileSync(src, dest);
    listBackupFiles()
      .slice(KEEP_BACKUPS)
      .forEach((f) => { try { fs.unlinkSync(f.path); } catch (e) { /* 忽略 */ } });
    return dest;
  } catch (e) {
    console.warn('[db] 备份失败：', e.message);
    return null;
  }
}

function listBackupFiles() {
  const dir = backupsDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((n) => /\.db$/i.test(n))
    .map((n) => {
      const full = path.join(dir, n);
      const st = fs.statSync(full);
      return { name: n, path: full, size: st.size, at: st.mtimeMs };
    })
    .sort((a, b) => b.at - a.at);
}

function backupInfo() {
  const files = listBackupFiles();
  return {
    dir: backupsDir(),
    count: files.length,
    latest: files[0] || null,
    files: files.slice(0, 8).map((f) => ({ name: f.name, size: f.size, at: f.at })),
  };
}

/** 用 Node 执行 data.js（它写 window.SF_DATA），拿到播种数据。
 *  先跑 content.js，否则 demoPayload() 里的 applyContent() 找不到 window.SF_CONTENT，
 *  示例项目就会是「10 张章节卡 + 0 段正文」。 */
function loadSeed() {
  const g = global.window || (global.window = {});
  const content = path.join(UI_DIR, 'content.js');
  try {
    delete require.cache[require.resolve(content)];
    require(content);
  } catch (e) {
    console.warn('[seed] content.js 没加载成功，示例项目将只有章节卡：' + e.message);
  }
  const file = path.join(UI_DIR, 'data.js');
  delete require.cache[require.resolve(file)];
  require(file);
  if (!g.SF_DATA || typeof g.SF_DATA.demoPayload !== 'function') {
    throw new Error('data.js 没有产出 window.SF_DATA.demoPayload()');
  }
  return g.SF_DATA.demoPayload();
}

function dbFile() {
  return paths.dbFile();
}

function getDb() {
  if (repo) return repo;
  if (initError) throw initError;
  try {
    const { open } = require('../../packages/store/sqlite');
    repo = open(dbFile());
    repo.seedIfEmpty(loadSeed());
    return repo;
  } catch (e) {
    initError = e;
    throw e;
  }
}

/** 启动时尝试一次；失败不致命，UI 会退回 localStorage */
function tryInit() {
  try {
    backup('start'); /* 先留一份昨天的样子，再开库 */
    getDb();
    return true;
  } catch (e) {
    console.warn('[db] SQLite 不可用，退回 localStorage：', e.message);
    return false;
  }
}

/* ---------------- 全局元信息（当前打开的项目等） ---------------- */

function metaGet(k) {
  const r = getDb().raw.prepare('SELECT v FROM meta WHERE k = ?').get(k);
  return r ? r.v : null;
}

function metaSet(k, v) {
  getDb().raw.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
    .run(k, v == null ? null : String(v));
  return true;
}

/* ---------------- op 分发 ---------------- */

function dispatch(op, payload) {
  const r = getDb();
  const p = payload || {};
  switch (op) {
    case 'init': {
      const projects = r.listProjects();
      let active = metaGet('active_project');
      if (!active || !projects.some((x) => x.id === active)) {
        active = projects[0] ? projects[0].id : null;
        if (active) metaSet('active_project', active);
      }
      return { projects, activeProjectId: active, file: r.file };
    }
    case 'list-projects':
      return r.listProjects();
    case 'load-project': {
      if (p.pid) { const pr = r.getProject(p.pid); if (pr && pr.isDemo) r.healDemoAssets(p.pid, loadSeed()); }
      const data = r.loadProject(p.pid);
      if (data) metaSet('active_project', p.pid);
      return data;
    }
    case 'create-project':
      return r.createProject(p);
    case 'delete-project': {
      const saved = backup('before-delete');
      r.deleteProject(p.pid);
      const left = r.listProjects();
      if (!left.length) return { ok: true, activeProjectId: null, backup: saved };
      return { ok: true, activeProjectId: left[0].id, backup: saved };
    }
    case 'backup': {
      const saved = backup(p.reason || 'manual');
      return { ok: !!saved, file: saved, info: backupInfo() };
    }
    case 'backups':
      return backupInfo();
    case 'save-project':
      return r.saveProjectMeta(p.pid, p.meta);
    case 'save-chapter':
      return r.saveChapter(p.pid, p.chapter);
    case 'commit-chapter':
      return r.commitChapter(p.pid, p.chapterId, p.blocks, p.opts || {});
    case 'rollback-chapter':
      return r.rollbackChapter(p.pid, p.chapterId, p.rev);
    case 'list-revisions':
      return r.listRevisions(p.chapterId);
    case 'list-patches':
      return r.listPatches(p.chapterId, p.limit);
    case 'block-lineage':
      return r.blockLineage(p.blockId);
    case 'save-summary':
      return r.saveSummary(p.pid, p.chapterId, p.text != null ? p.text : p.summary);
    case 'save-entities':
      return r.saveEntities(p.pid, p.list);
    case 'save-world-rules':
      return r.saveWorldRules(p.pid, p.list);
    case 'save-foreshadows':
      return r.saveForeshadows(p.pid, p.list);
    case 'save-waivers':
      return r.saveWaivers(p.pid, p.list);
    case 'save-gate':
      return r.saveGate(p.pid, p.map);
    case 'save-states':
      return r.saveStates(p.pid, p.list);
    case 'set-kv':
      return r.setKv(p.pid, p.k, p.v);
    case 'reset': {
      backup('before-clear');
      r.resetAll();
      r.seedIfEmpty(loadSeed());
      return { ok: true };
    }
    case 'stats':
      return r.stats();
    default:
      throw new Error('未知的数据库操作：' + op);
  }
}

module.exports = {
  getDb,
  tryInit,
  loadSeed,
  dbFile,
  metaGet,
  metaSet,
  backup,
  backupInfo,
  backupsDir,
  dispatch
};
