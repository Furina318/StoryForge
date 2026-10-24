'use strict';
/**
 * 书库 IPC（渲染进程 → 主进程）。
 *
 * 为什么要新增一条通道：渲染进程零 Node 权限（main.js:1-11 的设计约束），
 * 而"选文件、读任意磁盘、开 PDF 窗口、在资源管理器里定位"只有主进程能做。
 *
 * 分工：
 *   选文件 / 建书目录  → packages/library（纯函数，可单测）
 *   索引 / 目录 / 进度 → packages/store/sqlite.js（表 book / book_toc）
 *   开窗口 / 系统程序   → 这里 + pdfwin.js
 *
 * 一条硬规则：**不管什么格式，都要落成书架上一本书**。
 * 所以 import 逐个文件 try/catch，单个失败不影响其他，失败信息挂在结果里。
 */
const fs = require('node:fs');
const path = require('node:path');
const { app, dialog, shell } = require('electron');

const db = require('./db');
const pdfwin = require('./pdfwin');
const LIB = require('../../packages/library/index.js');
const paths = require('./paths.js');
const webwin = require('./webwin.js');
const SRC = require('../../packages/sources/index.js');
const WK = require('../../packages/sources/wenku8.js');
const iconv = require('iconv-lite');

const WK_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const WK_PARTITION = 'persist:sf-web-wenku8';

const WK_GAP_MS = 1600;          // 同一站点两次请求的最小间隔
const WK_CACHE_TTL = 10 * 60 * 1000;
const wkCache = new Map();       // url -> {status,text,via,at}
let wkLastAt = 0;

function wkSleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

let wkCoolUntil = 0;

async function wkGate() {
  const cool = wkCoolUntil - Date.now();
  if (cool > 0) await wkSleep(cool);
  const wait = Math.max(0, WK_GAP_MS - (Date.now() - wkLastAt));
  if (wait) await wkSleep(wait);
  wkLastAt = Date.now();
}

/** 搜索引擎只给了书号时，回书页把书名取回来；再按关键词过滤+排序。 */
async function enrichByTitle(items, q, maxFetch) {
  const kw = String(q || '').replace(/\s+/g, '');
  const bigrams = [];
  for (let i = 0; i + 1 < kw.length; i += 1) bigrams.push(kw.slice(i, i + 2));
  const scored = [];
  let n = 0;
  for (const it of items) {
    let title = it.title && !/^书号\s*\d+$/.test(it.title) ? it.title : '';
    if (!title && n < maxFetch) {
      n += 1;
      try {
        const page = await wk8Http(WK.bookUrl(it.bid));
        const b = WK.parseBook(page.text, it.bid);
        title = b.title || '';
        it.author = b.author || '';
        it.cover = b.cover || '';
      } catch (e) { /* 取不到就留书号 */ }
    }
    it.title = title || it.title;
    let score = 0;
    const t = String(it.title || '').replace(/\s+/g, '');
    bigrams.forEach((bg) => { if (t.indexOf(bg) >= 0) score += 1; });
    if (kw && t.indexOf(kw) >= 0) score += 5;
    if (!kw || score > 0) scored.push({ it: it, score: score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((x) => x.it);
}

/** 普通网页（UTF-8），给搜索引擎兜底用 */
async function fetchText(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20000);
  try {
    const r = await fetch(url, {
      headers: { 'user-agent': WK_UA, accept: 'text/html,application/xhtml+xml', 'accept-language': 'zh-CN,zh;q=0.9' },
      signal: ac.signal,
      redirect: 'follow'
    });
    const text = await r.text();
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return { status: r.status, text: text };
  } finally {
    clearTimeout(timer);
  }
}

/** 抓一页 wenku8（GBK），优先用内嵌窗口那个会话，好复用 cf_clearance。
 *  外面套 wk8Http：节流 + 429/403 退避重试 + 内存缓存。 */
async function wk8Once(url) {
  /* 0) 内嵌窗口开着时，优先用它自己的网络栈取（带真实 Cookie / cf_clearance）。
   *    注意：executeJavaScript 里的 fetch 可能永远不 settle（页面空白/挑战页/被挂起），
   *    所以这里必须自己兜一个超时，否则会把整本下载挂死在 0/N。 */
  if (webwin.isOpen()) {
    try {
      const wf = await Promise.race([
        webwin.fetchInPage(url),
        new Promise((_, rej) => setTimeout(() => rej(new Error('页面取数超时（12s）')), 12000))
      ]);
      if (wf && wf.ok && wf.buf && wf.buf.length > 200) {
        const t = iconv.decode(wf.buf, 'gb18030');
        if (t && !/Just a moment\.\.\./i.test(t.slice(0, 400))) {
          return { status: wf.status, text: t, via: 'webwin' };
        }
      }
    } catch (e) { /* 超时或取不到，走下面的普通路径 */ }
  }
  const { session } = require('electron');
  let lastErr = null;
  try {
    const ses = session.fromPartition(WK_PARTITION);
    const ac1 = new AbortController();
    const t1 = setTimeout(() => ac1.abort(), 15000);
    let r;
    try {
      r = await ses.fetch(url, { method: 'GET', headers: { accept: 'text/html,application/xhtml+xml' }, signal: ac1.signal });
    } finally {
      clearTimeout(t1);
    }
    const buf = Buffer.from(await r.arrayBuffer());
    const text = iconv.decode(buf, 'gb18030');
    if (r.ok && text && !/Just a moment\.\.\./i.test(text.slice(0, 400))) {
      return { status: r.status, text: text, via: 'session' };
    }
    lastErr = new Error('session 请求返回 ' + r.status + (r.ok ? '（被 Cloudflare 拦了）' : ''));
  } catch (e) {
    lastErr = e;
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20000);
  try {
    const r = await fetch(url, {
      headers: { 'user-agent': WK_UA, accept: 'text/html,application/xhtml+xml', 'accept-language': 'zh-CN,zh;q=0.9' },
      signal: ac.signal,
      redirect: 'follow'
    });
    const text = iconv.decode(Buffer.from(await r.arrayBuffer()), 'gb18030');
    if (!r.ok) throw new Error('HTTP ' + r.status + (lastErr ? '（session 那边也不行：' + lastErr.message + '）' : ''));
    if (/Just a moment\.\.\./i.test(text.slice(0, 400))) {
      throw new Error('被 Cloudflare 拦了：先在「在窗口里打开站点」里过一次验证，再回来重试');
    }
    return { status: r.status, text: text, via: 'fetch' };
  } finally {
    clearTimeout(timer);
  }
}

/* 封面图抓成 data URL：外链在渲染进程里常被防盗链挡，存 URL 等于没封面。 */
async function coverToDataUrl(url) {
  const u = String(url || '');
  if (!u) return '';
  if (/^data:/i.test(u)) return u;
  if (!/^https?:/i.test(u)) return u;
  try {
    let buf = null;
    const r = await webwin.fetchInPage(u, { referer: 'https://www.wenku8.net/' });
    if (r && r.ok && r.buf && r.buf.length) buf = r.buf;
    if (!buf) {
      const { session } = require('electron');
      const ses = session.fromPartition(WK_PARTITION);
      const g = await ses.fetch(u, { headers: { referer: 'https://www.wenku8.net/' } });
      if (g && g.ok) buf = Buffer.from(await g.arrayBuffer());
    }
    if (!buf || !buf.length || buf.length > 3 * 1024 * 1024) return '';
    const h = buf.slice(0, 4);
    let mime = 'image/jpeg';
    if (h[0] === 0x89 && h[1] === 0x50) mime = 'image/png';
    else if (h[0] === 0x47 && h[1] === 0x49) mime = 'image/gif';
    else if (h[0] === 0x52 && h[1] === 0x49) mime = 'image/webp';
    return 'data:' + mime + ';base64,' + buf.toString('base64');
  } catch (e) { return ''; }
}

async function wk8Http(url, opts) {
  const useCache = !opts || opts.cache !== false;
  if (useCache) {
    const hit = wkCache.get(url);
    if (hit && Date.now() - hit.at < WK_CACHE_TTL) return hit;
  }
  let lastErr = null;
  let blockedTimes = 0;
  for (let i = 0; i < 4; i += 1) {
    await wkGate();
    try {
      const r = await wk8Once(url);
      if (r && r.blocked) {
        blockedTimes += 1;
        /* 被 Cloudflare 拦：第二次还拦就直接抛，别让整本下载一章一章地磨 */
        if (blockedTimes >= 2) {
          throw new Error('被 Cloudflare 拦了（页面停在验证页）：先在「登录」窗口里过一次验证，再回来点下载。');
        }
        await wkSleep(2000);
        continue;
      }
      if (useCache) {
        wkCache.set(url, Object.assign({ at: Date.now() }, r));
        while (wkCache.size > 60) wkCache.delete(wkCache.keys().next().value);
      }
      return r;
    } catch (e) {
      lastErr = e;
      const msg = String((e && e.message) || e);
      /* 只有被限流/被拦才值得再等一次；404 之类直接抛 */
      if (!/HTTP (429|403)/.test(msg) && !/Cloudflare/.test(msg)) throw e;
      wkCoolUntil = Math.max(wkCoolUntil, Date.now() + 25000);
      await wkSleep([3000, 6000, 10000, 15000][i] || 15000);
    }
  }
  throw lastErr || new Error('抓取失败：' + url);
}

/* 这一串只是把"常见的电子书/文本"排在前面，用户永远可以选"所有文件" */
const FILTERS = [
  { name: '电子书 / 文本', extensions: ['txt', 'text', 'md', 'markdown', 'pdf', 'log', 'html', 'htm', 'csv', 'nfo', 'rtf', 'epub', 'docx'] },
  { name: '所有文件', extensions: ['*'] }
];

function root() {
  return paths.libraryRoot();
}

function repo() {
  const r = db.getDb();
  if (!r) throw new Error('书库需要桌面数据库（当前是浏览器本地存储模式）');
  return r;
}

function emit(sender, msg) {
  try {
    if (sender && !sender.isDestroyed()) sender.send('sf:lib:event', msg);
  } catch (e) { /* 窗口没了就算了，进度下次打开还能读到 */ }
}

async function fetchBytes(url) {
  const { session } = require('electron');
  try {
    const ses = session.fromPartition(WK_PARTITION);
    const acImg = new AbortController();
    const tImg = setTimeout(() => acImg.abort(), 15000);
    let r;
    try {
      r = await ses.fetch(url, { method: 'GET', headers: { accept: 'image/*' }, signal: acImg.signal });
    } finally {
      clearTimeout(tImg);
    }
    if (r.ok) {
      const b = Buffer.from(await r.arrayBuffer());
      if (b.length) return b;
    }
  } catch (e) { /* 落到下面 */ }
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 20000);
  try {
    const r = await fetch(url, {
      headers: { 'user-agent': WK_UA, accept: 'image/*', referer: 'https://www.wenku8.net/' },
      signal: ac.signal
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return Buffer.from(await r.arrayBuffer());
  } finally { clearTimeout(t); }
}

function lastDir() {
  try {
    const d = db.metaGet('library.lastDir');
    if (d && fs.existsSync(d)) return d;
  } catch (e) { /* 数据库还没起来 */ }
  try { return app.getPath('documents'); } catch (e) { return app.getPath('home'); }
}

/** 导入一个文件：成功返回书，失败抛错（调用方逐条兜） */
function importOne(filePath) {
  const r = repo();
  const buf = fs.readFileSync(filePath);
  /* 同一份内容不重复入架：重复导入的常见原因是"我忘了已经导过"，
     真再建一本会得到两本各自独立的进度，反而难找。 */
  const hash = LIB.sha1(buf);
  const dup = r.listBooks().filter((b) => b.srcHash && b.srcHash === hash)[0];
  if (dup) return { book: bookWithChecks(dup), adapter: 'existing', candidates: [], duplicate: true };

  const res = LIB.importFile(LIB.ensureRoot(root()), filePath, { buf });
  const book = r.upsertBook(res.book);
  r.setToc(book.id, res.toc || []);
  return { book: bookWithChecks(book), adapter: res.adapter, candidates: res.candidates };
}

function loadSection(book, ord) {
  const n = Math.max(0, Math.min(Number(ord) || 0, Math.max(0, (book.sectionCount || 1) - 1)));
  if (!book.sectionCount) return null;
  return LIB.readSection(root(), book.id, n);
}

function bookWithChecks(book) {
  const b = book || {};
  const out = Object.assign({}, b);
  out.srcMissing = !!(b.srcPath && !fs.existsSync(b.srcPath));
  /* 历史坏行可能没有 id（早年导入失败留下的半行），别让整个 list 崩掉 */
  out.dir = b.id ? LIB.bookDir(root(), b.id) : '';
  out.broken = !b.id;
  return out;
}

/**
 * @param {string} op
 * @param {object} payload
 * @param {object} sender  渲染进程的 webContents（用来推 PDF 页码事件）
 */
async function dispatch(op, payload, sender) {
  const p = payload || {};
  switch (op) {
    /* ---- 选文件：只选，不读。返回路径列表，由 UI 逐个调 import ---- */
    case 'pick': {
      const r = await dialog.showOpenDialog({
        title: '导入到书架',
        buttonLabel: '导入',
        properties: ['openFile', 'multiSelections'],
        filters: FILTERS,
        defaultPath: lastDir()
      });
      if (r.canceled || !r.filePaths.length) return { canceled: true, paths: [] };
      try { db.metaSet('library.lastDir', path.dirname(r.filePaths[0])); } catch (e) { /* 记不住目录不算错 */ }
      return { canceled: false, paths: r.filePaths };
    }

    case 'import': {
      const files = Array.isArray(p.paths) ? p.paths : (p.path ? [p.path] : []);
      const added = [];
      const failed = [];
      files.forEach((f) => {
        try {
          added.push(importOne(f));
        } catch (e) {
          failed.push({ file: f, error: String((e && e.message) || e) });
        }
      });
      return { ok: added.length > 0, added, failed };
    }

    /* 早期导入的 epub 没存封面：从 books/<id>/img/_cover.* 或 i1.* 里补一次，
       只补空的、找不到就算了。 */
    function repairCovers(books) {
      try {
        const fsx = require('node:fs');
        const pathx = require('node:path');
        const rootDir = root();
        let n = 0;
        (books || []).forEach((b) => {
          /* 空 cover、或者存着"不存在的本地路径 / 过期的图片名"，都算坏掉，要修 */
          const cur = String(b.cover || '');
          if (cur && (/^data:/i.test(cur) || /^https?:/i.test(cur))) return;
          if (cur && fsx.existsSync(cur)) return;
          const imgDir = pathx.join(rootDir, 'books', b.id, 'img');
          let pick = '';
          try {
            const names = fsx.readdirSync(imgDir);
            pick =
              names.filter((x) => /^_cover\./i.test(x))[0] ||
              names.filter((x) => /^i?1\.(jpe?g|png|gif|webp)$/i.test(x))[0] ||
              '';
          } catch (e) { /* 没有 img 目录 */ }
          if (!pick) return;
          try {
            repo().upsertBook(Object.assign({}, b, { cover: pathx.join(imgDir, pick) }));
            n += 1;
          } catch (e) { /* 单本失败不影响别的 */ }
        });
        return n;
      } catch (e) {
        return 0;
      }
    }

        /* 补插图：把"已下载但正文里还是占位/链接"的书修一遍。
       实现要点：原位能换就原位换；换不了的收进末尾「插图」一节，保证正文顺序不乱。 */
    /* ---------------- 书架：列 / 取 / 开 / 读节 / 记进度 / 偏好 / 定位 ---------------- */
    case 'list': {
      const books = repo().listBooks() || [];
      repairCovers(books.filter(function (b) { return b && b.id; }));
      return (repo().listBooks() || []).filter(function (b) { return b && b.id; }).map(bookWithChecks);
    }

    case 'get': {
      const b = repo().getBook(p.id);
      if (!b) throw new Error('这本书不在书架上');
      return bookWithChecks(b);
    }

    case 'open': {
      const b = repo().getBook(p.id);
      if (!b) throw new Error('这本书不在书架上');
      const toc = [];
      const total = b.sectionCount || 0;
      for (let i = 0; i < total; i += 1) {
        let title = '第 ' + (i + 1) + ' 节';
        try {
          const sec = LIB.readSection(root(), b.id, i);
          if (sec && sec.title) title = sec.title;
        } catch (e) { /* 单节读不出来不影响目录 */ }
        toc.push({ ord: i, title: title });
      }
      return { book: bookWithChecks(b), toc: toc };
    }

    case 'section': {
      const b = repo().getBook(p.id);
      if (!b) throw new Error('这本书不在书架上');
      return loadSection(b, p.ord);
    }

    case 'progress': {
      repo().saveProgress(p.id, Number(p.ord) || 0, Number(p.blk) || 0);
      return { ok: true };
    }

    case 'prefs': {
      const b = repo().getBook(p.id);
      if (!b) throw new Error('这本书不在书架上');
      repo().upsertBook(Object.assign({}, b, { prefs: p.prefs || {} }));
      return { ok: true };
    }

    case 'reveal': {
      const b = repo().getBook(p.id);
      if (!b) throw new Error('这本书不在书架上');
      if (b.srcPath && fs.existsSync(b.srcPath)) shell.showItemInFolder(b.srcPath);
      else shell.openPath(LIB.bookDir(root(), b.id));
      return { ok: true };
    }

    /* ---------------- wenku8：详情 / 读章 / 书单 / 搜索 / 登录 ---------------- */
    case 'wk8-detail': {
      const bid = WK.parseRef(p.ref);
      if (!bid) throw new Error('看不懂这个书号或链接（支持 3057 / book/3057.htm / 完整链接）');
      await webwin.ensureOpen('wenku8');
      const info = WK.parseBook((await wk8Http(WK.bookUrl(bid.bid))).text, bid.bid);
      let toc = [];
      let tocError = '';
      try {
        const type = info.tocType != null ? info.tocType : bid.type;
        const tocUrl = info.tocPath
          ? (/^https?:/i.test(info.tocPath) ? info.tocPath : WK.BASE + info.tocPath)
          : WK.tocUrl(bid.bid, type);
        toc = WK.parseToc((await wk8Http(tocUrl)).text, bid.bid, type);
      } catch (e) {
        tocError = String((e && e.message) || e);
      }
      return { ok: true, book: Object.assign({ bid: bid.bid }, info), toc: toc, tocCount: toc.length, tocError: tocError };
    }

    case 'wk8-chapter': {
      const url = String(p.url || '');
      if (!/^https?:\/\//i.test(url)) throw new Error('章地址不对');
      const r = await wk8Http(url);
      const ch = WK.parseChapter(r.text);
      return { ok: true, url: url, title: p.title || (ch && ch.title) || '', blocks: (ch && ch.blocks) || [] };
    }

    case 'wk8-listing': {
      const kind = String(p.kind || 'all');
      const page = Math.max(1, Number(p.page) || 1);
      const alpha = String(p.alpha || 'A').slice(0, 1).toUpperCase();
      let url;
      if (kind === 'alpha') url = 'https://www.wenku8.net/modules/article/alpha.php?alpha=' + encodeURIComponent(alpha) + '&page=' + page;
      else if (kind === 'top') url = 'https://www.wenku8.net/modules/article/toplist.php?sort=allvisit&page=' + page;
      else url = 'https://www.wenku8.net/modules/article/articlelist.php?page=' + page;
      await webwin.ensureOpen('wenku8');
      const r = await wk8Http(url);
      const html = r.text || '';
      const items = WK.parseListing(html, Number(p.limit) || 60) || [];
      const login = /请先登录|login\.php|Just a moment/i.test(html.slice(0, 3000));
      let dump = '';
      try {
        if (!items.length) {
          const dbg = path.join(paths.dataRoot(), 'debug');
          fs.mkdirSync(dbg, { recursive: true });
          dump = path.join(dbg, 'wk-list-' + kind + '-' + Date.now() + '.html');
          fs.writeFileSync(dump, html);
        }
      } catch (e) { /* 存不下不影响返回 */ }
      const hasNext = new RegExp('href="[^"]*page=' + (page + 1) + '"').test(html) && items.length > 0;
      return {
        ok: items.length > 0,
        items: items,
        page: page,
        hasNext: hasNext,
        needLogin: login && !items.length,
        error: items.length ? '' : (login ? '这一页要登录：先点「登录」在窗口里登一次' : '这一页没解析出书'),
        diag: { kind: kind, page: page, url: url, bytes: html.length, login: login, dump: dump }
      };
    }

    case 'wk8-search': {
      const q = String(p.q || '').trim();
      if (!q) throw new Error('先输入书名或作者');
      const by = p.by === 'author' ? 'author' : 'title';
      const limit = Number(p.limit) || 30;
      await webwin.ensureOpen('wenku8');
      let html = '';
      let url = '';
      let note = '';
      try {
        if (by === 'author') {
          url = 'https://www.wenku8.net/modules/article/authorarticle.php?author=' + encodeURIComponent(q);
        } else {
          url = 'https://www.wenku8.net/modules/article/search.php?searchtype=articlename&searchkey=' + encodeURIComponent(q);
        }
        const r = await wk8Http(url);
        html = r.text || '';
      } catch (e) {
        note = String((e && e.message) || e);
      }
      let items = WK.parseSearch(html || '', limit) || [];
      if (!items.length && /请先登录|login\.php/i.test((html || '').slice(0, 3000))) {
        /* 站内搜索要登录时，退到真窗口提交表单 */
        try {
          const win = await webwin.searchInWindow('wenku8', q);
          if (win && win.html) {
            html = win.html;
            items = WK.parseSearch(html, limit) || [];
            note = note || '（改走窗口内搜索）';
          }
        } catch (e) { note = note || String((e && e.message) || e); }
      }
      const login = /请先登录|login\.php|Just a moment/i.test((html || '').slice(0, 3000));
      return {
        ok: items.length > 0,
        items: items,
        by: by,
        needLogin: login && !items.length,
        error: items.length ? '' : (login ? '这次搜索要登录：先点「登录」在窗口里登一次，再回来搜' : '没有搜到（换个书名/作者，或者粘书号/链接直接打开）'),
        note: note,
        diag: { url: url, bytes: (html || '').length, login: login }
      };
    }

    case 'wk8-login': {
      const r = await webwin.openLogin('wenku8');
      return r || { ok: true };
    }

    case 'wk8-session': {
      return webwin.sessionState('wenku8');
    }

    /* ---------------- 联网书源 ---------------- */
    case 'src-providers': return SRC.list();

    case 'src-search': {
      if (!p.provider) throw new Error('先选一个书源');
      return SRC.search(p.provider, p.q);
    }

    case 'src-open': {
      const u = String(p.url || '');
      if (!/^https?:/i.test(u)) throw new Error('不是 http(s) 链接');
      await shell.openExternal(u);
      return { ok: true };
    }

    case 'src-download': {
      const r = await SRC.download(p.provider, p.item);
      const safe = SRC.safeName((r && r.name) || 'book.txt');
      const tmp = path.join(app.getPath('temp'), 'storyforge-src-' + Date.now() + '-' + safe);
      fs.writeFileSync(tmp, r.buf);
      try {
        const b = importOne(tmp);
        const b2 = Object.assign({}, b, {
          srcPath: '',
          srcName: '联网下载 · ' + (b.srcName || safe)
        });
        repo().upsertBook(b2);
        return { ok: true, book: b2 };
      } finally {
        try { fs.unlinkSync(tmp); } catch (e) { /* 删不掉不算错 */ }
      }
    }

    case 'web-open': {
      await webwin.open(p.source || 'wenku8', p.q || '');
      return { ok: true };
    }

    case 'web-grab': {
      return webwin.grab(Number(p.limit) || 20);
    }

    case 'web-close': {
      webwin.close();
      return { ok: true };
    }

    /* ---------------- wenku8 内容窗口 ---------------- */
    case 'repair-images': {
      /* 把正文里遗留的 @@WKIMG:url@@ / ![图片](url) 换成真图片块。
         原则：只改段落，不新增章节、不动目录 —— 之前追加「插图」一节把目录顺序弄乱了。 */
      const list = repo().listBooks();
      const book = (list || []).find(function (b) { return b.id === p.id; }) || null;
      if (!book) throw new Error('找不到这本书');
      const dir = path.join(paths.libraryRoot(), 'books', book.id);
      const secDir = path.join(dir, 'sec');
      const imgDir = path.join(dir, 'img');
      fs.mkdirSync(imgDir, { recursive: true });
      const all = fs.readdirSync(secDir).filter(function (f) { return /^\d+\.json$/.test(f); });
      /* 必须按数字排序：readdir 会给 10.json 排在 2.json 前面 */
      all.sort(function (a, b) { return parseInt(a, 10) - parseInt(b, 10); });
      const cap = book.sectionCount || all.length;
      /* 历史上被追加的多余节（ord >= sectionCount）直接删掉，恢复"目录 = 节"的对应 */
      all.forEach(function (f) {
        const ord = parseInt(f, 10);
        if (ord >= cap) { try { fs.unlinkSync(path.join(secDir, f)); } catch (e) { /* 忽略 */ } }
      });
      const files = all.filter(function (f) { return parseInt(f, 10) < cap; });

      const extOf = function (u, buf) {
        if (buf && buf.length > 12) {
          if (buf[0] === 0xff && buf[1] === 0xd8) return '.jpg';
          if (buf[0] === 0x89 && buf[1] === 0x50) return '.png';
          if (buf.slice(0, 3).toString() === 'GIF') return '.gif';
          if (buf.slice(8, 12).toString() === 'WEBP') return '.webp';
        }
        const m = String(u).match(/\.(jpe?g|png|gif|webp)(?:\?|$)/i);
        return m ? '.' + m[1].toLowerCase().replace('jpeg', 'jpg') : '.jpg';
      };

      let inline = 0;
      let failed = 0;
      let residue = 0;
      for (const f of files) {
        const fp = path.join(secDir, f);
        let sec;
        try { sec = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (e) { continue; }
        const ord = sec.ord != null ? sec.ord : parseInt(f, 10);
        const out = [];
        let dirty = false;
        let n = 0;
        for (const b of (sec.blocks || [])) {
          const t = String(b.text || '');
          /* 只剩一个残缺的 ![图片]( 行：整行丢掉，别留在正文里 */
          if (/^\s*!\[图片\]\(?\s*$/.test(t)) { dirty = true; residue += 1; continue; }
          /* 早前补丁把提示串写成了乱码（锛? / 鎻掑浘 之类）：这种残行也丢掉 */
          if (/锛|鎻|鍥剧|銆|榻愬/.test(t)) { dirty = true; residue += 1; continue; }
          const m = t.match(/^@@WKIMG:(https?:\/\/[^@\s]+)@@$/) || t.match(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/);
          if (!m) { out.push(b); continue; }
          n += 1;
          try {
            const buf = await fetchBytes(m[1]);
            if (!buf || !buf.length) throw new Error('空文件');
            const name = 'wk_' + ord + '_' + n + extOf(m[1], buf);
            fs.writeFileSync(path.join(imgDir, name), buf);
            out.push({ kind: 'img', src: name, text: '' });
            inline += 1;
            dirty = true;
          } catch (e) {
            /* 抓不到：原样保留这一行（用户至少还看得见地址），不算正文损坏 */
            out.push({ kind: 'para', text: '（这张插图没抓到：' + String((e && e.message) || e) + '）' });
            failed += 1;
            dirty = true;
          }
        }
        if (dirty) {
          sec.blocks = out;
          fs.writeFileSync(fp, JSON.stringify(sec));
        }
      }
      return { ok: true, inline: inline, failed: failed, residue: residue, sections: files.length, appended: 0 };
    }

    case 'wk8-update': {
      let book = null;
      let bid = null;
      if (p.id) {
        const list = repo().listBooks();
        book = (list || []).find(function (b) { return b.id === p.id; }) || null;
        bid = WK.parseRef((book && (book.srcUrl || '')) || '') || WK.parseRef(p.ref || '');
      } else if (p.ref) {
        bid = WK.parseRef(p.ref);
      }
      if (!bid) throw new Error('这本书没有记录来源书号：联网下载的书从这一版起会记下书号，重新下载一次就能用「检查更新」。');
      await webwin.ensureOpen('wenku8');
      emit(p.sender, { type: 'wk8-stage', stage: 'book', detail: '读书籍页' });
      const info = WK.parseBook((await wk8Http(WK.bookUrl(bid.bid))).text, bid.bid);
      const type = info.tocType != null ? info.tocType : bid.type;
      const tocUrl = info.tocPath
        ? (/^https?:/i.test(info.tocPath) ? info.tocPath : WK.BASE + info.tocPath)
        : WK.tocUrl(bid.bid, type);
      emit(p.sender, { type: 'wk8-stage', stage: 'toc', detail: '读目录' });
      const toc = WK.parseToc((await wk8Http(tocUrl)).text, bid.bid, type);
      const local = book ? (book.sectionCount || 0) : 0;
      const added = Math.max(0, toc.length - local);
      const base = { ok: true, title: info.title, remote: toc.length, local: local, added: added };
      if (!p.apply || !added || !book) return base;

      const secDir = path.join(paths.libraryRoot(), 'books', book.id, 'sec');
      fs.mkdirSync(secDir, { recursive: true });
      const slice = toc.slice(local);
      emit(p.sender, { type: 'wk8-stage', stage: 'chapters', detail: '新增 ' + slice.length + ' 章，开始抓' });
      const list = await WK.fetchAll(slice, async (url) => (await wk8Http(url)).text, {
        delayMs: 0,
        onProgress: (done, total) => emit(p.sender, { type: 'wk8-progress', done: done, total: total })
      });
      let written = 0;
      let chars = book.chars || 0;
      list.forEach(function (c, i) {
        const ord = local + i;
        const blocks = (c.blocks || []).map(function (x) {
          const t = String(x || '');
          if (/^@@WKIMG:/.test(t)) return { kind: 'para', text: '（插图：重新下载整本才会带图）' };
          return { kind: 'para', text: t };
        });
        fs.writeFileSync(path.join(secDir, ord + '.json'), JSON.stringify({ ord: ord, title: c.title, blocks: blocks }));
        blocks.forEach(function (b) { chars += (b.text || '').length; });
        written += 1;
      });
      repo().upsertBook(Object.assign({}, book, {
        sectionCount: local + written,
        chars: chars,
        updatedAt: new Date().toISOString()
      }));
      return Object.assign(base, { ok: true, written: written, sectionCount: local + written });
    }

    case 'wk8-download': {
      const ref = WK.parseRef(p.ref);
      if (!ref) throw new Error('看不出书号');
      await webwin.ensureOpen('wenku8');
      emit(p.sender, { type: 'wk8-stage', stage: 'book', detail: '读书籍页' });
      const bookHtml = await wk8Http(WK.bookUrl(ref.bid));
      const book = WK.parseBook(bookHtml.text, ref.bid);
      const type = book.tocType != null ? book.tocType : (p.type != null ? p.type : ref.type);
      const tocFull = book.tocPath
        ? (/^https?:/i.test(book.tocPath) ? book.tocPath : WK.BASE + book.tocPath)
        : WK.tocUrl(ref.bid, type);
      emit(p.sender, { type: 'wk8-stage', stage: 'toc', detail: '读目录' });
      const tocHtml = await wk8Http(tocFull);
      const toc = WK.parseToc(tocHtml.text, ref.bid, type);
      if (!toc.length) throw new Error('目录是空的（可能要登录，或者这个书号不存在）');
      emit(p.sender, { type: 'wk8-stage', stage: 'chapters', detail: '共 ' + toc.length + ' 章，开始抓正文' });
      const max = p.maxChapters > 0 ? Math.min(Number(p.maxChapters), 500) : Math.min(toc.length, 500);
      const failures = [];
      let failStreak = 0;
      const chapters = await WK.fetchAll(toc.slice(0, max), async (url, item) => {
        try {
          const r0 = await wk8Http(url);
          failStreak = 0;
          return r0.text;
        } catch (e) {
          failures.push({ title: (item && item.title) || url, why: String((e && e.message) || e) });
          failStreak += 1;
          const why = String((e && e.message) || e);
          if (/Cloudflare|被拦/.test(why)) {
            throw new Error('被 Cloudflare 拦了：先用「登录」在窗口里过一次验证，再回来点下载。');
          }
          if (failStreak >= 3) {
            throw new Error('连续 3 章被抓站点拒绝（多半是没登录 / 被限流），已停下。等一分钟或先过一次验证再试。');
          }
          return '';
        }
      }, {
        /* wk8Http 里已经有 1.6 秒的全局节流，这里再加 1.4 秒就是双份等待：
           234 章会被拖到 11 分钟以上，所以这里不再额外 sleep。 */
        delayMs: 0,
        onProgress: (done, total) => emit(p.sender, { type: 'wk8-progress', done: done, total: total })
      });
      const gotBody = chapters.filter(function (c) { return c.blocks && c.blocks.length; }).length;
      if (!gotBody) {
        throw new Error('一章正文都没抓到（站点在限流，HTTP 429）。等 1 分钟再点一次下载；连续失败就先用「登录」在窗口里打开一次站点。');
      }
      emit(p.sender, { type: 'wk8-stage', stage: 'write', done: 0, total: chapters.length });
      const txt = WK.toTxt(book, chapters);
      const tmp = path.join(app.getPath('temp'), 'storyforge-wk8-' + Date.now() + '.txt');
      fs.writeFileSync(tmp, txt, 'utf8');
      try {
        const out = importOne(tmp);
        /* 用内存里的章节块整段重写 sec/<ord>.json：
           不再依赖 txt 里的文本形态，图片当场抓、当场落盘 */
        if (out && out.book) {
          try {
            const bdir = path.join(paths.libraryRoot(), 'books', out.book.id);
            const imgDir = path.join(bdir, 'img');
            let saved = 0;
            emit(p.sender, { type: 'wk8-stage', stage: 'images', done: 0, total: chapters.length });
            for (let ord = 0; ord < chapters.length; ord += 1) {
              const ch = chapters[ord] || {};
              const blocks = [];
              let n = 0;
              if (ord % 10 === 0) {
                emit(p.sender, { type: 'wk8-stage', stage: 'images', done: ord, total: chapters.length });
              }
              for (const raw of (ch.blocks || [])) {
                const tx = String(raw == null ? '' : raw);
                const mm = tx.match(/^@@WKIMG:(https?:\/\/[^@\s]+)@@$/i);
                if (!mm) {
                  if (tx.trim()) blocks.push({ kind: 'para', text: tx });
                  continue;
                }
                try {
                  const bytes = await fetchBytes(mm[1]);
                  if (!bytes || !bytes.length) {
                    blocks.push({ kind: 'para', text: '（插图没抓到，可能被防盗链挡了）' });
                    continue;
                  }
                  fs.mkdirSync(imgDir, { recursive: true });
                  const ext = (mm[1].split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 4) || 'jpg';
                  n += 1;
                  saved += 1;
                  const name = 'wk_' + String(ord + 1).padStart(3, '0') + '_' + n + '.' + ext;
                  fs.writeFileSync(path.join(imgDir, name), bytes);
                  blocks.push({ kind: 'img', src: name, text: '' });
                } catch (e) {
                  blocks.push({ kind: 'para', text: '（插图没抓到：' + ((e && e.message) || e) + '）' });
                }
              }
              const secFile = path.join(bdir, 'sec', ord + '.json');
              fs.writeFileSync(secFile, JSON.stringify({
                ord: ord,
                title: ch.title || ('第 ' + (ord + 1) + ' 章'),
                blocks: blocks
              }), 'utf8');
            }
            out.images = saved;
          } catch (e) { /* 图片是加分项，失败不影响正文 */ }
        }
        if (out && out.book) {
          const r = repo();
          const b = r.getBook(out.book.id);
          if (b) {
            let cv = book.cover || b.cover || '';
            if (cv && /^https?:/i.test(cv)) {
              const local = await coverToDataUrl(cv);
              if (local) cv = local;
            }
            r.upsertBook(Object.assign({}, b, {
              srcPath: '',
              srcUrl: 'https://www.wenku8.net/book/' + ref.bid + '.htm',
              srcName: 'wenku8 · ' + book.title,
              title: book.title, author: book.author || '', cover: cv
            }));
            out.book = bookWithChecks(r.getBook(out.book.id));
          }
        }
        return Object.assign({}, out, { chapters: chapters.length, truncated: toc.length > max, totalChapters: toc.length, failed: failures.length, failures: failures.slice(0, 8) });
      } finally {
        try { fs.unlinkSync(tmp); } catch (e) { /* 删不掉不影响结果 */ }
      }
    }

    case 'open-external': {
      const b = repo().getBook(p.id);
      if (!b) throw new Error('这本书不在书架上了');
      if (!b.srcPath || !fs.existsSync(b.srcPath)) throw new Error('源文件不在了：' + (b.srcPath || '(从未落盘)'));
      const err = await shell.openPath(b.srcPath);
      if (err) throw new Error('系统没有能打开这个文件的东西：' + err);
      return { ok: true };
    }

    /* ---- PDF 原版打开：独立窗口，页码通过 sf:lib:event 推回来 ---- */
    case 'open-pdf': {
      const b = repo().getBook(p.id);
      if (!b) throw new Error('这本书不在书架上了');
      if (!b.srcPath || !fs.existsSync(b.srcPath)) throw new Error('源文件不在了：' + (b.srcPath || ''));
      const page = p.page || b.progressOrd || 1;
      return pdfwin.open({
        bookId: b.id,
        file: b.srcPath,
        title: b.title,
        page,
        onEvent: (msg) => {
          if (msg.type === 'pdf-page' || msg.type === 'pdf-closed') {
            try { repo().saveProgress(b.id, msg.page, 0); } catch (e) { /* 库不可用就只丢进度 */ }
          }
          emit(sender, msg);
        }
      });
    }

    case 'remove': {
      const r = repo();
      const b = r.getBook(p.id);
      r.removeBook(p.id);
      if (b) LIB.removeBook(root(), b.id);
      return { ok: true };
    }

    /* ---- 换编码重读（乱码时唯一的补救） ---- */
    case 'reparse': {
      const r = repo();
      const b = r.getBook(p.id);
      if (!b) throw new Error('这本书不在书架上了');
      if (!b.srcPath || !fs.existsSync(b.srcPath)) throw new Error('源文件不在了，没法重读');
      const res = LIB.reparse(root(), b, b.srcPath, p.encoding);
      const book = r.upsertBook(res.book);
      r.setToc(book.id, res.toc || []);
      return { ok: true, book: bookWithChecks(book), toc: r.listToc(book.id) };
    }

    /* ---- 给内嵌 reader 用：PDF 原始字节 + pdf.js 的 worker 源码 ----
       worker 为什么走 IPC 而不是 <script> 直接引：渲染进程是 file:// origin null，
       Worker 从 file:// 加载会被同源策略挡掉；主进程读出来、渲染进程做成 blob URL 就绕开了。 */
    case 'bytes': {
      const b = repo().getBook(p.id);
      if (!b || !b.srcPath) throw new Error('这本书没有源文件（网页书请在应用内读）');
      if (!fs.existsSync(b.srcPath)) throw new Error('源文件不在了：' + b.srcPath);
      const st = fs.statSync(b.srcPath);
      if (st.size > 200 * 1024 * 1024) throw new Error('文件太大，超过 200MB 不内嵌渲染');
      return { bytes: new Uint8Array(fs.readFileSync(b.srcPath)), size: st.size };
    }

    case 'pdf-worker': {
      const f = path.join(__dirname, '..', 'ui', 'vendor', 'pdf.worker.min.js');
      if (!fs.existsSync(f)) throw new Error('没找到 pdf.js 的 worker 文件：' + f);
      return { code: fs.readFileSync(f, 'utf8') };
    }

    /* ---- 摘录 / 笔记（P1 才接 UI，先把口子留好） ---- */
    case 'marks':
      return repo().listMarks(p.id);
    case 'mark-add':
      repo().saveMark(p.mark || {});
      return { ok: true };

    /* ---- 书源（P2）：只暴露接口，不做搜索/抓取 ---- */
    case 'sources':
      return repo().listSources();
    case 'source-save':
      repo().upsertSource(p.source || {});
      return { ok: true };
    case 'source-remove':
      repo().removeSource(p.id);
      return { ok: true };

    default:
      throw new Error('未知的书库操作：' + op);
  }
}

module.exports = { dispatch, root, closeAll: () => pdfwin.closeAll() };
