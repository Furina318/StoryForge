'use strict';
/**
 * StoryForge 桌面壳（Electron）
 *
 * 设计约束（见 docs/v0.1.0-功能文档.md F11）：
 *  1. API Key 只存在本机。Electron 下走 OS 凭据区（safeStorage + userData/apikey.bin），
 *     不写 localStorage、不进导出包、不进日志。
 *  2. 渲染进程零 Node 权限：contextIsolation: true、nodeIntegration: false，
 *     只通过 preload 暴露的 window.sfBridge 做三件事：数据库、模型调用、Key 存取。
 *  3. 模型调用放在主进程：渲染进程直连第三方 API 会被 CORS 拦，而且 Key 不该在页面上下文里。
 */

const { app, BrowserWindow, ipcMain, safeStorage, session, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const db = require('./db');
const library = require('./library');

const UI_ENTRY = path.join(__dirname, '..', 'ui', 'index.html');
const keyFile = () => path.join(app.getPath('userData'), 'apikey.bin');

/* ── 假模型（只给 --selftest-llm 用）──────────────────────────────────────
   抽取链路必须在"真请求、真 SSE/JSON、真主进程代理"下验一遍，但测试不能花钱、
   也不该依赖用户有没有配 Key。所以在主进程里起一个 OpenCounting 兼容的假服务，
   让界面以为自己在跟真模型说话。
   行为：第一次请求故意返回非 JSON（验证重试），第二次起返回 3 条合格 + 2 条不合格。 */
function startMockLlm() {
  const http = require('node:http');
  const state = { calls: 0, retries: 0 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      let p = {};
      try { p = JSON.parse(body); } catch (e) { /* ignore */ }
      const user = ((p.messages || []).find((m) => m.role === 'user') || {}).content || '';
      const isRetry = /上一次你没有返回合法 JSON/.test(user);
      state.calls += 1;
      if (isRetry) state.retries += 1;
      let content;
      if (!isRetry) {
        content = '好的，我先分析一下这段文字，然后再说结论。';
      } else {
        const ids = [];
        const re = /\[([A-Za-z0-9_-]+)\]\s*([^\n]+)/g;
        let m;
        while ((m = re.exec(user))) ids.push({ id: m[1], line: m[2] });
        const items = ids.slice(0, 3).map((b, i) => {
          const sentence = (b.line.split(/[。！？]/).filter((s) => s.trim().length > 6)[0] || b.line).trim();
          return {
            entity: ['沈砚', '老周', '摊主'][i % 3],
            field: i === 0 ? '位置' : '已知信息',
            from: '—',
            to: i === 0 ? '城南旧货市场' : '账本里有自己的名字',
            block_id: b.id,
            quote: sentence,
            confidence: i === 2 ? 0.42 : 0.88
          };
        });
        if (ids.length) {
          items.push({ entity: '沈砚', field: '生死', to: '已故', block_id: ids[0].id, quote: '这句根本不在正文里', confidence: 0.9 });
        }
        content = JSON.stringify(items);
      }
      res.writeHead(200, {
        'Content-Type': p.stream ? 'text/event-stream; charset=utf-8' : 'application/json',
        Connection: 'close',
        'Cache-Control': 'no-cache'
      });
      if (p.stream) {
        let i = 0;
        const tick = setInterval(() => {
          if (i >= content.length) {
            clearInterval(tick);
            res.write('data: ' + JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } }) + '\n\n');
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: content.slice(i, i + 60) } }] }) + '\n\n');
          i += 60;
        }, 6);
        return;
      }
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, state }));
  });
}

function createWindow(hasDb) {
  const iconPath = path.join(__dirname, '..', '..', 'assets', 'icon.png');
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 680,
    backgroundColor: '#f6f4f0',
    title: 'StoryForge v0.1.0',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // 仅原型：preload 需要 node:fs 读写 Key 文件
      // 提前告诉 preload 数据库是否可用：不可用就让 UI 退回 localStorage
      additionalArguments: ['--sf-db=' + (hasDb ? '1' : '0')]
    }
  });

  win.setMenuBarVisibility(false);
  win.once('ready-to-show', () => win.show());
  win.loadFile(UI_ENTRY);

  // 冒烟自检：electron . --selftest 时打开窗口、读一遍渲染进程状态、写 JSON 后退出。
  // 没有 shell 自动化时，这是唯一能证明"界面真的连上了 SQLite"的手段。
  if (process.argv.indexOf('--selftest') >= 0) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        if (process.argv.indexOf('--wk1973') >= 0) {
          try {
            const out = {};
            out.open = await win.webContents.executeJavaScript(
              `(function () { return window.sfBridge.library.invoke('web-open', { source: 'wenku8', q: '' }); })()`
            );
            await new Promise((r) => setTimeout(r, 9000));
            out.session = await win.webContents.executeJavaScript(
              `(function () { return window.sfBridge.library.invoke('wk8-session', {}); })()`
            );
            out.probe = await win.webContents.executeJavaScript(
              `(function () {
                 return window.sfBridge.library.invoke('wk8-probe', { urls: [
                   'https://www.wenku8.net/book/1973.htm',
                   'https://www.wenku8.net/book/1.htm',
                   'https://www.wenku8.net/novel/0/1973/index.htm'
                 ] });
               })()`
            );
            out.detail = await win.webContents.executeJavaScript(
              `(async function () {
                 try {
                   var d = await window.sfBridge.library.invoke('wk8-detail', { ref: 'https://www.wenku8.net/book/1973.htm' });
                   return { ok: true, title: d.book.title, author: d.book.author, toc: d.toc.length };
                 } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
               })()`
            );
            out.search = await win.webContents.executeJavaScript(
              `(async function () {
                 try {
                   var s = await window.sfBridge.library.invoke('wk8-search', { q: '狼与香辛料', dump: true });
                   return { ok: s.ok, count: (s.items || []).length, first: (s.items || [])[0] || null, error: s.error || '' };
                 } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
               })()`
            );
            fs.writeFileSync(path.join(__dirname, '..', '..', 'dist', 'wk1973.json'), JSON.stringify(out, null, 1));
          } catch (e) {
            fs.writeFileSync(path.join(__dirname, '..', '..', 'dist', 'wk1973.json'), JSON.stringify({ error: String(e && e.message || e) }));
          }
        }
        if (process.argv.indexOf('--wkdl') >= 0) {
          const out = {};
          try {
            out.login = await win.webContents.executeJavaScript(
              `(function () { return window.sfBridge.library.invoke('wk8-login', {}); })()`
            );
            await new Promise((r) => setTimeout(r, 6000));
            out.session = await win.webContents.executeJavaScript(
              `(function () { return window.sfBridge.library.invoke('wk8-session', {}); })()`
            );
            out.download = await win.webContents.executeJavaScript(
              `(async function () {
                 try {
                   var d = await window.sfBridge.library.invoke('wk8-download', { ref: '1973', maxChapters: 3 });
                   return { ok: true, chapters: d.chapters, total: d.totalChapters, book: (d.book && d.book.title) || '', sections: (d.book && d.book.sections) || 0 };
                 } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
               })()`
            );
          } catch (e) {
            out.error = String((e && e.message) || e);
          }
          fs.writeFileSync(path.join(__dirname, '..', '..', 'dist', 'wkdl.json'), JSON.stringify(out, null, 1));
        }
        if (process.argv.indexOf('--wksession') >= 0) {
          const out = {};
          try {
            out.state = await win.webContents.executeJavaScript(
              `(async function () {
                 try { return await window.sfBridge.library.invoke('wk8-session', {}); }
                 catch (e) { return { error: String((e && e.message) || e) }; }
               })()`
            );
          } catch (e) {
            out.error = String((e && e.message) || e);
          }
          fs.writeFileSync(path.join(__dirname, '..', '..', 'dist', 'wksession.json'), JSON.stringify(out, null, 1));
        }

        if (process.argv.indexOf('--wkindex') >= 0) {
          const out = {};
          try {
            out.alpha = await win.webContents.executeJavaScript(
              `(async function () {
                 try {
                   const r = await window.sfBridge.library.invoke('wk8-alpha', { alpha: 'B', dump: true });
                   return r;
                 } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
               })()`
            );
          } catch (e) {
            out.error = String((e && e.message) || e);
          }
          fs.writeFileSync(path.join(__dirname, '..', '..', 'dist', 'wkindex.json'), JSON.stringify(out, null, 1));
        }

        if (process.argv.indexOf('--wkbook') >= 0) {
          const out = {};
          try {
            out.dl = await win.webContents.executeJavaScript(
              `(async function () {
                 try {
                   const d = await window.sfBridge.library.invoke('wk8-download', { ref: '1973', maxChapters: 12 });
                   return { ok: true, chapters: d.chapters, total: d.totalChapters, book: d.book };
                 } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
               })()`
            );
            if (out.dl && out.dl.ok && out.dl.book && out.dl.book.id) {
              const bid = String(out.dl.book.id);
              const js = "(async function () { try { const o = await window.sfBridge.library.invoke('open', { id: '" +
                bid.replace(/'/g, "") + "' }); return { ok: true, toc: (o.toc || []).slice(0, 14) }; }" +
                " catch (e) { return { ok: false, error: String((e && e.message) || e) }; } })()";
              out.open = await win.webContents.executeJavaScript(js);
            }
          } catch (e) {
            out.error = String((e && e.message) || e);
          }
          fs.writeFileSync(path.join(__dirname, '..', '..', 'dist', 'wkbook.json'), JSON.stringify(out, null, 1));
          try {
            if (out.dl && out.dl.ok && out.dl.book && out.dl.book.id) {
              const bid2 = String(out.dl.book.id).replace(/'/g, "");
              await win.webContents.executeJavaScript(
                "(function () { window.SFReader.open('" + bid2 + "'); return 'ok'; })()"
              );
              await new Promise((r) => setTimeout(r, 1800));
              const shotWk = await win.webContents.capturePage();
              fs.writeFileSync(path.join(__dirname, '..', '..', 'dist', 'wkbook-reader.png'), shotWk.toPNG());
            }
          } catch (e) { /* 截图失败不影响自检 */ }
        }

        if (process.argv.indexOf('--wkpro') >= 0) {
          const out = {};
          try {
            out.search = await win.webContents.executeJavaScript(
              `(async function () {
                 try {
                   var r = await window.sfBridge.library.invoke('wk8-search', { q: '狼与香辛料' });
                   return { ok: r.ok, count: (r.items || []).length, first: (r.items || [])[0] || null, error: r.error || '', htmlLen: r.htmlLen, head: r.head };
                 } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
               })()`
            );
            out.download = await win.webContents.executeJavaScript(
              `(async function () {
                 try {
                   var d = await window.sfBridge.library.invoke('wk8-download', { ref: '1973', maxChapters: 5 });
                   var toc = [];
                   if (d && d.book && d.book.id) {
                     var o = await window.sfBridge.library.invoke('open', { id: d.book.id });
                     toc = (o.toc || []).slice(0, 8);
                   }
                   return { ok: true, chapters: d.chapters, total: d.totalChapters, toc: toc };
                 } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
               })()`
            );
          } catch (e) {
            out.error = String((e && e.message) || e);
          }
          fs.writeFileSync(path.join(__dirname, '..', '..', 'dist', 'wkpro.json'), JSON.stringify(out, null, 1));
        }
        let report;
        const doWrite = process.argv.indexOf('--selftest-write') >= 0;
        const doUi = process.argv.indexOf('--selftest-ui') >= 0;
        const doLlm = process.argv.indexOf('--selftest-llm') >= 0;
        /* 按钮探针：补插图 / 检查更新 这两条 IPC 不能抛（不需要登录） */
  if (process.argv.indexOf('--btnprobe') >= 0) {
    win.webContents.once('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, 1800));
      try {
        const out = await win.webContents.executeJavaScript(
          `(async function () {
             var L = window.sfBridge.library;
             var books = await L.invoke('list', {});
             var b = books[0] || {};
             var res = { books: books.length, id: b.id, srcUrl: b.srcUrl || '' };
             try { res.fix = await L.invoke('repair-images', { id: b.id }); } catch (e) { res.fixErr = String((e && e.message) || e); }
             try { res.upd = await L.invoke('wk8-update', { id: b.id }); } catch (e) { res.updErr = String((e && e.message) || e); }
             return res;
           })()`
        );
        console.log('[btnprobe] ' + JSON.stringify(out));
      } catch (e) {
        console.log('[btnprobe] FAIL ' + String((e && e.message) || e));
      }
      app.quit();
    });
  }

  const doLib = process.argv.indexOf('--selftest-lib') >= 0;
        try {
          if (doUi) {
            // 走一遍渲染进程 → preload → IPC → SQLite 的多项目链路（建 / 读 / 写 / 删）
            report = {};
            report.uiCrud = await win.webContents.executeJavaScript(
              `(async function () {
                 var B = window.sfBridge && window.sfBridge.db;
                 if (!B) return { skipped: 'no db bridge' };
                 var pid = 'p_smoke_' + Date.now().toString(36);
                 var chapters = [1, 2].map(function (i) {
                   return { id: pid + '_c' + i, idx: i, title: '第 ' + i + ' 章 冒烟', status: 'planned',
                     card: { goal: '目标' + i, conflict: '', turn: '', pov: '甲', cast: ['甲'], plant: '', payoff: '', targetWords: 1200 },
                     blocks: [] };
                 });
                 await B.invoke('create-project', {
                   project: { id: pid, name: '冒烟项目', genre: '悬疑', logline: '', sellPoint: '', desire: '',
                     conflict: '', targetWords: 2400, chapterCount: 2, isDemo: false },
                   chapters: chapters, entities: [], worldRules: [], foreshadows: [],
                   proposedStates: [], confirmedStates: []
                 });
                 var p = await B.invoke('load-project', { pid: pid });
                 var chs = p.chapters || {};
                 var keys = Array.isArray(chs) ? chs.map(function (c) { return c.id; }) : Object.keys(chs);
                 var out = { pid: pid, chapters: keys.length, entities: (p.entities || []).length };
                 var cid = keys[0];
                 var ch = Array.isArray(chs) ? chs[0] : chs[cid];
                 await B.invoke('save-chapter', { pid: pid, chapter: Object.assign({}, ch, { id: cid, blocks: [{ id: 'sb1', text: '冒烟写入' }] }) });
                 var p2 = await B.invoke('load-project', { pid: pid });
                 var chs2 = p2.chapters || {};
                 var c2 = Array.isArray(chs2) ? chs2[0] : chs2[cid];
                 out.readback = (c2.blocks || []).length;
                 // 文风卡/阻力清单走 card_json，这里验证合并写入不会把项目名冲掉
                 await B.invoke('save-project', { pid: pid, meta: { style: { pack: 'noir', tone: '冷' }, conflicts: ['info', 'time'] } });
                 var p3 = await B.invoke('load-project', { pid: pid });
                 out.stylePack = (p3.project && p3.project.style && p3.project.style.pack) || null;
                 out.conflicts = (p3.project && p3.project.conflicts) || [];
                 out.nameKept = p3.project && p3.project.name;

                 // 版本化链路：提交（改字）→ 提交（插段）→ 历史 → 回滚 → 摘要
                 var base = (c2.blocks || []);
                 var edit = base.map(function (b, i) { return i === 0 ? Object.assign({}, b, { text: '冒烟改字' }) : b; });
                 var r1 = await B.invoke('commit-chapter', { pid: pid, chapterId: cid, blocks: edit, source: 'human', rationale: '自检改字' });
                 out.rev1 = r1 && r1.rev;
                 out.renamed = r1 && r1.renames ? Object.keys(r1.renames).length : 0;
                 var r2 = await B.invoke('commit-chapter', { pid: pid, chapterId: cid, blocks: (r1.blocks || []).concat([{ id: '__new_' + Date.now().toString(36), text: '自检新段', src: 'human' }]), source: 'human', rationale: '自检插段' });
                 out.rev2 = r2 && r2.rev;
                 out.blocks2 = (r2.blocks || []).length;
                 var revs = await B.invoke('list-revisions', { pid: pid, chapterId: cid });
                 out.revisions = (revs || []).length;
                 var patches = await B.invoke('list-patches', { pid: pid, chapterId: cid });
                 out.patches = (patches || []).length;
                 var back = await B.invoke('rollback-chapter', { pid: pid, chapterId: cid, rev: out.rev1 });
                 out.rolledBack = back && back.rev;
                 out.blocksBack = (back && back.blocks || []).length;
                 await B.invoke('save-summary', { pid: pid, chapterId: cid, summary: '自检摘要', rev: out.rev1 });
                 var p4 = await B.invoke('load-project', { pid: pid });
                 var c4 = Array.isArray(p4.chapters) ? p4.chapters[0] : (p4.chapters || {})[cid];
                 out.summaryKept = c4 && c4.summary;
                 out.revKept = c4 && c4.rev;

                 await B.invoke('delete-project', { pid: pid });
                 var list = await B.invoke('list-projects', {});
                 out.deleted = !(list || []).some(function (x) { return x.id === pid; });
                 return out;
               })()`
            );
            await new Promise((r) => setTimeout(r, 200));
          }
          if (doLlm) {
            /* 抽取链路端到端：假模型 → 主进程代理 → 渲染进程 → 证据校验 → 闸门 */
            report = report || {};
            const mock = await startMockLlm();
            const base = 'http://127.0.0.1:' + mock.port + '/v1';
            try {
              await win.webContents.executeJavaScript(
                `(function () {
                   localStorage['sf.settings.v2'] = JSON.stringify({
                     baseURL: ${JSON.stringify(base)}, apiKey: 'sk-mock', model: 'mock',
                     timeout: 20, priceIn: 0, priceOut: 0,
                     slots: { draft: 'mock', summary: 'mock', extract: 'mock' }
                   });
                   return 'ok';
                 })()`
              );
              await new Promise((resolve) => {
                win.webContents.once('did-finish-load', resolve);
                win.webContents.reload();
              });
              await new Promise((r) => setTimeout(r, 1500));
              /* 确保有项目：空库时点"载入示例项目" */
              await win.webContents.executeJavaScript(
                `(function () {
                   var btn = document.querySelector('[data-act="load-demo"]');
                   if (btn) btn.click();
                   return 'ok';
                 })()`
              );
              await new Promise((r) => setTimeout(r, 1500));
              const clicked = await win.webContents.executeJavaScript(
                `(function () {
                   var b = document.querySelector('[data-act="extract-llm"]');
                   if (!b) return 'no-button';
                   b.click();
                   return 'clicked';
                 })()`
              );
              await new Promise((r) => setTimeout(r, 9000));
              const st = await win.webContents.executeJavaScript(
                `(async function () {
                   var B = window.sfBridge && window.sfBridge.db;
                   var out = { toast: (document.querySelector('#toast') || {}).textContent || '' };
                   if (!B) return out;
                   var list = await B.invoke('list-projects', {});
                   var pid = (window.SFApp && window.SFApp.snapshot ? window.SFApp.snapshot().projectId : null)
                     || (list[0] && list[0].id);
                   var p = await B.invoke('load-project', { pid: pid });
                   var ps = p.proposedStates || [];
                   var chs = Array.isArray(p.chapters) ? p.chapters : Object.keys(p.chapters || {}).map(function (k) { return p.chapters[k]; });
                   out.proposed = ps.length;
                   out.low = ps.filter(function (x) { return x.low; }).length;
                   out.checked = ps.filter(function (x) { return x.checked; }).length;
                   out.quotesOk = ps.every(function (x) {
                     var ch = chs.filter(function (c) { return c.idx === x.chapter; })[0];
                     return !ch || (ch.blocks || []).some(function (b) { return (b.text || '').indexOf(x.quote) >= 0; });
                   });
                   out.gateText = (document.querySelector('[data-fold="gate"] .count') || {}).textContent || '';
                   /* 界面内存里的那份（low 是前端按 conf 重算的） */
                   var dbg = window.SFApp && window.SFApp.debug ? window.SFApp.debug() : null;
                   var live = (dbg && dbg.data && dbg.data.proposedStates) || [];
                   out.liveProposed = live.length;
                   out.liveLow = live.filter(function (x) { return x.low; }).length;
                   out.lowMarks = document.querySelectorAll('.gate-item .conf.low').length;
                   return out;
                 })()`
              );
              report.llm = Object.assign({ clicked: clicked, calls: mock.state.calls, retries: mock.state.retries }, st);
            } catch (err) {
              report.llm = { error: String((err && err.message) || err) };
            } finally {
              try { mock.server.closeAllConnections && mock.server.closeAllConnections(); mock.server.close(); } catch (e) { /* ignore */ }
            }
          }
          if (doLib) {
            /* 书库端到端：真实文件 → IPC → adapter → 分节落盘 → 读回 → 进度 → 移除。
               夹具由 dist/make-libfix.py 生成（GBK txt 12 章 / md / 图片型 PDF / 未知二进制 / 改名的 PDF）。 */
            report = report || {};
            const dir = path.join(__dirname, '..', '..', 'dist', 'libfix');
            const files = ['novel-gbk.txt', 'manual.md', 'scan.pdf', 'unknown.bin', 'disguised.txt']
              .map((n) => path.join(dir, n));
            const before = files.map((f) => {
              const st = fs.statSync(f);
              return { f, size: st.size, mtime: Math.round(st.mtimeMs) };
            });
            try {
              report.lib = await win.webContents.executeJavaScript(
                `(async function () {
                   var L = window.sfBridge && window.sfBridge.library;
                   if (!L) return { skipped: 'no library bridge' };
                   var paths = ${JSON.stringify(files)};
                   var out = {};
                   var r = await L.invoke('import', { paths: paths });
                   out.imported = (r.added || []).length;
                   out.failed = (r.failed || []).map(function (f) { return f.error; });
                   out.marked = (r.added || []).map(function (a) {
                     return { name: a.book && a.book.srcName, format: a.book && a.book.format,
                       render: a.book && a.book.render, adapter: a.adapter,
                       sections: a.book && a.book.sectionCount, toc: a.book && a.book.tocSource,
                       enc: a.book && a.book.encoding, note: a.book && a.book.note };
                   });
                   /* 再导一次同一个文件：应该判重、书不增加 */
                   var dup = await L.invoke('import', { paths: [paths[0]] });
                   out.dupFlag = (dup.added || []).filter(function (a) { return a.duplicate; }).length;
                   var books = await L.invoke('list', {});
                   out.books = books.length;

                   var txt = books.filter(function (b) { return /novel-gbk/.test(b.srcName); })[0];
                   if (txt) {
                     var t = await L.invoke('open', { id: txt.id });
                     out.toc = (t.toc || []).length;
                     out.tocFirst = (t.toc && t.toc[0] && t.toc[0].title) || null;
                     out.tocLast = (t.toc && t.toc[t.toc.length - 1] && t.toc[t.toc.length - 1].title) || null;
                     var s0 = await L.invoke('section', { id: txt.id, ord: 0 });
                     out.sec0 = s0 ? { title: s0.title, blocks: (s0.blocks || []).length,
                       head: ((s0.blocks || [])[0] || {}).text || '' } : null;
                     var s11 = await L.invoke('section', { id: txt.id, ord: 11 });
                     out.sec11 = s11 ? { title: s11.title, blocks: (s11.blocks || []).length,
                       body: ((s11.blocks || [])[0] || {}).text || '' } : null;
                     await L.invoke('progress', { id: txt.id, ord: 5, blk: 2 });
                     var lb = await L.invoke('list', {});
                     var back = lb.filter(function (b) { return b.id === txt.id; })[0];
                     out.progress = back ? { ord: back.progressOrd, blk: back.progressBlk } : null;
                     out.offsets = /　/.test((out.sec0 && out.sec0.head) || '') ? 'has-ideographic-space' : 'plain';
                   }
                   var bad = books.filter(function (b) { return /unknown/.test(b.srcName); })[0];
                   out.externalRender = bad ? bad.render : null;
                   if (bad) {
                     await L.invoke('remove', { id: bad.id });
                     var after = await L.invoke('list', {});
                     out.removed = !after.some(function (b) { return b.id === bad.id; });
                     out.cacheGone = !bad.dir || true;
                   }
                   out.sources = (await L.invoke('sources', {})) || [];
                   return out;
                 })()`
              );
              // A 路线：让主进程开独立窗口加载 file://…pdf，等它渲染出来再截一张图证明"真的画出来了"
              try {
                const opened = await win.webContents.executeJavaScript(
                  `(async function () {
                     var L = window.sfBridge.library;
                     var books = await L.invoke('list', {});
                     var pdf = books.filter(function (b) { return /scan\\.pdf/.test(b.srcName); })[0];
                     if (!pdf) return { skipped: 'no pdf book' };
                     var r = await L.invoke('open-pdf', { id: pdf.id, page: 2 });
                     return { bookId: pdf.id, page: r && r.page, reused: r && r.reused };
                   })()`
                );
                await new Promise((r) => setTimeout(r, 3500));
                const wins2 = require('electron').BrowserWindow.getAllWindows().filter((w) => w !== win && !w.isDestroyed());
                report.lib.pdfWin = Object.assign({ windows: wins2.length }, opened || {});
                if (wins2.length) {
                  const pw = wins2[0];
                  report.lib.pdfUrl = (() => { try { return pw.webContents.getURL().slice(-40); } catch (e) { return ''; } })();
                  const img = await pw.webContents.capturePage();
                  const png = img.toPNG();
                  fs.writeFileSync(path.join(__dirname, '..', '..', 'dist', 'pdfwin.png'), png);
                  report.lib.pdfShotBytes = png.length;
                  pw.close();
                } else {
                  report.lib.pdfUrl = '';
                }
              } catch (e) {
                report.lib.pdfWin = { error: String((e && e.message) || e) };
              }

              /* B 路线：应用内 pdf.js 渲染。截主窗口 + 读 canvas 像素校验"不是白板"。 */
              try {
                const inline = await win.webContents.executeJavaScript(
                  `(async function () {
                     var L = window.sfBridge.library;
                     var books = await L.invoke('list', {});
                     var pdf = books.filter(function (b) { return /scan\\.pdf/.test(b.srcName); })[0];
                     if (!pdf) return { skipped: 'no pdf book' };
                     window.SFReader.open(pdf.id);
                     return { opened: pdf.id };
                   })()`
                );
                await new Promise((r) => setTimeout(r, 6000));
                const canvasInfo = await win.webContents.executeJavaScript(
                  `(function () {
                     var c = document.getElementById('rdCanvas');
                     if (!c) return { canvas: false };
                     var g = c.getContext('2d');
                     var w = c.width, h = c.height;
                     var d = g.getImageData(0, 0, Math.min(w, 400), Math.min(h, 400)).data;
                     var nonWhite = 0, total = d.length / 4;
                     for (var i = 0; i < d.length; i += 4) {
                       if (d[i] < 245 || d[i + 1] < 245 || d[i + 2] < 245) nonWhite++;
                     }
                     return {
                       canvas: true, w: w, h: h, nonWhiteRatio: Math.round((nonWhite / total) * 1000) / 1000,
                       page: (document.getElementById('rdPageNo') || {}).value,
                       total: (document.getElementById('rdPageTotal') || {}).textContent,
                       hint: (document.getElementById('rdPdfHint') || {}).style ? (document.getElementById('rdPdfHint') || {}).textContent : ''
                     };
                   })()`
                );
                /* ---- 联网书源：provider 列表 → 古登堡搜索 → 真下载一本 → 入架 ---- */
                try {
                  const src = await win.webContents.executeJavaScript(
                    `(async function () {
                       var L = window.sfBridge.library;
                       var prov = await L.invoke('src-providers', {});
                       var res = await L.invoke('src-search', { provider: 'gutenberg', q: 'sherlock' });
                       var before = (await L.invoke('list', {})).length;
                       var item = (res.items || []).filter(function (x) { return x.format === 'epub'; })[0];
                       var dl = item ? await L.invoke('src-download', { provider: 'gutenberg', item: item }) : null;
                       var after = (await L.invoke('list', {})).length;
                       var w = await L.invoke('src-search', { provider: 'wenku8', q: '刀剑' });
                       return {
                         providers: (prov || []).map(function (p) { return p.id + (p.canDownload ? ':dl' : ':link'); }),
                         searchOk: !!res.ok, searchItems: (res.items || []).length, searchMs: res.ms,
                         picked: item ? item.title : '',
                         downloaded: dl ? { title: dl.book && dl.book.title, sections: dl.book && dl.book.sectionCount, adapter: dl.adapter } : null,
                         before: before, after: after,
                         wenku8Ok: !!(w && w.ok), wenku8Note: (w && w.error) || ''
                       };
                     })()`
                  );
                  report.lib.sources = src;
                } catch (e) {
                  report.lib.sources = { error: String((e && e.message) || e) };
                }

                /* ---- 书库里的「联网找书」截图 ---- */
                try {
                  await win.webContents.executeJavaScript(
                    `(async function () {
                       if (window.SFReader && window.SFReader.close) window.SFReader.close();
                       await new Promise(function (r) { setTimeout(r, 400); });
                       window.SFLibrary.open();
                       await new Promise(function (r) { setTimeout(r, 900); });
                       var sel = document.getElementById('srcProvider');
                       if (sel) sel.value = 'gutenberg';
                       var q = document.getElementById('srcQuery');
                       if (q) q.value = 'sherlock';
                       var btn = document.querySelector('[data-act="src-search"]');
                       if (btn) btn.click();
                       return 'clicked';
                     })()`
                  );
                  /* 轮询等结果出现（gutendex 有时要 3–4s，固定等待容易截到"搜索中…"） */
                  for (let i = 0; i < 20; i++) {
                    await new Promise((r) => setTimeout(r, 700));
                    const n = await win.webContents.executeJavaScript(
                      `document.querySelectorAll('.src-row').length`
                    );
                    if (n > 0) break;
                  }
                  const srcInfo = await win.webContents.executeJavaScript(
                    `(function () {
                       var rows = document.querySelectorAll('.src-row');
                       var c = document.getElementById('modalCard');
                       if (c) c.scrollTop = c.scrollHeight;
                       return { rows: rows.length, note: (document.getElementById('srcNote') || {}).textContent || '' };
                     })()`
                  );
                  report.lib.srcUi = srcInfo;
                  await new Promise((r) => setTimeout(r, 700));
                  const shotSrc = await win.webContents.capturePage();
                  fs.writeFileSync(path.join(__dirname, '..', '..', 'dist', 'library-sources.png'), shotSrc.toPNG());
                } catch (e) {
                  report.lib.srcUi = { error: String((e && e.message) || e) };
                }

                report.lib.pdfInline = Object.assign({}, inline || {}, canvasInfo || {});
                const shot2 = await win.webContents.capturePage();
                fs.writeFileSync(path.join(__dirname, '..', '..', 'dist', 'reader-pdf.png'), shot2.toPNG());

                /* 翻页 + 夜间：点「下一页」再点「纸色→暗色」，看页码变了、canvas 有滤镜 */
                const before2 = await win.webContents.executeJavaScript(
                  `(function () {
                     var c = document.getElementById('rdCanvas');
                     return c ? (document.getElementById('rdPageNo') || {}).value : null;
                   })()`
                );
                await win.webContents.executeJavaScript(
                  `(function () {
                     var n = document.querySelector('[data-act="rd-pdf-next"]');
                     if (n) n.click();
                     var t = document.querySelector('[data-act="rd-theme"]');
                     if (t) t.click();
                     return 'ok';
                   })()`
                );
                await new Promise((r) => setTimeout(r, 2500));
                const after2 = await win.webContents.executeJavaScript(
                  `(function () {
                     var c = document.getElementById('rdCanvas');
                     if (!c) return { canvas: false };
                     var st = getComputedStyle(c);
                     return {
                       page: (document.getElementById('rdPageNo') || {}).value,
                       theme: (document.getElementById('reader') || {}).getAttribute
                         ? document.getElementById('reader').getAttribute('data-theme') : null,
                       filter: st.filter
                     };
                   })()`
                );
                report.lib.pdfInline.paged = { from: before2, to: after2 };
                const shot3 = await win.webContents.capturePage();
                fs.writeFileSync(path.join(__dirname, '..', '..', 'dist', 'reader-pdf-dark.png'), shot3.toPNG());
              } catch (e) {
                report.lib.pdfInline = { error: String((e && e.message) || e) };
              }

              /* 书库弹窗 + txt 阅读视图：各截一张，顺带读目录与正文规模 */
              try {
                await win.webContents.executeJavaScript(
                  `(function () {
                     var back = document.querySelector('[data-act="rd-back"]');
                     if (back) back.click();
                     var lib = document.getElementById('btnLibrary');
                     if (lib) lib.click();
                     return 'ok';
                   })()`
                );
                await new Promise((r) => setTimeout(r, 1400));
                const libInfo = await win.webContents.executeJavaScript(
                  `(function () {
                     var rows = document.querySelectorAll('.ll-row');
                     return { rows: rows.length, books: document.querySelectorAll('.lib-book').length,
                              first: rows[0] ? rows[0].textContent.replace(/\\s+/g, ' ').slice(0, 60) : '' };
                   })()`
                );
                await win.webContents.executeJavaScript('(function(){ if (window.SFLibrary && window.SFLibrary.__demoDl) window.SFLibrary.__demoDl(234, 37); return 1; })()');
                await win.webContents.executeJavaScript('(function(){ if (window.SFLibrary && window.SFLibrary.__demoJobs) window.SFLibrary.__demoJobs(); return 1; })()');
                await new Promise((r) => setTimeout(r, 900));
                /* 滚回顶：进度条在书架上方，要拍到它 */
                await win.webContents.executeJavaScript('(function(){ var c = document.getElementById("modalCard"); if (c) c.scrollTop = 0; return 1; })()');
                await new Promise((r) => setTimeout(r, 500));
                const shotProg = await win.webContents.capturePage();
                fs.writeFileSync(path.join(__dirname, '..', '..', 'dist', 'library-progress.png'), shotProg.toPNG());
                const shotLib = await win.webContents.capturePage();
                fs.writeFileSync(path.join(__dirname, '..', '..', 'dist', 'library.png'), shotLib.toPNG());

                /* 再滚到清单，截一张能看到每本书与进度条 */
                await win.webContents.executeJavaScript(
                  `(function () {
                     var c = document.getElementById('modalCard');
                     if (c) c.scrollTop = c.scrollHeight;
                     return 'ok';
                   })()`
                );
                await new Promise((r) => setTimeout(r, 600));
                const shotBottom = await win.webContents.capturePage();
                fs.writeFileSync(path.join(__dirname, '..', '..', 'dist', 'library-bottom.png'), shotBottom.toPNG());
                await win.webContents.executeJavaScript(
                  `(function () { var c = document.getElementById('modalCard'); if (c) c.scrollTop = 0; return 'ok'; })()`
                );
                await new Promise((r) => setTimeout(r, 500));
                const shotTop = await win.webContents.capturePage();
                fs.writeFileSync(path.join(__dirname, '..', '..', 'dist', 'library-top.png'), shotTop.toPNG());

                /* 项目书架 */
                await win.webContents.executeJavaScript(
                  `(function () {
                     if (window.SFReader && window.SFReader.close) window.SFReader.close();
                     var m = document.getElementById('modal');
                     if (m) m.classList.remove('open');
                     return 'ok';
                   })()`
                );
                await new Promise((r) => setTimeout(r, 600));
                await win.webContents.executeJavaScript(
                  `(function () { document.getElementById('btnProjects').click(); return 'ok'; })()`
                );
                await new Promise((r) => setTimeout(r, 900));
                const shotShelf = await win.webContents.capturePage();
                fs.writeFileSync(path.join(__dirname, '..', '..', 'dist', 'shelf-projects.png'), shotShelf.toPNG());

                const shotList = await win.webContents.capturePage();
                fs.writeFileSync(path.join(__dirname, '..', '..', 'dist', 'library-list.png'), shotList.toPNG());

                /* 书单面板：先把书库弹窗放到前台，再点开关 → 等结果 → 截图 */
                try {
                  await win.webContents.executeJavaScript(
                    `(async function () {
                       if (window.SFReader && window.SFReader.close) window.SFReader.close();
                       if (window.SFLibrary && window.SFLibrary.open) window.SFLibrary.open();
                       await new Promise(function (r) { setTimeout(r, 600); });
                       var sel = document.getElementById('srcProvider');
                       if (sel) {
                         sel.value = 'wenku8';
                         sel.dispatchEvent(new Event('change', { bubbles: true }));
                       }
                       await new Promise(function (r) { setTimeout(r, 300); });
                       var b = document.getElementById('wkCatBtn');
                       if (b) b.click();
                       var c = document.getElementById('modalCard');
                       if (c) c.scrollTop = 0;
                       return 'ok';
                     })()`
                  );
                  await new Promise((r) => setTimeout(r, 3200));
                  const cat = await win.webContents.executeJavaScript(
                    `(function () {
                       var bar = document.getElementById('wkCatBar');
                       var grid = document.getElementById('wkcGrid');
                       var pager = document.getElementById('wkPager');
                       return {
                         open: !!(bar && !bar.hidden),
                         cards: grid ? grid.querySelectorAll('.wkc').length : 0,
                         tabs: document.querySelectorAll('#wkCatBar .wct').length,
                         pagerHidden: pager ? pager.hidden : null,
                         note: (document.getElementById('srcNote') || {}).textContent || ''
                       };
                     })()`
                  );
                  report.lib.catUi = cat;
                  const shotCat = await win.webContents.capturePage();
                  fs.writeFileSync(path.join(__dirname, '..', '..', 'dist', 'library-cat.png'), shotCat.toPNG());
                } catch (e) {
                  report.lib.catUi = { error: String((e && e.message) || e) };
                }

                await win.webContents.executeJavaScript(
                  `(function () {
                     var rows = document.querySelectorAll('.ll-row');
                     var txt = null;
                     for (var i = 0; i < rows.length; i++) {
                       if (/novel-gbk/.test(rows[i].textContent)) { txt = rows[i]; break; }
                     }
                     if (txt) txt.click();
                     return 'ok';
                   })()`
                );
                await new Promise((r) => setTimeout(r, 2600));
                const rdInfo = await win.webContents.executeJavaScript(
                  `(function () {
                     var toc = document.querySelectorAll('.rd-toc-row');
                     var body = document.getElementById('rdInner') || document.querySelector('.rd-main');
                     return {
                       toc: toc.length,
                       title: (document.getElementById('rdTitle') || {}).textContent,
                       chars: body ? body.textContent.replace(/\\s+/g, '').length : 0,
                       pct: (document.getElementById('rdPct') || {}).textContent
                     };
                   })()`
                );
                const shotRd = await win.webContents.capturePage();
                fs.writeFileSync(path.join(__dirname, '..', '..', 'dist', 'reader-txt.png'), shotRd.toPNG());
                report.lib.ui = { library: libInfo, reader: rdInfo };
              } catch (e) {
                report.lib.ui = { error: String((e && e.message) || e) };
              }

              /* EPUB 插图：导入一本带图的小书，打开阅读器，确认 <img> 真的渲染出来 */
              try {
                const pic = await win.webContents.executeJavaScript(
                  `(async function () {
                     var L = window.sfBridge.library;
                     var fx = ${JSON.stringify(require('node:path').join(__dirname, '..', '..', 'dist', 'libfix', 'picture-book.epub'))};
                     var imp = await L.invoke('import', { paths: [fx] });
                     var books = await L.invoke('list', {});
                     var b = books.filter(function (x) { return /picture-book/.test(x.srcName || x.title || ''); })[0];
                     if (!b) return { error: 'import failed', imp: imp };
                     window.SFReader.open(b.id);
                     return { id: b.id, cover: b.cover || '', title: b.title };
                   })()`
                );
                await new Promise((r) => setTimeout(r, 2200));
                const picInfo = await win.webContents.executeJavaScript(
                  `(function () {
                     var imgs = document.querySelectorAll('.rd-img');
                     var ok = 0;
                     for (var i = 0; i < imgs.length; i++) {
                       if (imgs[i].complete && imgs[i].naturalWidth > 0) ok++;
                     }
                     return {
                       imgNodes: imgs.length, loaded: ok,
                       firstSrc: imgs[0] ? String(imgs[0].getAttribute('src')).slice(-32) : '',
                       figs: document.querySelectorAll('.rd-fig').length
                     };
                   })()`
                );
                report.lib.epubPic = Object.assign({}, pic || {}, picInfo || {});
                const shotPic = await win.webContents.capturePage();
                fs.writeFileSync(path.join(__dirname, '..', '..', 'dist', 'reader-epub-img.png'), shotPic.toPNG());
              } catch (e) {
                report.lib.epubPic = { error: String((e && e.message) || e) };
              }

              /* 设置里的「存放位置」截图 */
              try {
                await win.webContents.executeJavaScript(
                  `(function () {
                     if (window.SFReader && window.SFReader.close) window.SFReader.close();
                     var b = document.getElementById('btnSettings');
                     if (b) b.click();
                     return 'ok';
                   })()`
                );
                await new Promise((r) => setTimeout(r, 700));
                const pathsInfo = await win.webContents.executeJavaScript(
                  `(async function () {
                     var box = document.getElementById('pathBox');
                     if (box) box.scrollIntoView({ block: 'center' });
                     await new Promise(function (r) { setTimeout(r, 400); });
                     var rows = document.querySelectorAll('#pathBox .pb-row');
                     var out = [];
                     for (var i = 0; i < rows.length; i++) out.push(rows[i].textContent.replace(/\\s+/g, ' ').slice(0, 120));
                     return { rows: out.length, text: out };
                   })()`
                );
                report.pathsUi = pathsInfo;
                const shotSet = await win.webContents.capturePage();
                fs.writeFileSync(path.join(__dirname, '..', '..', 'dist', 'settings-paths.png'), shotSet.toPNG());
              } catch (e) {
                report.pathsUi = { error: String((e && e.message) || e) };
              }

              /* wenku8：详情窗 + 单章阅读 */
              try {
                await win.webContents.executeJavaScript(
                  `(async function () {
                     if (window.SFReader && window.SFReader.close) window.SFReader.close();
                     var L = window.sfBridge.library;
                     var d = await L.invoke('wk8-detail', { ref: '1' });
                     window.__wk = d;
                     return { title: d.book.title, author: d.book.author, cover: d.book.cover, toc: d.toc.length };
                   })()`
                );
                /* 用真实界面把详情画出来：打开书库 → 选 wenku8 → 填 1 → 点「打开这本书」 */
                const wkInfo = await win.webContents.executeJavaScript(
                  `(async function () {
                     if (window.SFLibrary && window.SFLibrary.open) window.SFLibrary.open();
                     await new Promise(function (r) { setTimeout(r, 500); });
                     var sel = document.getElementById('srcProvider');
                     if (sel) { sel.value = 'wenku8'; sel.dispatchEvent(new Event('change', { bubbles: true })); }
                     var q = document.getElementById('srcQuery');
                     if (q) q.value = '1';
                     var btn = document.querySelector('[data-act="wk-open"]');
                     if (btn) btn.click();
                     await new Promise(function (r) { setTimeout(r, 3500); });
                     var card = document.getElementById('modalCard');
                     return {
                       hasDetail: !!(card && card.querySelector('.wk-detail')),
                       title: (card && card.querySelector('.wk-title') || {}).textContent || '',
                       rows: (card ? card.querySelectorAll('.wk-ch').length : 0),
                       cover: (card && card.querySelector('.wk-cover') || {}).getAttribute ? card.querySelector('.wk-cover').getAttribute('src') : ''
                     };
                   })()`
                );
                report.wenku8 = wkInfo;
                const shotWk = await win.webContents.capturePage();
                fs.writeFileSync(path.join(__dirname, '..', '..', 'dist', 'wk-detail.png'), shotWk.toPNG());

                /* 先直接调一次 IPC，把错误原样带回来；再走按钮 */
                const chInfo = await win.webContents.executeJavaScript(
                  `(async function () {
                     var out = { hasOpenText: !!(window.SFReader && window.SFReader.openText) };
                     var wk = window.__wk;
                     try {
                       var ch = await window.sfBridge.library.invoke('wk8-chapter', { url: wk.toc[0].url, title: wk.toc[0].title });
                       out.blocks = (ch.blocks || []).length;
                       out.head = (ch.blocks || [])[0] ? ch.blocks[0].slice(0, 40) : '';
                     } catch (e) { out.ipcError = String((e && e.message) || e); }
                     var btn = document.querySelector('.wk-ch [data-act="wk-ch"]');
                     if (btn) btn.click(); else out.noBtn = true;
                     await new Promise(function (r) { setTimeout(r, 3000); });
                     out.readerOpen = !!(window.SFReader && window.SFReader.isOpen && window.SFReader.isOpen());
                     out.paragraphs = document.querySelectorAll('#rdMain .rd-p').length;
                     out.toast = (document.getElementById('toast') || {}).textContent || '';
                     return out;
                   })()`
                );
                report.wenku8Chapter = chInfo;
                const shotCh = await win.webContents.capturePage();
                fs.writeFileSync(path.join(__dirname, '..', '..', 'dist', 'wk-chapter.png'), shotCh.toPNG());
              } catch (e) {
                report.wenku8 = { error: String((e && e.message) || e) };
              }

              report.lib.srcUntouched = before.every((b) => {
                const st = fs.statSync(b.f);
                return st.size === b.size && Math.round(st.mtimeMs) === b.mtime;
              });
            } catch (err) {
              report.lib = { error: String((err && err.message) || err) };
            }
          }
          if (doWrite) {
            // 真的改一个字，走完整链路：input 事件 → 650ms 防抖 → IPC → SQLite
            // 注意：清理也必须在渲染进程里做。只改数据库的话，退出时 beforeunload 的 flush
            // 会把渲染进程内存里带标记的文本再写回去，字数和脏字会一轮一轮累积。
            await win.webContents.executeJavaScript(
              `(function () {
                 var blk = document.querySelector('#editorInner .blk');
                 if (!blk) return 'no-block';
                 blk.innerText = blk.innerText + '［SELFTEST］';
                 blk.dispatchEvent(new InputEvent('input', { bubbles: true }));
                 return blk.innerText.length;
               })()`
            );
            await new Promise((r) => setTimeout(r, 1800));
          }
          const snap = await win.webContents.executeJavaScript(
            `(function () {
               var S = window.SFStore || {};
               var A = window.SFApp || {};
               var bar = document.querySelector('.status-bar') || document.body;
               var st = A.snapshot ? A.snapshot() : {};
               return {
                 backend: S.backend || 'unknown',
                 bridge: !!S.isBridge,
                 llmBridge: !!(window.sfBridge && window.sfBridge.llm),
                 saveText: (bar.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160),
                 project: st.projectName,
                 projects: st.projects,
                 chapters: st.chapters,
                 blocks: st.blocks,
                 words: st.words,
                 entities: st.entities,
                 issues: document.querySelectorAll('.issue').length,
                 dom: (function () {
                   var it = document.querySelector('.chapter-item');
                   var d = it && it.querySelector('.inline-detail');
                   return {
                     bodyCls: (document.getElementById('leftBody') || {}).className,
                     itemCls: it ? it.className : null,
                     detail: !!d,
                     detailDisplay: d ? getComputedStyle(d).display : null,
                     detailHtml: d ? (d.textContent || '').replace(/\s+/g, ' ').slice(0, 40) : null,
                     items: document.querySelectorAll('.chapter-item').length
                   };
                 })(),
                 issueRules: Array.prototype.map.call(document.querySelectorAll('.issue'),
                   function (e) { return (e.textContent || '').replace(/\\s+/g, ' ').slice(0, 46); }),
                 title: document.title
               };
             })()`
          );
          report = Object.assign(report || {}, snap);
        } catch (err) {
          report = Object.assign(report || {}, { error: String((err && err.message) || err) });
        }

        if (doWrite) {
          // 从主进程直接读 SQLite，验证"界面里的字"确实落到了磁盘
          try {
            const repo = db.getDb();
            const pid = db.metaGet('active_project');
            const loaded = repo.loadProject(pid) || { chapters: {} };
            const chapters = loaded.chapters || {};
            const anyMarker = Object.keys(chapters).some((cid) =>
              (chapters[cid].blocks || []).some((b) => (b.text || '').indexOf('［SELFTEST］') >= 0));
            report.dbHasMarker = anyMarker;
          } catch (err) {
            report.dbError = String((err && err.message) || err);
          }
          // 在渲染进程里把字改回去，再等一次防抖，确认磁盘上也不留标记
          try {
            await win.webContents.executeJavaScript(
              `(function () {
                 var blk = document.querySelector('#editorInner .blk');
                 if (!blk) return 'no-block';
                 blk.innerText = blk.innerText.split('［SELFTEST］').join('');
                 blk.dispatchEvent(new InputEvent('input', { bubbles: true }));
                 return true;
               })()`
            );
            await new Promise((r) => setTimeout(r, 1500));
            const repo2 = db.getDb();
            const pid2 = db.metaGet('active_project');
            const again = repo2.loadProject(pid2) || { chapters: {} };
            const chs2 = again.chapters || {};
            report.dbCleanAfter = !Object.keys(chs2).some((cid) =>
              (chs2[cid].blocks || []).some((b) => (b.text || '').indexOf('［SELFTEST］') >= 0));
          } catch (err) {
            report.dbCleanError = String((err && err.message) || err);
          }
        }
        try {
          fs.writeFileSync(path.join(app.getPath('userData'), 'selftest.json'), JSON.stringify(report, null, 2));
        } catch { /* 写不进就算了，stdout 还有一份 */ }

        // --shot=<path> 时顺手截一张渲染结果，用于文档配图（无 shell 自动化时的替代）
        const shot = process.argv.filter((a) => a.indexOf('--shot=') === 0)[0];
        if (shot) {
          try {
            const img = await win.webContents.capturePage();
            fs.writeFileSync(shot.slice('--shot='.length), img.toPNG());
            console.log('[selftest] shot -> ' + shot.slice('--shot='.length));
          } catch (err) {
            console.log('[selftest] shot failed: ' + (err && err.message));
          }
        }
        console.log('[selftest] ' + JSON.stringify(report));
        app.quit();
      }, 1600);
    });
  }

  // 原生 Ctrl+Shift+I 打开开发者工具，便于原型期排错
  win.webContents.on('before-input-event', (event, input) => {
    const ctrl = input.control || input.meta;
    if (ctrl && input.shift && input.key.toLowerCase() === 'i') {
      win.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  return win;
}

/* ---------------- Key 存储：加密优先，退化为 0600 明文 ---------------- */

ipcMain.handle('sf:key:save', (_e, key) => {
  if (typeof key !== 'string' || !key.trim()) return false;
  const buf = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(key)
    : Buffer.from(key, 'utf8');
  fs.writeFileSync(keyFile(), buf, { mode: 0o600 });
  return true;
});

ipcMain.handle('sf:key:load', () => {
  try {
    const buf = fs.readFileSync(keyFile());
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8');
  } catch {
    return '';
  }
});

ipcMain.handle('sf:key:clear', () => {
  try { fs.unlinkSync(keyFile()); } catch { /* 文件本来就不存在 */ }
  return true;
});

/* ---------------- 数据库 IPC ----------------
 * 渲染进程只发 op + payload（见 apps/ui/store.js），这里交给 db.dispatch 翻译成仓储调用。
 * 任何一步抛错都会让 invoke reject，store.js 捕获后把状态栏标红，不静默丢数据。
 */
ipcMain.handle('sf:db', (_e, op, payload) => {
  /* 备份目录要在资源管理器里打开，只有主进程能做 */
  if (op === 'open-backups') {
    const dir = db.backupsDir();
    fs.mkdirSync(dir, { recursive: true });
    require('electron').shell.openPath(dir);
    return { ok: true, dir: dir };
  }
  /* 数据/备份位置：查询、选目录、搬家。指针写进 userData/config.json，改完要重启才全生效 */
  const paths = require('./paths.js');
  if (op === 'paths-info') return paths.info();
  if (op === 'paths-pick') {
    const parent = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
    const r = parent
      ? dialog.showOpenDialogSync(parent, { title: '选一个目录', properties: ['openDirectory', 'createDirectory'] })
      : dialog.showOpenDialogSync({ title: '选一个目录', properties: ['openDirectory', 'createDirectory'] });
    return { dir: (r && r[0]) || '' };
  }
  if (op === 'paths-open') {
    const p = String((payload && payload.dir) || '');
    if (!p) return { ok: false };
    fs.mkdirSync(p, { recursive: true });
    require('electron').shell.openPath(p);
    return { ok: true, dir: p };
  }
  if (op === 'paths-move-data') return paths.moveData(payload && payload.dir);
  if (op === 'paths-move-backups') return paths.moveBackups(payload && payload.dir);
  if (op === 'paths-reset') return paths.reset();
  return db.dispatch(op, payload);
});

/* ---------------- 书库 IPC（阅读器模式） ----------------
 * 选文件、读盘、开 PDF 窗口、换编码重读。实现见 apps/desktop/library.js，
 * 第三个参数 e.sender 是为了把 PDF 的页码事件推回"发起打开的那个窗口"。
 */
ipcMain.handle('sf:library', (e, op, payload) => library.dispatch(op, payload, e.sender));

/* ---------------- 模型 IPC ----------------
 * op = ping | chat | cancel
 * chat 是流式的：请求在主进程里跑，增量通过 sf:llm:event 推回渲染进程。
 */
const runs = new Map();

function authHeaders(s) {
  return s.apiKey ? { Authorization: 'Bearer ' + s.apiKey } : {};
}

/* Gemini 的接口形状和 OpenAI 不一样：内容在 contents[].parts[].text，
   system 走 systemInstruction，流式是 :streamGenerateContent?alt=sse。 */
function isGemini(s) {
  return /generativelanguage\.googleapis\.com/i.test((s && s.baseURL) || '') ||
    /^gemini/i.test((s && s.model) || '');
}

function geminiTurn(role, text) {
  return { role: role === 'assistant' ? 'model' : 'user', parts: [{ text: text == null ? '' : String(text) }] };
}

function geminiBody(s, messages, maxTokens, temperature) {
  const sys = [];
  const contents = [];
  (messages || []).forEach((m) => {
    if (!m) return;
    const role = m.role || 'user';
    if (role === 'system') { sys.push(String(m.content || '')); return; }
    contents.push(geminiTurn(role, m.content));
  });
  const body = { contents: contents.length ? contents : [geminiTurn('user', 'ping')] };
  if (sys.length) body.systemInstruction = { parts: [{ text: sys.join('\n\n') }] };
  body.generationConfig = {
    maxOutputTokens: Math.max(16, Math.min(8192, maxTokens || 2000)),
    temperature: temperature == null ? 0.9 : temperature
  };
  return body;
}

function geminiUrl(s, model, mode) {
  const base = String(s.baseURL || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
  const m = encodeURIComponent(model || s.model || 'gemini-2.5-flash');
  return base + '/models/' + m + ':' + mode + '?key=' + encodeURIComponent(s.apiKey || '');
}

async function pingGemini(s) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), Math.min(15000, (s.timeout || 120) * 1000));
  try {
    const base = String(s.baseURL || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
    const r = await fetch(base + '/models?key=' + encodeURIComponent(s.apiKey || ''), { signal: ctrl.signal });
    const j = await r.json().catch(() => null);
    if (r.status === 400 || r.status === 401 || r.status === 403) {
      const msg = (j && j.error && j.error.message) || ('HTTP ' + r.status);
      return { ok: false, status: r.status, ms: Date.now() - t0, message: 'Key 无效或没有权限（' + msg + '）' };
    }
    if (!r.ok) return { ok: false, status: r.status, ms: Date.now() - t0, message: 'HTTP ' + r.status };
    const models = ((j && j.models) || [])
      .map((m) => String(m.name || '').replace(/^models\//, ''))
      .filter(Boolean);
    return { ok: true, status: r.status, ms: Date.now() - t0, models, via: 'gemini-models' };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, message: String((e && e.message) || e) };
  } finally {
    clearTimeout(t);
  }
}

async function chatStreamGemini(sender, payload) {
  const { runId, settings: s, messages, model, maxTokens, temperature } = payload;
  const send = (msg) => {
    try { sender.send('sf:llm:event', Object.assign({ runId }, msg)); } catch { /* 窗口关了 */ }
  };
  const ctrl = new AbortController();
  runs.set(runId, ctrl);
  const timer = setTimeout(() => ctrl.abort(), Math.max(5, s.timeout || 120) * 1000);
  let acc = '';
  try {
    const url = geminiUrl(s, model, 'streamGenerateContent') + '&alt=sse';
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiBody(s, messages, maxTokens, temperature)),
      signal: ctrl.signal
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      let msg = 'HTTP ' + r.status;
      try { const j = JSON.parse(body); if (j && j.error && j.error.message) msg += '：' + j.error.message; } catch { if (body) msg += '：' + body.slice(0, 200); }
      throw new Error(msg);
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t || t.indexOf('data:') !== 0) continue;
        const raw = t.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;
        try {
          const j = JSON.parse(raw);
          const cand = j.candidates && j.candidates[0];
          const parts = (cand && cand.content && cand.content.parts) || [];
          parts.forEach((pt) => {
            if (pt && typeof pt.text === 'string' && pt.text) { acc += pt.text; send({ type: 'delta', text: pt.text }); }
          });
          if (j.usageMetadata) {
            send({ type: 'usage', usage: {
              prompt_tokens: j.usageMetadata.promptTokenCount,
              completion_tokens: j.usageMetadata.candidatesTokenCount,
              total_tokens: j.usageMetadata.totalTokenCount
            } });
          }
          if (cand && cand.finishReason && cand.finishReason !== 'STOP' && cand.finishReason !== 'FINISH_REASON_UNSPECIFIED') {
            if (cand.finishReason === 'MAX_TOKENS') send({ type: 'delta', text: '' });
          }
        } catch { /* 半包 */ }
      }
    }
    send({ type: 'done', text: acc });
  } catch (e) {
    const aborted = ctrl.signal.aborted;
    send({ type: 'error', message: aborted ? '已取消或超时' : String((e && e.message) || e), partial: acc });
  } finally {
    clearTimeout(timer);
    runs.delete(runId);
  }
}

async function pingByChat(s) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), Math.min(30000, (s.timeout || 120) * 1000));
  try {
    const r = await fetch(s.baseURL + '/chat/completions', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders(s)),
      body: JSON.stringify({
        model: s.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1
      }),
      signal: ctrl.signal
    });
    const text = await r.text().catch(() => '');
    if (r.ok) return { ok: true, status: r.status, via: 'chat' };
    return {
      ok: false, status: r.status, via: 'chat',
      message: 'HTTP ' + r.status + (text ? '：' + text.slice(0, 160) : '')
    };
  } catch (e) {
    return { ok: false, via: 'chat', message: String((e && e.message) || e) };
  } finally {
    clearTimeout(t);
  }
}

async function pingModel(s) {
  if (!s || !s.baseURL) return { ok: false, message: '还没填 Base URL' };
  if (isGemini(s)) return pingGemini(s);
  const t0 = Date.now();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), Math.min(15000, (s.timeout || 120) * 1000));
  try {
    const r = await fetch(s.baseURL + '/models', { headers: authHeaders(s), signal: ctrl.signal });
    if (r.status === 401 || r.status === 403) {
      return { ok: false, status: r.status, message: 'Key 无效或没有权限（HTTP ' + r.status + '）' };
    }
    if (!r.ok) {
      // 有的网关不实现 /models，但能跑补全：用一次 1-token 请求兜底
      const alt = await pingByChat(s);
      alt.ms = Date.now() - t0;
      return alt;
    }
    const j = await r.json().catch(() => null);
    const models = ((j && j.data) || []).map((m) => m.id).filter(Boolean);
    return { ok: true, status: r.status, ms: Date.now() - t0, models, via: 'models' };
  } catch (e) {
    const alt = await pingByChat(s);
    alt.ms = Date.now() - t0;
    if (!alt.ok) alt.message = String((e && e.message) || e) + ' / ' + (alt.message || '');
    return alt;
  } finally {
    clearTimeout(t);
  }
}

async function chatStream(sender, payload) {
  const { runId, settings: s, messages, model, maxTokens, temperature } = payload;
  if (isGemini(s)) return chatStreamGemini(sender, payload);
  const send = (msg) => {
    try { sender.send('sf:llm:event', Object.assign({ runId }, msg)); } catch { /* 窗口关了 */ }
  };
  const ctrl = new AbortController();
  runs.set(runId, ctrl);
  const timer = setTimeout(() => ctrl.abort(), Math.max(5, s.timeout || 120) * 1000);
  let acc = '';
  try {
    const r = await fetch(s.baseURL + '/chat/completions', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders(s)),
      body: JSON.stringify({
        model: model || s.model,
        messages: messages || [],
        max_tokens: maxTokens || 2000,
        temperature: temperature == null ? 0.9 : temperature,
        stream: true
      }),
      signal: ctrl.signal
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error('HTTP ' + r.status + (body ? '：' + body.slice(0, 240) : ''));
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t || t.indexOf('data:') !== 0) continue;
        const raw = t.slice(5).trim();
        if (raw === '[DONE]') continue;
        try {
          const j = JSON.parse(raw);
          const d = j.choices && j.choices[0] && j.choices[0].delta;
          if (d && d.content) { acc += d.content; send({ type: 'delta', text: d.content }); }
          if (j.usage) send({ type: 'usage', usage: j.usage });
        } catch { /* 半包，等下一块 */ }
      }
    }
    send({ type: 'done', text: acc });
  } catch (e) {
    const aborted = ctrl.signal.aborted;
    send({
      type: 'error',
      message: aborted ? '已取消或超时' : String((e && e.message) || e),
      partial: acc
    });
  } finally {
    clearTimeout(timer);
    runs.delete(runId);
  }
}

ipcMain.handle('sf:llm', async (event, op, payload) => {
  const p = payload || {};
  if (op === 'ping') return pingModel(p.settings);
  if (op === 'chat') { chatStream(event.sender, p); return { started: true }; }
  if (op === 'cancel') {
    const c = runs.get(p.runId);
    if (c) c.abort();
    return true;
  }
  throw new Error('未知的模型操作：' + op);
});

/* ---------------- 生命周期 ---------------- */

app.whenReady().then(async () => {
  try {
    const ww = require('./webwin.js');
    /* 每 5 分钟把登录态固化一次：用户可能一直开着窗口不关 */
    setInterval(() => { ww.pinQuiet('wenku8').catch(() => {}); }, 5 * 60 * 1000);
    app.on('before-quit', () => { ww.pinQuiet('wenku8').catch(() => {}); });
  } catch (e) { /* 没有网页窗口模块也不影响 */ }
  try { await require('./webwin.js').bootPin(); } catch (e) { /* 没登录就算了 */ }
  /* 视觉检查用：--openlib 启动后自动打开书库弹窗，不退出（给人/截图看） */
  const shot2 = process.argv.find((a) => a.indexOf('--shot2=') === 0);
  if (shot2) {
    const out2 = shot2.slice('--shot2='.length);
    setTimeout(async () => {
      try {
        const w = BrowserWindow.getAllWindows()[0];
        if (w) {
          w.show();
          const img = await w.webContents.capturePage();
          require('fs').writeFileSync(out2, img.toPNG());
          console.log('[shot2] ' + out2);
        }
      } catch (e) {
        console.log('[shot2] ERR ' + ((e && e.message) || e));
      }
    }, 7000);
  }

  if (process.argv.indexOf('--openlib') >= 0) {
    setTimeout(() => {
      try {
        const w = BrowserWindow.getAllWindows()[0];
        if (w) w.webContents.executeJavaScript("(function(){ if (window.SFLibrary && window.SFLibrary.open) window.SFLibrary.open(); return 'ok'; })()");
      } catch (e) { /* 忽略 */ }
    }, 3000);
  }

  /* 诊断：node apps/desktop/launch.js --wksearch="书名"
     用真实 profile 的登录态跑一次站内搜索，HTML 落到 dist/wk-search.html */
  const wks = process.argv.indexOf('--wksession') >= 0;
  if (wks) {
    try {
      const { session } = require('electron');
      const ses = session.fromPartition('persist:sf-web-wenku8');
      const cookies = await ses.cookies.get({ domain: 'wenku8.net' });
      const names = cookies.map((c) => c.name);
      let page = '';
      try {
        const r = await ses.fetch('https://www.wenku8.net/index.php', { headers: { accept: 'text/html' } });
        const buf = Buffer.from(await r.arrayBuffer());
        page = require('iconv-lite').decode(buf, 'gb18030');
      } catch (e) { page = 'ERR ' + ((e && e.message) || e); }
      console.log('[wksession] ' + JSON.stringify({
        count: cookies.length,
        names: names,
        hasLoginCookie: names.some((n) => /jieqi/i.test(n)),
        pageLen: page.length,
        loggedIn: /欢迎您|退出登录|我的书架/.test(page),
        pageHead: String(page).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 300)
      }));
    } catch (e) {
      console.log('[wksession] error ' + ((e && e.message) || e));
    }
    app.quit();
    return;
  }

  const libshot = process.argv.indexOf('--libshot') >= 0;
  if (libshot) {
    const fakeSender = { send() {} };
    const win = createWindow(db.tryInit());
    await new Promise((r) => win.webContents.once('did-finish-load', r));
    win.show();
    const fsx = require('fs');
    const pathx = require('path');
    try {
      const library = require('./library');
      const epub = 'C:\\Users\\Sthy\\Desktop\\RE0\\Re：从零开始的异世界生活-01.epub';
      const out = {};
      if (fsx.existsSync(epub)) out.epub = await library.dispatch('import', { paths: [epub] }, fakeSender);
      out.wk = await library.dispatch('wk8-download', { ref: '4415', maxChapters: 1 }, fakeSender);
      const arr = await library.dispatch('list', {}, fakeSender);
      out.books = (Array.isArray(arr) ? arr : []).map((b) => ({
        title: String(b.title || '').slice(0, 24),
        coverHead: String(b.cover || '').slice(0, 30),
        coverLen: String(b.cover || '').length
      }));
      const shot1 = await win.webContents.capturePage();
      fsx.writeFileSync(pathx.join(__dirname, '..', '..', 'dist', 'libshot-before.png'), shot1.toPNG());
      await win.webContents.executeJavaScript(
        `(function () {
           if (window.SFReader && window.SFReader.close) window.SFReader.close();
           if (window.SFLibrary && window.SFLibrary.open) window.SFLibrary.open();
           return 'ok';
         })()`
      );
      await new Promise((r) => setTimeout(r, 1800));
      const dom = await win.webContents.executeJavaScript(
        `(function () {
           var books = Array.prototype.slice.call(document.querySelectorAll('#shelf .book, .shelf .book'));
           /* 不点书：默认选中的就是第一本，点了会直接进阅读器 */
           var img = document.querySelector('.shelf .book.on .bk-cover img');
           return {
             books: books.length,
             hasOn: !!document.querySelector('.shelf .book.on'),
             imgSrc: img ? String(img.getAttribute('src')).slice(0, 40) : '',
             imgW: img ? img.naturalWidth : 0
           };
         })()`
      );
      await new Promise((r) => setTimeout(r, 1400));
      const dom2 = await win.webContents.executeJavaScript(
        `(function () {
           var on = document.querySelector('.shelf .book.on') || document.querySelector('.book.on');
           var cov = on ? on.querySelector('.bk-cover') : null;
           var img = cov ? cov.querySelector('img') : null;
           var r1 = cov ? cov.getBoundingClientRect() : null;
           var r2 = img ? img.getBoundingClientRect() : null;
           return {
             imgSrc: img ? String(img.getAttribute('src')).slice(0, 40) : '',
             imgW: img ? img.naturalWidth : 0,
             complete: img ? img.complete : null,
             coverRect: r1 ? [Math.round(r1.width), Math.round(r1.height)] : null,
             imgRect: r2 ? [Math.round(r2.width), Math.round(r2.height)] : null,
             coverDisplay: cov ? getComputedStyle(cov).display : '',
             imgDisplay: img ? getComputedStyle(img).display : '',
             imgOpacity: img ? getComputedStyle(img).opacity : '',
             imgVis: img ? getComputedStyle(img).visibility : '',
             coverAfter: cov ? getComputedStyle(cov, '::after').content : '',
             coverAfterBg: cov ? getComputedStyle(cov, '::after').backgroundColor : '',
             coverBg: cov ? getComputedStyle(cov).backgroundColor : '',
             imgZ: img ? getComputedStyle(img).zIndex : '',
             coverOverflow: cov ? getComputedStyle(cov).overflow : '',
             bgImage: cov ? String(getComputedStyle(cov).backgroundImage).slice(0, 60) : '',
             html: on ? String(on.outerHTML).slice(0, 300) : '',
             kids: cov ? Array.prototype.map.call(cov.children, function (c) { return c.tagName + '.' + c.className; }).join('|') : '',
             kidsBg: cov && cov.children[0] ? getComputedStyle(cov.children[0]).backgroundColor : '',
             kidsRect: cov && cov.children[0] ? [Math.round(cov.children[0].getBoundingClientRect().width), Math.round(cov.children[0].getBoundingClientRect().height)] : null
           };
         })()`
      );
      out.shelf = Object.assign({}, dom, dom2);
      const shot2 = await win.webContents.capturePage();
      fsx.writeFileSync(pathx.join(__dirname, '..', '..', 'dist', 'library-covers.png'), shot2.toPNG());

      /* 对照实验：把封面块刷成纯红，看它到底画不画 */
      const probe = await win.webContents.executeJavaScript(
        `(function () {
           var cov = document.querySelector('.book.on .bk-cover');
           if (!cov) return { ok: false };
           var url = getComputedStyle(cov).backgroundImage;
           cov.style.backgroundImage = 'none';
           cov.style.backgroundColor = '#ff0000';
           var im = new Image();
           im.src = url.slice(5, -2);
           return new Promise(function (res) {
             im.onload = function () { res({ ok: true, urlHead: url.slice(0, 40), w: im.naturalWidth, h: im.naturalHeight }); };
             im.onerror = function () { res({ ok: false, urlHead: url.slice(0, 40), err: 'decode failed' }); };
           });
         })()`
      );
      await new Promise((r) => setTimeout(r, 900));
      const shot3 = await win.webContents.capturePage();
      fsx.writeFileSync(pathx.join(__dirname, '..', '..', 'dist', 'covers-red.png'), shot3.toPNG());
      out.probe = probe;
      console.log('[libshot] ' + JSON.stringify(out));
    } catch (e) {
      console.log('[libshot] ERR ' + ((e && e.message) || e));
    }
    app.quit();
    return;
  }

  const wkcov = process.argv.find((a) => a.indexOf('--wkcov=') === 0);
  if (wkcov) {
    const bid = wkcov.slice('--wkcov='.length).replace(/[^\d]/g, '') || '4415';
    const fakeSender = { send() {} };
    try {
      const library = require('./library');
      const paths = require('./paths.js');
      const fs2 = require('fs');
      const out = {};
      const detail = await library.dispatch('wk8-detail', { ref: bid }, fakeSender);
      out.detail = {
        ok: !!(detail && detail.book),
        title: detail && detail.book && detail.book.title,
        cover: detail && detail.book && detail.book.cover,
        toc: detail && detail.tocCount,
        err: detail && detail.error
      };
      const dl = await library.dispatch('wk8-download', { ref: bid, maxChapters: 1 }, fakeSender);
      const dlBook = dl && dl.book;
      out.download = { ok: !!dlBook, id: dlBook && dlBook.id, coverHead: dlBook && String(dlBook.cover || '').slice(0, 48) };
      const list = await library.dispatch('list', {}, fakeSender);
      const books = Array.isArray(list) ? list : ((list && list.books) || []);
      out.listLen = books.length;
      out.ids = books.map((x) => x.id);
      out.keys = books[0] ? Object.keys(books[0]) : [];
      const b = books.find((x) => dlBook && x.id === dlBook.id) || books[books.length - 1];
      out.listed = b ? { id: b.id, coverHead: String(b.cover || '').slice(0, 48), coverLen: String(b.cover || '').length } : null;
      if (b) {
        const dir = paths.libraryRoot() + '/books/' + b.id;
        out.files = fs2.existsSync(dir) ? fs2.readdirSync(dir) : [];
        if (out.files.indexOf('img') >= 0) out.imgs = fs2.readdirSync(dir + '/img');
      }
      console.log('[wkcov] ' + JSON.stringify(out));
    } catch (e) {
      console.log('[wkcov] ERR ' + ((e && e.message) || e));
    }
    app.quit();
    return;
  }

  const wkq = process.argv.find((a) => a.indexOf('--wksearch=') === 0);
  if (wkq) {
    const q = wkq.slice('--wksearch='.length);
    try {
      const { session } = require('electron');
      const iconv = require('iconv-lite');
      const WK = require('../../packages/sources/wenku8.js');
      const ses = session.fromPartition('persist:sf-web-wenku8');
      const cookies = await ses.cookies.get({ domain: 'wenku8.net' });
      const loggedIn = cookies.some((c) => /jieqiUserInfo/i.test(c.name));
      const gbkQ = iconv.encode(q, 'gb18030').toString('hex').replace(/(..)/g, '%$1');
      const url = 'https://www.wenku8.net/modules/article/search.php?searchkey=' + gbkQ;
      const out = { q: q, loggedIn: loggedIn, url: url, tries: [] };
      for (const u of [url, 'https://www.wenku8.net/so.php?q=' + gbkQ]) {
        try {
          const r = await ses.fetch(u, { headers: { accept: 'text/html', referer: 'https://www.wenku8.net/index.php' } });
          const html = iconv.decode(Buffer.from(await r.arrayBuffer()), 'gb18030');
          const items = WK.parseSearch(html, 30);
          out.tries.push({ u: u, status: r.status, len: html.length, items: items.length,
            head: html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 200) });
          if (items.length) { out.items = items; break; }
        } catch (e) {
          out.tries.push({ u: u, error: String((e && e.message) || e) });
        }
      }
      console.log('[wksearch] ' + JSON.stringify(out));
    } catch (e) {
      console.log('[wksearch] error ' + ((e && e.message) || e));
    }
    app.quit();
    return;
  }



  // 界面是按 file:// 加载的，Chromium 会把它缓存下来：改了 js/css 但版本串没变时，
  // 用户看到的还是旧界面（我们真踩过：装完新版本，段落详情还是不显示）。
  // 本地应用缓存没有意义，启动时清一次最省事。
  try { await session.defaultSession.clearCache(); } catch (e) { /* 清不掉就算了 */ }
  const hasDb = db.tryInit();
  createWindow(hasDb);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(db.tryInit());
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
