/* StoryForge v0.1.0 — 持久化适配层（多项目）
 *
 * 两个后端，同一套接口：
 *   sqlite —— Electron 下经 preload 桥（window.sfBridge.db.invoke）打到 better-sqlite3，
 *             表结构见 packages/store/schema.sql；
 *   local  —— 浏览器直开 file:// 时退化到 localStorage 快照，
 *             保证"刷新不丢数据"，日后把快照灌进 SQLite 不需要改 UI。
 *
 * 两端返回的项目数据形状完全一致（UI 只认这一种）：
 *   { project:{id,name,genre,logline,sellPoint,desire,conflict,targetWords,chapterCount,isDemo,style},
 *     chapters:[{id,idx,title,status,card,blocks:[{id,text,src,...meta}]}],
 *     entities:[...], worldRules:[...], foreshadows:[...],
 *     proposedStates:[...], confirmedStates:[...], waivers:[...], kv:{} }
 */
window.SFStore = (function () {
  'use strict';

  var SNAP_KEY = 'sf.projects.v2';
  var bridge = (window.sfBridge && window.sfBridge.db) || null;
  var libBridge = (window.sfBridge && window.sfBridge.library) || null;
  var backend = bridge ? 'sqlite' : 'local';

  var status = { state: 'idle', at: null, error: null };
  var onStatus = null;

  /* block 版本化的纯逻辑（packages/blocks/versioning.js，浏览器里挂 window.SFBlocks） */
  var SFB = window.SFBlocks || null;

  function report(state, extra) {
    status.state = state;
    status.at = state === 'saved' ? new Date().toISOString() : status.at;
    status.error = extra && extra.error ? String(extra.error.message || extra.error) : null;
    if (typeof onStatus === 'function') onStatus(status);
  }

  function uid(prefix) {
    return (prefix || 'id') + '_' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
  }

  /* ---------------- 后端：localStorage ---------------- */

  var localTimer = null;

  function localRead() {
    try {
      var raw = localStorage.getItem(SNAP_KEY);
      var o = raw ? JSON.parse(raw) : null;
      if (!o || typeof o !== 'object' || !o.projects) return { v: 2, activeProjectId: null, projects: {} };
      return o;
    } catch (e) {
      return { v: 2, activeProjectId: null, projects: {}, corrupt: true };
    }
  }

  function localWrite(o) {
    report('saving');
    try {
      o.v = 2;
      o.savedAt = new Date().toISOString();
      localStorage.setItem(SNAP_KEY, JSON.stringify(o));
      report('saved');
      return true;
    } catch (e) {
      report('error', { error: e });
      return false;
    }
  }

  function blankSnap() { return { v: 2, activeProjectId: null, projects: {} }; }

  function ensureLocalDemo() {
    var o = localRead();
    if (Object.keys(o.projects).length) {
      if (!o.seeded) { o.seeded = true; localWrite(o); }
      return o;
    }
    /* 只在第一次运行时塞示例；用户自己把项目删光了就让它空着，交给欢迎页处理 */
    if (o.seeded) return o;
    var demo = window.SF_DATA.demoPayload();
    o.projects[demo.project.id] = demo;
    o.activeProjectId = demo.project.id;
    o.seeded = true;
    localWrite(o);
    return o;
  }

  function decorate(payload, meta) {
    // 字数和正文页脚用同一套口径（只数汉字/字母/数字，不算标点），否则书架和顶栏会差几千字
    var words = (payload.chapters || []).reduce(function (a, c) {
      return a + (c.blocks || []).reduce(function (x, b) {
        return x + (b.text || '').replace(/\s/g, '').length;
      }, 0);
    }, 0);
    return {
      id: payload.project.id,
      name: payload.project.name,
      genre: payload.project.genre,
      logline: payload.project.logline,
      targetWords: payload.project.targetWords,
      chapterCount: (payload.chapters || []).length,
      isDemo: !!payload.project.isDemo,
      words: words,
      updatedAt: (meta && meta.updatedAt) || payload.updatedAt || null
    };
  }

  var localAdapter = {
    init: function () {
      var o = ensureLocalDemo();
      return Promise.resolve({ projects: listOf(o), activeProjectId: o.activeProjectId });
    },
    listProjects: function () { return Promise.resolve(listOf(localRead())); },
    loadProject: function (pid) {
      var o = localRead();
      var p = o.projects[pid];
      if (!p) return Promise.resolve(null);
      if (o.activeProjectId !== pid) { o.activeProjectId = pid; localWrite(o); }
      return Promise.resolve(p);
    },
    createProject: function (payload) {
      var o = ensureLocalDemo();
      o.projects[payload.project.id] = payload;
      o.activeProjectId = payload.project.id;
      localWrite(o);
      return Promise.resolve(payload.project.id);
    },
    deleteProject: function (pid) {
      var o = localRead();
      /* 浏览器后端没有主进程备份，删之前把整份快照塞进回收站（最多留 5 份） */
      try {
        if (o.projects[pid]) {
          var trash = JSON.parse(localStorage.getItem('sf.trash.v1') || '[]');
          trash.unshift({ at: Date.now(), payload: o.projects[pid] });
          localStorage.setItem('sf.trash.v1', JSON.stringify(trash.slice(0, 5)));
        }
      } catch (e) { /* 配额满了就算了，不因为备份失败拦住删除 */ }
      delete o.projects[pid];
      if (o.activeProjectId === pid) {
        o.activeProjectId = Object.keys(o.projects)[0] || null;
      }
      localWrite(o);
      return Promise.resolve(true);
    },
    saveProjectMeta: function (pid, meta) {
      var o = localRead();
      if (o.projects[pid]) Object.assign(o.projects[pid].project, meta);
      return Promise.resolve(localWrite(o));
    },
    saveChapter: function (pid, chapter) {
      var o = localRead();
      var p = o.projects[pid];
      if (p) {
        p.history = p.history || {};
        var i = p.chapters.map(function (c) { return c.id; }).indexOf(chapter.id);
        var copy = JSON.parse(JSON.stringify(chapter));
        copy.rev = copy.rev || (i >= 0 && p.chapters[i].rev) || 1;
        /* 只存章节卡时不带 blocks —— 这种情况必须沿用库里已有的段落，
         * 否则"保存章节卡"会把整章正文清空（曾经真的踩过）。 */
        if (!Array.isArray(copy.blocks)) {
          copy.blocks = (i >= 0 && p.chapters[i].blocks) ? JSON.parse(JSON.stringify(p.chapters[i].blocks)) : [];
        }
        var hist = p.history[copy.id] = p.history[copy.id] || [];
        if (!hist.length) hist.push({ rev: 1, at: null, blocks: JSON.parse(JSON.stringify(copy.blocks)) });
        if (i >= 0) p.chapters[i] = copy;
        else p.chapters.push(copy);
        p.chapters.sort(function (a, b) { return a.idx - b.idx; });
        p.project.chapterCount = p.chapters.length;
      }
      return Promise.resolve(localWrite(o));
    },
    /* 浏览器端的版本化：用 localStorage 里的 history 数组模拟 block_rev 快照表 */
    commitChapter: function (pid, chapterId, blocks, opts) {
      var o = localRead();
      var p = o.projects[pid];
      if (!p) return Promise.resolve({ rev: 1, blocks: blocks || [], changed: false, renames: {} });
      var ch = (p.chapters || []).filter(function (c) { return c.id === chapterId; })[0];
      if (!ch) return Promise.resolve({ rev: 1, blocks: blocks || [], changed: false, renames: {} });
      var plan = SFB.planCommit(ch.blocks || [], blocks || []);
      if (!plan.changed) return Promise.resolve({ rev: ch.rev || 1, blocks: ch.blocks || [], changed: false, renames: {} });
      var rev = (ch.rev || 1) + 1;
      var oldBlocks = JSON.parse(JSON.stringify(ch.blocks || []));
      /* meta（actors/place/moveTo 这类抽取结果）要跟着段落走，
       * 否则改一个字就把这页的场景标记弄丢，规则静默失灵。 */
      var metaOf = {};
      (ch.blocks || []).forEach(function (b) { metaOf[b.id] = b; });
      ch.rev = rev;
      ch.blocks = plan.blocks.map(function (b) {
        var keep = metaOf[b.id];
        if (!keep) {
          Object.keys(plan.renames || {}).forEach(function (oldId) {
            if (plan.renames[oldId] === b.id) keep = metaOf[oldId];
          });
        }
        var out = Object.assign({}, keep || {});
        out.id = b.id;
        out.text = b.text;
        out.src = b.src || 'human';
        return out;
      });
      p.history = p.history || {};
      var hist = p.history[chapterId] = (p.history[chapterId] || []).filter(function (h) { return h.rev !== rev; });
      /* 头一次提交时补上"改之前"那一版，否则回滚不到第 1 版 */
      if (!hist.length) {
        hist.push({ rev: rev - 1, at: null, blocks: JSON.parse(JSON.stringify(oldBlocks)) });
      }
      hist.push({ rev: rev, at: new Date().toISOString(), blocks: JSON.parse(JSON.stringify(ch.blocks)) });
      hist.sort(function (a, b) { return a.rev - b.rev; });
      if (hist.length > 20) hist.splice(0, hist.length - 20);
      p.patches = p.patches || [];
      p.patches.unshift({
        id: uid('pa'), chapterId: chapterId, baseRev: rev - 1, appliedRev: rev,
        op: plan.replace.length ? 'replace' : (plan.insert.length ? 'insert' : 'delete'),
        before: '', after: (plan.replace[0] && plan.replace[0].text) || (plan.insert[0] && plan.insert[0].text) || '',
        rationale: (opts && opts.rationale) || '', source: (opts && opts.source) || 'human',
        at: new Date().toISOString()
      });
      if (p.patches.length > 200) p.patches.length = 200;
      return Promise.resolve(localWrite(o) && { rev: rev, blocks: ch.blocks, changed: true, renames: plan.renames });
    },
    rollbackChapter: function (pid, chapterId, rev) {
      var o = localRead();
      var p = o.projects[pid];
      if (!p) return Promise.resolve(null);
      var ch = (p.chapters || []).filter(function (c) { return c.id === chapterId; })[0];
      var hist = ((p.history || {})[chapterId] || []).filter(function (h) { return h.rev === rev; })[0];
      if (!ch || !hist) return Promise.resolve(null);
      ch.rev = rev;
      ch.blocks = JSON.parse(JSON.stringify(hist.blocks));
      return Promise.resolve(localWrite(o) && { rev: rev, blocks: ch.blocks });
    },
    listRevisions: function (pid, chapterId) {
      var p = localRead().projects[pid];
      var hist = ((p && p.history) || {})[chapterId] || [];
      return Promise.resolve(hist.slice().reverse().map(function (h) {
        var words = (h.blocks || []).reduce(function (n, b) { return n + (b.text || '').length; }, 0);
        return { rev: h.rev, blocks: (h.blocks || []).length, words: words, at: h.at };
      }));
    },
    listPatches: function (pid, chapterId) {
      var p = localRead().projects[pid];
      var list = ((p && p.patches) || []).filter(function (x) { return !chapterId || x.chapterId === chapterId; });
      return Promise.resolve(list.slice(0, 50));
    },
    blockLineage: function (pid, blockId) {
      var p = localRead().projects[pid];
      var out = [];
      Object.keys((p && p.history) || {}).forEach(function (cid) {
        (p.history[cid] || []).forEach(function (h) {
          (h.blocks || []).forEach(function (b) {
            if (b.id === blockId) out.push({ id: b.id, text: b.text, src: b.src, at: h.at, rev: h.rev, current: false });
          });
        });
      });
      return Promise.resolve(out.slice(-20));
    },
    saveSummary: function (pid, chapterId, text) {
      var o = localRead();
      var p = o.projects[pid];
      var ch = p && (p.chapters || []).filter(function (c) { return c.id === chapterId; })[0];
      if (ch) { ch.summary = text || ''; ch.summaryRev = ch.rev || 1; }
      return Promise.resolve(localWrite(o));
    },
    saveEntities: function (pid, list) {
      var o = localRead();
      if (o.projects[pid]) o.projects[pid].entities = JSON.parse(JSON.stringify(list));
      return Promise.resolve(localWrite(o));
    },
    saveWorldRules: function (pid, list) {
      var o = localRead();
      if (o.projects[pid]) o.projects[pid].worldRules = JSON.parse(JSON.stringify(list));
      return Promise.resolve(localWrite(o));
    },
    saveForeshadows: function (pid, list) {
      var o = localRead();
      if (o.projects[pid]) o.projects[pid].foreshadows = JSON.parse(JSON.stringify(list));
      return Promise.resolve(localWrite(o));
    },
    saveWaivers: function (pid, list) {
      var o = localRead();
      if (o.projects[pid]) o.projects[pid].waivers = JSON.parse(JSON.stringify(list));
      return Promise.resolve(localWrite(o));
    },
    saveGate: function (pid, map) {
      var o = localRead();
      var p = o.projects[pid];
      if (p) {
        (p.proposedStates || []).forEach(function (s) {
          if (map[s.id] != null) s.checked = !!map[s.id];
        });
      }
      return Promise.resolve(localWrite(o));
    },
    saveStates: function (pid, list) {
      var o = localRead();
      if (o.projects[pid]) o.projects[pid].proposedStates = JSON.parse(JSON.stringify(list || []));
      return Promise.resolve(localWrite(o));
    },
    setKv: function (pid, k, v) {
      var o = localRead();
      if (o.projects[pid]) {
        o.projects[pid].kv = o.projects[pid].kv || {};
        o.projects[pid].kv[k] = v;
        o.activeProjectId = pid;
      }
      return Promise.resolve(localWrite(o));
    },
    resetAll: function () {
      try { localStorage.removeItem(SNAP_KEY); } catch (e) { }
      var o = blankSnap();
      localWrite(o);
      return Promise.resolve(true);
    },
    stats: function () {
      var o = localRead();
      var chapters = 0, blocks = 0, entities = 0, fs = 0, words = 0;
      Object.keys(o.projects).forEach(function (pid) {
        var p = o.projects[pid];
        chapters += (p.chapters || []).length;
        entities += (p.entities || []).length;
        fs += (p.foreshadows || []).length;
        (p.chapters || []).forEach(function (c) {
          blocks += (c.blocks || []).length;
          (c.blocks || []).forEach(function (b) { words += (b.text || '').length; });
        });
      });
      var bytes = 0;
      try { bytes = (localStorage.getItem(SNAP_KEY) || '').length; } catch (e) { }
      return {
        backend: 'localStorage',
        file: 'localStorage://' + SNAP_KEY,
        projects: Object.keys(o.projects).length,
        chapters: chapters, blocks: blocks, entities: entities, foreshadows: fs,
        words: words, bytes: bytes,
        savedAt: o.savedAt || null
      };
    },
    backup: function (reason) {
      /* 浏览器后端没有主进程，删除时已经进了 sf.trash.v1；这里手工再存一份 */
      try {
        var o = localRead();
        var all = JSON.parse(localStorage.getItem('sf.trash.v1') || '[]');
        Object.keys(o.projects).forEach(function (pid) {
          all.unshift({ at: Date.now(), payload: o.projects[pid] });
        });
        localStorage.setItem('sf.trash.v1', JSON.stringify(all.slice(0, 5)));
        return Promise.resolve({ ok: true, reason: reason || 'manual' });
      } catch (e) { return Promise.resolve({ ok: false, error: e.message }); }
    },
    backups: function () {
      var list = [];
      try { list = JSON.parse(localStorage.getItem('sf.trash.v1') || '[]'); } catch (e) { }
      return Promise.resolve({
        dir: 'localStorage://sf.trash.v1',
        count: list.length,
        latest: list[0] ? { name: (list[0].payload.project || {}).name || '(未命名)', at: list[0].at } : null,
        files: list.slice(0, 8).map(function (x) {
          return { name: (x.payload.project || {}).name || '(未命名)', at: x.at };
        })
      });
    },
    openBackups: function () {
      return Promise.resolve({ ok: false, dir: 'localStorage://sf.trash.v1' });
    },
    /* 数据/备份位置：浏览器版没有真实目录，给一句明确说明，别让设置页显示空白 */
    pathsInfo: function () {
      return Promise.resolve({
        browser: true,
        dataRoot: '浏览器 localStorage（' + SNAP_KEY + '）',
        backupRoot: '浏览器 localStorage（sf.trash.v1）',
        note: '浏览器版没有文件目录；装桌面版才能改位置、搬家'
      });
    },
    pathsPick: function () { return Promise.resolve({ dir: '', note: '浏览器版不能选目录' }); },
    pathsOpen: function () { return Promise.resolve({ ok: false, note: '浏览器版不能打开目录' }); },
    moveData: function () { return Promise.resolve({ error: '浏览器版不支持搬家，装桌面版再用' }); },
    moveBackups: function () { return Promise.resolve({ error: '浏览器版不支持搬家，装桌面版再用' }); },
    resetPaths: function () { return Promise.resolve({ browser: true }); },
    /* 书库（阅读器）只在桌面版可用：浏览器直开拿不到 dialog / fs。
       UI 用 SFStore.canLibrary 判断要不要把入口藏起来。 */
    libInvoke: function () {
      return Promise.reject(new Error('书库需要桌面版 StoryForge（浏览器里没有文件系统权限）'));
    }
  };

  function listOf(o) {
    return Object.keys(o.projects).map(function (pid) {
      var p = o.projects[pid];
      return decorate(p, { updatedAt: p.updatedAt || o.savedAt });
    }).sort(function (a, b) {
      if (a.isDemo !== b.isDemo) return a.isDemo ? -1 : 1;
      return String(a.name).localeCompare(String(b.name), 'zh');
    });
  }

  /* ---------------- 后端：SQLite（Electron IPC） ---------------- */

  function call(op, payload) {
    return bridge.invoke(op, payload).then(function (r) { report('saved'); return r; });
  }

  var bridgeAdapter = {
    init: function () {
      return call('init', {}).then(function (r) {
        if (!r || !r.projects) throw new Error('bad init payload');
        return r;
      });
    },
    listProjects: function () { return call('list-projects', {}); },
    loadProject: function (pid) { return call('load-project', { pid: pid }); },
    createProject: function (payload) { return call('create-project', payload); },
    deleteProject: function (pid) { return call('delete-project', { pid: pid }); },
    backup: function (reason) { return call('backup', { reason: reason }); },
    backups: function () { return call('backups', {}); },
    openBackups: function () { return call('open-backups', {}); },
    pathsInfo: function () { return call('paths-info', {}); },
    pathsPick: function () { return call('paths-pick', {}); },
    pathsOpen: function (dir) { return call('paths-open', { dir: dir }); },
    moveData: function (dir) { return call('paths-move-data', { dir: dir }); },
    moveBackups: function (dir) { return call('paths-move-backups', { dir: dir }); },
    resetPaths: function () { return call('paths-reset', {}); },
    saveProjectMeta: function (pid, meta) { return call('save-project', { pid: pid, meta: meta }); },
    saveChapter: function (pid, chapter) { return call('save-chapter', { pid: pid, chapter: chapter }); },
    commitChapter: function (pid, chapterId, blocks, opts) {
      return call('commit-chapter', { pid: pid, chapterId: chapterId, blocks: blocks, opts: opts || {} });
    },
    rollbackChapter: function (pid, chapterId, rev) {
      return call('rollback-chapter', { pid: pid, chapterId: chapterId, rev: rev });
    },
    listRevisions: function (pid, chapterId) { return call('list-revisions', { pid: pid, chapterId: chapterId }); },
    listPatches: function (pid, chapterId) { return call('list-patches', { pid: pid, chapterId: chapterId }); },
    blockLineage: function (pid, blockId) { return call('block-lineage', { pid: pid, blockId: blockId }); },
    saveSummary: function (pid, chapterId, text) { return call('save-summary', { pid: pid, chapterId: chapterId, text: text }); },
    saveEntities: function (pid, list) { return call('save-entities', { pid: pid, list: list }); },
    saveWorldRules: function (pid, list) { return call('save-world-rules', { pid: pid, list: list }); },
    saveForeshadows: function (pid, list) { return call('save-foreshadows', { pid: pid, list: list }); },
    saveWaivers: function (pid, list) { return call('save-waivers', { pid: pid, list: list }); },
    saveGate: function (pid, map) { return call('save-gate', { pid: pid, map: map }); },
    saveStates: function (pid, list) { return call('save-states', { pid: pid, list: list }); },
    setKv: function (pid, k, v) { return call('set-kv', { pid: pid, k: k, v: v }); },
    resetAll: function () { return call('reset', {}); },
    stats: function () { return call('stats', {}); },
    /* 书库：走独立的 sf:library 通道，**不套 report()**——
       读一节正文不该把状态栏刷成"已保存"。 */
    libInvoke: function (op, payload) {
      if (!libBridge) return Promise.reject(new Error('书库通道没挂上'));
      return libBridge.invoke(op, payload);
    }
  };

  var adapter = bridge ? bridgeAdapter : localAdapter;

  /* ---------------- 对外 ---------------- */

  function guard(fn) {
    try {
      report('saving');
      var r = fn();
      if (r && typeof r.then === 'function') {
        return r.catch(function (e) { report('error', { error: e }); return false; });
      }
      return Promise.resolve(r);
    } catch (e) {
      report('error', { error: e });
      return Promise.resolve(false);
    }
  }

  return {
    backend: backend,
    isBridge: !!bridge,
    uid: uid,
    init: function () { return guard(function () { return adapter.init(); }); },
    listProjects: function () { return guard(function () { return adapter.listProjects(); }); },
    loadProject: function (pid) { return guard(function () { return adapter.loadProject(pid); }); },
    createProject: function (payload) { return guard(function () { return adapter.createProject(payload); }); },
    deleteProject: function (pid) { return guard(function () { return adapter.deleteProject(pid); }); },
    saveProjectMeta: function (pid, meta) { return guard(function () { return adapter.saveProjectMeta(pid, meta); }); },
    saveChapter: function (pid, chapter) { return guard(function () { return adapter.saveChapter(pid, chapter); }); },
    commitChapter: function (pid, chapterId, blocks, opts) {
      return guard(function () { return adapter.commitChapter(pid, chapterId, blocks, opts || {}); });
    },
    rollbackChapter: function (pid, chapterId, rev) {
      return guard(function () { return adapter.rollbackChapter(pid, chapterId, rev); });
    },
    listRevisions: function (pid, chapterId) { return guard(function () { return adapter.listRevisions(pid, chapterId); }); },
    listPatches: function (pid, chapterId) { return guard(function () { return adapter.listPatches(pid, chapterId); }); },
    blockLineage: function (pid, blockId) { return guard(function () { return adapter.blockLineage(pid, blockId); }); },
    saveSummary: function (pid, chapterId, text) { return guard(function () { return adapter.saveSummary(pid, chapterId, text); }); },
    saveEntities: function (pid, list) { return guard(function () { return adapter.saveEntities(pid, list); }); },
    saveWorldRules: function (pid, list) { return guard(function () { return adapter.saveWorldRules(pid, list); }); },
    saveForeshadows: function (pid, list) { return guard(function () { return adapter.saveForeshadows(pid, list); }); },
    saveWaivers: function (pid, list) { return guard(function () { return adapter.saveWaivers(pid, list); }); },
    saveGate: function (pid, map) { return guard(function () { return adapter.saveGate(pid, map); }); },
  saveStates: function (pid, list) { return guard(function () { return adapter.saveStates(pid, list); }); },
    setKv: function (pid, k, v) { return guard(function () { return adapter.setKv(pid, k, v); }); },
    resetAll: function () { return guard(function () { return adapter.resetAll(); }); },
    stats: function () { return guard(function () { return adapter.stats(); }); },
    backup: function (reason) { return guard(function () { return adapter.backup(reason); }); },
    backups: function () { return guard(function () { return adapter.backups(); }); },
    openBackups: function () { return guard(function () { return adapter.openBackups(); }); },
    pathsInfo: function () { return guard(function () { return adapter.pathsInfo(); }); },
    pathsPick: function () { return guard(function () { return adapter.pathsPick(); }); },
    pathsOpen: function (dir) { return guard(function () { return adapter.pathsOpen(dir); }); },
    moveData: function (dir) { return guard(function () { return adapter.moveData(dir); }); },
    moveBackups: function (dir) { return guard(function () { return adapter.moveBackups(dir); }); },
    resetPaths: function () { return guard(function () { return adapter.resetPaths(); }); },
    /* 书库（阅读器模式）：刻意不套 guard —— 导入失败的原因
       （文件太大 / 读不到 / 库没起来）要原样显示给用户，不能被压成 false。 */
    lib: function (op, payload) {
      try {
        return adapter.libInvoke(op, payload);
      } catch (e) {
        return Promise.reject(e);
      }
    },
    canLibrary: !!libBridge && backend === 'sqlite',
    onLibEvent: function (fn) {
      if (!libBridge || !libBridge.onEvent) return function () { };
      return libBridge.onEvent(fn);
    },
    status: function () { return status; },
    onStatus: function (fn) { onStatus = fn; },
    flush: function () { /* 两个后端都是即时写，无需 flush */ }
  };
})();
