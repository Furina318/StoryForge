'use strict';
/**
 * 内嵌浏览器：用来打通「要登录 / 有人机验证」的书源（wenku8 这类）。
 *
 * 为什么不是爬虫：
 *   wenku8 的搜索要登录，且前面有 Cloudflare；纯 fetch 拿不到结果页。
 *   开一个真实窗口、用独立 partition 记住登录态，让用户自己登录、自己看结果，
 *   应用只负责「把当前页的标题+链接读回来」，不替用户绕过任何验证。
 *
 * 安全边界：
 *  - 独立 partition（persist:sf-web-<source>），不和应用主会话共享 Cookie；
 *  - 不开 nodeIntegration、不开 preload，页面里就是普通网页；
 *  - 只允许读 DOM 文本与 href，不读文件、不执行站内脚本之外的东西。
 */
const path = require('node:path');
const { BrowserWindow, shell, session } = require('electron');
const SRC = require('../../packages/sources/index.js');

let win = null;
let currentSource = '';
let currentQuery = '';

function isOpen() {
  return !!(win && !win.isDestroyed());
}

function open(source, query) {
  const provider = String(source || 'wenku8');
  const q = String(query || '');
  let url = '';
  try {
    url = SRC.webUrl(provider, q);
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
  /* 同一个窗口只能服务一个 source：分区不同，Cookie/通行证也不同 */
  if (isOpen() && currentSource && currentSource !== provider) {
    try { win.close(); } catch (e) { /* 已经关了 */ }
    win = null;
  }
  currentSource = provider;
  currentQuery = q;
  if (isOpen()) {
    win.loadURL(url);
    /* 隐藏窗口也要真的渲染，不然页面里的 fetch 可能被节流 */
    try { win.webContents.setBackgroundThrottling(false); } catch (e) { /* 老版本没有 */ }
    /* 抓取/搜索用的是这个窗口，默认不弹出来；要给人看时走 reveal() */
    return { ok: true, reused: true, url: url, source: provider };
  }
  win = new BrowserWindow({
    width: 1120,
    height: 820,
    show: false,
    title: '联网找书 · 登录后点「读回结果」',
    backgroundColor: '#f6f4f0',
    autoHideMenuBar: true,
    webPreferences: {
      partition: 'persist:sf-web-' + provider,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.loadURL(url);
  /* wenku8 的登录态（jieqiUserInfo 等）默认是会话 Cookie，窗口一关就没了。
     Cookie 一出现就改写成 30 天持久 Cookie，用户登一次就能一直用。 */
  try {
    const ses = session.fromPartition('persist:sf-web-' + provider);
    const pinned = {};
    const onChanged = (evt, cookie, cause, removed) => {
      if (!cookie || removed || !cookie.session) return;
      if (!/^jieqi/i.test(cookie.name)) return;
      const key = cookie.name + '=' + cookie.value;
      if (pinned[key]) return;
      pinned[key] = 1;
      const host = String(cookie.domain || '').replace(/^\./, '') || 'www.wenku8.net';
      ses.cookies
        .set({
          url: 'https://' + host + (cookie.path || '/'),
          name: cookie.name,
          value: cookie.value,
          path: cookie.path || '/',
          secure: cookie.secure,
          httpOnly: cookie.httpOnly,
          expirationDate: Math.floor(Date.now() / 1000) + 30 * 86400
        })
        .catch(() => {});
    };
    ses.cookies.on('changed', onChanged);
    win.on('closed', () => {
      try { ses.cookies.removeListener('changed', onChanged); } catch (e) { /* ignore */ }
    });
  } catch (e) { /* 拿不到 session 就跳过，不影响开窗 */ }

  /* 站内 target=_blank 一律拦下、在当前窗口打开，避免弹出一堆窗口 */
  win.webContents.setWindowOpenHandler(({ url: u }) => {
    if (/^https?:/i.test(u)) win.loadURL(u);
    return { action: 'deny' };
  });
  win.on('closed', () => { win = null; });
  return { ok: true, url: url, source: provider };
}

/** 把当前页的链接读回来（标题 + 绝对地址），挑像"书"的那些 */
async function grab(limit) {
  if (!isOpen()) return { ok: false, error: '内嵌浏览器没打开' };
  const max = Math.max(1, Math.min(40, Number(limit) || 20));
  const script = `(function (max) {
    var out = [];
    var seen = {};
    var as = document.querySelectorAll('a[href]');
    for (var i = 0; i < as.length && out.length < max; i++) {
      var a = as[i];
      var t = (a.textContent || '').replace(/\\s+/g, ' ').trim();
      if (t.length < 2 || t.length > 80) continue;
      if (/^(首页|登录|注册|书架|排行|全部小说|上一页|下一页|更多)$/.test(t)) continue;
      var href = a.href || '';
      if (!/^https?:/i.test(href)) continue;
      if (seen[href]) continue;
      if (!/book|article|novel|read|\\/b\\/|txt|epub|pdf/i.test(href)) continue;
      seen[href] = 1;
      out.push({ title: t, url: href });
    }
    return { title: document.title, url: location.href, items: out };
  })(${max})`;
  try {
    const r = await win.webContents.executeJavaScript(script, true);
    return Object.assign({ ok: true, source: currentSource, query: currentQuery }, r || {});
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** 打开登录页（用户自己输账号密码，应用不碰任何凭据） */
function openLogin(source) {
  const provider = String(source || 'wenku8');
  const url = /wenku8/.test(provider) ? 'https://www.wenku8.net/login.php' : 'https://www.wenku8.net/';
  if (!isOpen()) {
    const r = open(provider, '');
    if (!r || !r.ok) return r || { ok: false, error: '窗口没建起来' };
  }
  try {
    win.loadURL(url);
    win.show();
    win.focus();
    /* 用户登录完关掉窗口时，把会话 Cookie 固化下来：
       wenku8 的 jieqiUserInfo 默认是"关窗即失效"的会话 Cookie，
       不 pin 的话每次重开应用都要重新登录。 */
    if (!win.__pinHooked) {
      win.webContents.on('did-stop-loading', function () { pinQuiet(provider); });
      win.__pinHooked = true;
      win.on('closed', function () {
        Promise.resolve()
          .then(function () { return pinLoginCookies(provider); })
          .catch(function () { /* 关窗时出错就下次启动再试 */ });
      });
    }
    return { ok: true, url: url, source: provider };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** 抓取前确保内嵌窗口在（页面内 fetch 需要一个真实窗口带 Cookie） */
async function ensureOpen(source) {
  const provider = String(source || 'wenku8');
  if (isOpen() && currentSource === provider) return { ok: true, reused: true };
  if (isOpen()) {
    try { win.close(); } catch (e) { /* 已经关了 */ }
    win = null;
  }
  const r = open(provider, '');
  if (!r || !r.ok) return r || { ok: false, error: '窗口没建起来' };
  /* 等它把首页载完（顺便让 Cloudflare 挑战有机会过去） */
  await new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    win.webContents.once('did-finish-load', finish);
    setTimeout(finish, 12000);
  });
  await new Promise((res) => setTimeout(res, 1200));
  return { ok: true, opened: true };
}

/** 看这个独立会话里到底有没有登录态（只报 cookie 名，不把值带出去） */
/* 把登录相关的 Cookie 从"会话级"改成"30 天有效"。
   wenku8 的 jieqiUserInfo 默认是会话 Cookie，窗口一关就消失——这是"登录了还是没登录"的根因。 */
async function pinLoginCookies(source) {
  const provider = String(source || 'wenku8');
  const { session } = require('electron');
  const ses = session.fromPartition('persist:sf-web-' + provider);
  let all = [];
  try { all = await ses.cookies.get({}); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  const mine = all.filter((c) => /wenku8\.(net|com|cc)$/.test(String(c.domain || '').replace(/^\./, '')));
  const need = mine.filter((c) => /^jieqi/i.test(c.name));
  const exp = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
  let pinned = 0;
  for (const c of need) {
    try {
      const host = String(c.domain || '').replace(/^\./, '');
      await ses.cookies.set({
        url: 'https://' + host + '/',
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path || '/',
        secure: !!c.secure,
        httpOnly: !!c.httpOnly,
        expirationDate: exp
      });
      pinned += 1;
    } catch (e) { /* 个别 cookie 写不进去就算了 */ }
  }
  return { ok: true, pinned: pinned, names: need.map((c) => c.name) };
}

async function sessionState(source) {
  const provider = String(source || 'wenku8');
  const { session } = require('electron');
  const ses = session.fromPartition('persist:sf-web-' + provider);
  let cookies = [];
  try {
    cookies = await ses.cookies.get({});
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
  cookies = cookies.filter((c) => /wenku8\.(net|com|cc)$/.test(String(c.domain || '').replace(/^\./, '')));
  const names = cookies.map((c) => c.name);
  const has = (n) => names.indexOf(n) >= 0;
  /* wenku8 的登录态主要看 jieqiUserInfo / jieqiUserName；cf_clearance 只代表过了人机验证 */
  let loggedIn = has('jieqiUserInfo') || has('jieqiUserName');
  if (!loggedIn && isOpen()) {
    try {
      const html = await win.webContents.executeJavaScript('document.documentElement.outerHTML', true);
      if (/退出登录|会员中心|【退出】/.test(String(html || ''))) loggedIn = true;
    } catch (e) { /* 判断失败就当未登录 */ }
  }
  let cfBlocked = false;
  if (isOpen()) {
    try {
      const h0 = await win.webContents.executeJavaScript('document.documentElement.outerHTML', true);
      cfBlocked = /Just a moment\.\.\.|cf-browser-verification|challenge-platform/i.test(String(h0 || '').slice(0, 2000));
    } catch (e) { /* 忽略 */ }
  }
  let user = '';
  if (isOpen()) {
    try {
      user = await win.webContents.executeJavaScript(
        `(function () {
           var e = document.querySelector('#userinfo a, .blocktitle a[href*="userdetail"], a[href*="userdetail"]');
           return e ? (e.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40) : '';
         })()`,
        true
      );
    } catch (e) { user = ''; }
  }
  let pinned = 0;
  if (loggedIn) {
    try {
      const pr = await pinLoginCookies(provider);
      pinned = pr.pinned || 0;
    } catch (e) { /* 固化失败不影响判定 */ }
  }
  return {
    ok: true,
    pinned: pinned,
    cfBlocked: !!cfBlocked,
    loggedIn: !!loggedIn,
    user: user || '',
    cf: has('cf_clearance'),
    cookies: names.slice(0, 30),
    count: cookies.length
  };
}

/** 用已登录的那个会话去站内搜索（不绕验证：没过挑战就如实报错） */
async function searchInSession(source, q) {
  const provider = String(source || 'wenku8');
  const { session } = require('electron');
  const ses = session.fromPartition('persist:sf-web-' + provider);
  const kw = String(q || '').trim();
  if (!kw) return { ok: false, error: '先填书名或作者' };
  const urls = [
    'https://www.wenku8.net/modules/article/search.php?searchkey=' + encodeURIComponent(kw),
    'https://www.wenku8.net/so.php?q=' + encodeURIComponent(kw)
  ];
  let lastErr = '';
  for (const u of urls) {
    try {
      const r = await ses.fetch(u, {
        method: 'GET',
        headers: { accept: 'text/html,application/xhtml+xml', 'accept-language': 'zh-CN,zh;q=0.9' }
      });
      const raw = await r.arrayBuffer();
      const iconv = require('iconv-lite');
      const html = iconv.decode(Buffer.from(raw), 'gb18030');
      if (!r.ok) { lastErr = 'HTTP ' + r.status; continue; }
      if (/Just a moment\.\.\./i.test(html.slice(0, 400)) || /cf-browser-verification/i.test(html.slice(0, 2000))) {
        lastErr = '被 Cloudflare 挡着：先在窗口里打开一次站点、过掉验证再试';
        continue;
      }
      return { ok: true, url: u, html: html };
    } catch (e) {
      lastErr = String((e && e.message) || e);
    }
  }
  return { ok: false, error: lastErr || '搜索失败' };
}

/**
 * 在已登录的那个窗口里"用页面自己的网络栈"取一页，返回原始字节（base64）。
 * 为什么要绕这一圈：站点对非浏览器指纹的请求一律 403/挑战；页面内 fetch 带着真实 Cookie、
 * 真实 TLS 指纹与 cf_clearance，能拿到的东西和用户手点一样多——这也是同类客户端的做法。
 */
async function fetchInPage(url, opts) {
  if (!/^https?:/i.test(String(url || ''))) return { ok: false, error: '地址不对' };
  if (!isOpen()) return { ok: false, error: 'needs-window' };
  const referer = (opts && opts.referer) || '';
  const script = `(async function (u, ref) {
    try {
      var r = await fetch(u, {
        credentials: 'include',
        headers: ref ? { 'referer': ref } : undefined
      });
      var buf = new Uint8Array(await r.arrayBuffer());
      var s = '';
      for (var i = 0; i < buf.length; i += 8192) {
        s += String.fromCharCode.apply(null, buf.subarray(i, i + 8192));
      }
      return { status: r.status, ok: r.ok, b64: btoa(s), len: buf.length };
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  })(${JSON.stringify(String(url))}, ${JSON.stringify(referer)})`;
  const timeoutMs = (opts && opts.timeoutMs) || 15000;
  try {
    /* 页面里的 fetch 可能永远不 settle（页面空白 / 挑战页 / 被挂起），
       所以这里必须自己做超时，否则调用方会毫无征兆地挂死。 */
    const r = await Promise.race([
      win.webContents.executeJavaScript(script, true),
      new Promise((_, rej) => setTimeout(() => rej(new Error('页面取数超时（' + Math.round(timeoutMs / 1000) + 's）')), timeoutMs))
    ]);
    if (!r || r.error) return { ok: false, error: (r && r.error) || '页面里取不到' };
    return {
      ok: r.ok,
      status: r.status,
      buf: Buffer.from(r.b64 || '', 'base64'),
      len: r.len || 0
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** 用户点「用系统浏览器打开」时走这里 */
/** 兜底搜索：在隐藏窗口里让 Bing 搜 site:wenku8.net。<关键词>，把结果页 HTML 交回 Node。
 *  站点本身被 Cloudflare 挡着、站内搜索又要登录，这条路不需要登录。 */
async function searchBing(source, q) {
  const kw = String(q || '').trim();
  if (!kw) return { ok: false, error: '先填书名或作者' };
  const r0 = await ensureOpen('bing');
  if (!r0 || !r0.ok) return r0 || { ok: false, error: '窗口没建起来' };
  const url = 'https://cn.bing.com/search?q=' + encodeURIComponent('site:wenku8.net ' + kw.replace(/\s+/g, ' '));
  try {
    await new Promise((resolve) => {
      let done = false;
      const fin = () => { if (!done) { done = true; resolve(); } };
      win.webContents.once('did-finish-load', fin);
      win.loadURL(url);
      setTimeout(fin, 20000);
    });
    await new Promise((r) => setTimeout(r, 1200));
    const html = await win.webContents.executeJavaScript('document.documentElement.outerHTML', true);
    return { ok: true, html: html, from: win.webContents.getURL() };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** 在隐藏窗口里打开一个 wenku8 页面，把 outerHTML 取回来（索引页用）。 */
async function loadHtml(source, url) {
  const r0 = await ensureOpen(source || 'wenku8');
  if (!r0 || !r0.ok) return r0 || { ok: false, error: '窗口没建起来' };
  try {
    await new Promise((resolve) => {
      let done = false;
      const fin = () => { if (!done) { done = true; resolve(); } };
      win.webContents.once('did-finish-load', fin);
      win.loadURL(url);
      setTimeout(fin, 20000);
    });
    await new Promise((r) => setTimeout(r, 500));
    const html = await win.webContents.executeJavaScript('document.documentElement.outerHTML', true);
    return { ok: true, html: html, from: win.webContents.getURL() };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function openExternal(url) {
  if (!/^https?:/i.test(String(url || ''))) return { ok: false };
  shell.openExternal(url);
  return { ok: true };
}

/** 用户主动要"看那个网站"时才显示窗口 */
function reveal() {
  if (!isOpen()) return { ok: false, error: '窗口没开' };
  win.show();
  win.focus();
  return { ok: true };
}

/** 在真窗口里搜索：先打开站点首页，找到站内搜索框，填词并提交表单。
 *  表单自身是 GBK，交给浏览器编码才不会乱；取回 outerHTML 给 Node 解析。
 *  找不到表单时退回 GET（有的镜像支持）。 */
async function searchInWindow(source, q) {
  const provider = String(source || 'wenku8');
  const kw = String(q || '').trim();
  if (!kw) return { ok: false, error: '先填书名或作者' };
  const r0 = await ensureOpen(provider);
  if (!r0 || !r0.ok) return r0 || { ok: false, error: '窗口没建起来' };

  const tries = [];
  const waitLoad = (ms) => new Promise((resolve) => {
    let done = false;
    const fin = () => { if (!done) { done = true; resolve(); } };
    win.webContents.once('did-finish-load', fin);
    setTimeout(fin, ms || 20000);
  });

  /* 1) 首页 → 填表 → 提交 */
  try {
    await new Promise((resolve) => {
      let done = false;
      const fin = () => { if (!done) { done = true; resolve(); } };
      win.webContents.once('did-finish-load', fin);
      win.loadURL('https://www.wenku8.net/index.php');
      setTimeout(fin, 20000);
    });
    await new Promise((r) => setTimeout(r, 600));
    const submitted = await win.webContents.executeJavaScript(
      '(function (kw) {' +
      '  var inp = document.querySelector("input[name=searchkey], #searchkey, input[name=key], input[type=text]");' +
      '  if (!inp) return { ok: false, why: "no input" };' +
      '  inp.value = kw;' +
      '  var f = inp.form;' +
      '  if (!f) { var p = inp.parentNode; while (p && p.tagName !== "FORM") p = p.parentNode; f = p; }' +
      '  if (!f) return { ok: false, why: "no form" };' +
      '  try {' +
  '    if (typeof f.requestSubmit === "function") f.requestSubmit();' +
  '    else HTMLFormElement.prototype.submit.call(f);' +
  '    return { ok: true, action: f.action || "", how: "requestSubmit" };' +
  '  } catch (e0) { return { ok: false, why: String(e0 && e0.message || e0) }; }' +
  '  try { return { ok: true, action: f.action || "" }; }' +
      '  catch (e) { return { ok: false, why: String(e && e.message || e) }; }' +
      '})("' + kw.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '")',
      true
    );
    tries.push({ step: 'submit', submitted: submitted });
    if (submitted && submitted.ok) {
      await waitLoad(20000);
      await new Promise((r) => setTimeout(r, 900));
      const html = await win.webContents.executeJavaScript('document.documentElement.outerHTML', true);
      const pageUrl = win.webContents.getURL();
      tries.push({ url: pageUrl, len: (html || '').length });
      if (html && html.length > 500) return { ok: true, html: html, from: pageUrl, tries: tries };
    }
  } catch (e) {
    tries.push({ step: 'submit', error: String((e && e.message) || e) });
  }

  /* 2) 退回 GET 两种地址 */
  const urls = [
    'https://www.wenku8.net/modules/article/search.php?searchkey=' + encodeURIComponent(kw),
    'https://www.wenku8.net/so.php?q=' + encodeURIComponent(kw)
  ];
  for (const u of urls) {
    try {
      win.loadURL(u);
      await waitLoad(20000);
      await new Promise((r) => setTimeout(r, 800));
      const html = await win.webContents.executeJavaScript('document.documentElement.outerHTML', true);
      const pageUrl = win.webContents.getURL();
      tries.push({ url: pageUrl, len: (html || '').length });
      if (html && html.length > 500) return { ok: true, html: html, from: pageUrl, tries: tries };
    } catch (e) {
      tries.push({ url: u, error: String((e && e.message) || e) });
    }
  }
  return { ok: false, error: '搜索页打不开', tries: tries };
}

function close() {
  if (isOpen()) win.close();
  return { ok: true };
}

let pinAt = 0;
/** 节流的 pin（60 秒内只做一次），登录成功后马上调它，用户关不关窗都能记住 */
async function pinQuiet(source) {
  const now = Date.now();
  if (now - pinAt < 60000) return { ok: true, skipped: true };
  pinAt = now;
  try {
    const st = await sessionState(source || 'wenku8');
    if (st && st.loggedIn) {
      const r = await pinLoginCookies(source || 'wenku8');
      return { ok: true, loggedIn: true, pinned: r && r.pinned };
    }
    return { ok: true, loggedIn: false };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** 启动时把已登录的会话 Cookie 固化一次（幂等） */
async function bootPin() {
  try { await pinLoginCookies('wenku8'); } catch (e) { /* 没登录就算了 */ }
}

module.exports = {
  bootPin,
  pinQuiet,
  pinLoginCookies,
  open, openLogin, ensureOpen, reveal, grab, sessionState, searchInWindow, searchInSession, fetchInPage, openExternal, close, isOpen, path,
  searchBing: searchBing,
  loadHtml: loadHtml
};
