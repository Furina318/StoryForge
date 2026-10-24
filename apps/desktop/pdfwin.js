'use strict';
/**
 * PDF 原版打开（方案 P0.5 的 A 路线）。
 *
 * 做法：开一个独立 BrowserWindow 直接 loadURL('file://…/x.pdf#page=N')，
 * 交给 Chromium 自带的 PDF 查看器渲染。好处是零依赖、100% 保真：
 * 教材的图、表、双栏、公式都在，缩放/搜索/选择/书签面板全是现成的。
 *
 * 代价：外观是 Chromium 的，夜间模式压不了暗，也拿不到内部选区。
 * 想要"选中一段收进本章"就得走 B（pdf.js canvas + textLayer），那时替换本文件即可。
 *
 * 这里唯一要自己做的事是**记进度**：轮询 getURL() 里的 #page=N 存进 book.progress_ord。
 * 如果某个 Electron 版本不更新 hash，进度就退化成"只在跳转时更新"，不影响阅读。
 */
const path = require('node:path');
const { BrowserWindow } = require('electron');
const { pathToFileURL } = require('node:url');

const wins = new Map();   // bookId -> { win, timer, page }

function urlFor(file, page) {
  const href = pathToFileURL(file).href;
  return href + (page ? '#page=' + Math.max(1, Math.floor(page)) : '');
}

function parsePage(url, fallback) {
  const m = String(url || '').match(/[#&]page=(\d+)/);
  const p = m ? parseInt(m[1], 10) : 0;
  return p > 0 ? p : fallback;
}

/**
 * @param {object} o { bookId, file, title, page, onEvent }
 * @returns {{ ok:boolean, reused:boolean, page:number }}
 */
function open(o) {
  const file = o.file;
  if (!file) throw new Error('这本书没有源文件（网页书请在应用内读）');
  const bookId = o.bookId || file;

  const alive = wins.get(bookId);
  if (alive && !alive.win.isDestroyed()) {
    alive.win.loadURL(urlFor(file, o.page || alive.page || 1));
    alive.win.focus();
    return { ok: true, reused: true, page: o.page || alive.page || 1 };
  }

  const win = new BrowserWindow({
    width: 1000,
    height: Math.max(760, 900),
    minWidth: 700,
    minHeight: 560,
    title: o.title || path.basename(file),
    backgroundColor: '#2c2c2c',
    autoHideMenuBar: true,
    webPreferences: {
      /* 内建 PDF 查看器在部分版本里要靠 plugins 开关才挂上；留着无害 */
      plugins: true,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.setMenuBarVisibility(false);

  const rec = { win, timer: null, page: o.page || 1 };
  wins.set(bookId, rec);

  const emit = (msg) => {
    try { if (typeof o.onEvent === 'function') o.onEvent(msg); } catch (e) { /* 窗口在关，忽略 */ }
  };

  win.loadURL(urlFor(file, rec.page));

  rec.timer = setInterval(() => {
    if (win.isDestroyed()) return;
    let url = '';
    try { url = win.webContents.getURL(); } catch (e) { return; }
    const p = parsePage(url, 0);
    if (p && p !== rec.page) {
      rec.page = p;
      emit({ type: 'pdf-page', bookId, page: p });
    }
  }, 700);

  win.on('closed', () => {
    if (rec.timer) clearInterval(rec.timer);
    wins.delete(bookId);
    emit({ type: 'pdf-closed', bookId, page: rec.page });
  });

  return { ok: true, reused: false, page: rec.page };
}

function closeAll() {
  wins.forEach((rec) => { try { if (!rec.win.isDestroyed()) rec.win.close(); } catch (e) { /* 已关 */ } });
  wins.clear();
}

module.exports = { open, closeAll };
