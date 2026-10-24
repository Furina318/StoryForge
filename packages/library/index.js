'use strict';
/**
 * 书库总管：把"一个磁盘上的文件"变成"书架上的一本书"。
 *
 * 分工：
 *   registry 决定用哪个 adapter 读，toc 切目录，sections 写盘，
 *   这一层只做流程编排 + 落库需要的元信息。**不碰数据库**（主进程/library.js 负责）。
 *
 * 不变量（方案 §3）：
 *   - 源文件只读不写：导入前后 mtime / 字节数不变；
 *   - 一本书 = books/<id>/ 一个目录 + DB 里一行 book；
 *   - 正文按节读，任何一步失败都退化成"能打开"，不出现"导入失败"。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const registry = require('./registry');
const sections = require('./sections');
const { MAX_BYTES } = require('./encoding');

function bookDir(root, id) {
  return path.join(root, 'books', id);
}

function ensureRoot(root) {
  fs.mkdirSync(path.join(root, 'books'), { recursive: true });
  return root;
}

function sha1(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

function newId() {
  return 'bk_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function extOf(p) {
  return String(path.extname(p || '')).replace(/^\./, '').toLowerCase();
}

function trimTitle(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, 120);
}

/**
 * 导入一个文件。
 * @param {string} root      书库根目录（<userData>/library）
 * @param {string} filePath  源文件绝对路径
 * @param {object} opts      { title }
 * @returns {{ book:object, candidates:Array, adapter:string }}
 */
function importFile(root, filePath, opts) {
  const o = opts || {};
  let st;
  try { st = fs.statSync(filePath); } catch (e) { throw new Error('读不到这个文件：' + filePath); }
  if (!st.isFile()) throw new Error('只能导入文件（不支持导入文件夹）');
  if (st.size > MAX_BYTES) {
    throw new Error('文件太大了：' + Math.round(st.size / 1024 / 1024) + 'MB，目前上限是 ' +
      Math.round(MAX_BYTES / 1024 / 1024) + 'MB');
  }

  /* 主进程已经读过一遍（为了算 sha1 查重）就把 buffer 传进来，别让 200MB 的文件读两次 */
  const buf = o.buf || fs.readFileSync(filePath);
  const ctx = { path: filePath, ext: extOf(filePath), size: st.size, name: path.basename(filePath) };
  const r = registry.parse(buf, ctx);

  const id = newId();
  const dir = bookDir(root, id);
  const coverPathOf = (name) => {
    if (!name) return '';
    const n = String(name);
    if (/^(data:|https?:)/i.test(n)) return n;
    const ext = (n.split('.').pop() || 'jpg').toLowerCase();
    const saved = sections.imagePath(dir, '_cover.' + ext);
    try {
      if (require('node:fs').existsSync(saved)) return saved;
    } catch (e) { /* 忽略 */ }
    return sections.imagePath(dir, n);
  };

  const capped = sections.capSections(r.sections || []);
  const stored = capped.length ? sections.writeSections(dir, capped, r.images, r.cover) : { dir: null, count: 0 };
  const stat = r.stats || {};

  const book = {
    id,
    title: trimTitle(o.title || r.title || ctx.name) || '未命名',
    author: trimTitle(r.author || ''),
    format: r.format,
    render: r.render,
    label: r.label || r.format,
    encoding: r.encoding || '',
    srcPath: filePath,
    srcName: ctx.name,
    srcSize: st.size,
    srcHash: sha1(buf),
    sectionCount: stored.count,
    chars: stat.chars || 0,
    paragraphs: stat.paragraphs || 0,
    tocSource: r.tocSource || null,
    note: r.note || '',
    /* r.cover 是 epub 里的图片名（如 i1.jpg）；落盘后要换成绝对路径，
       否则 UI 拿到的 "i1.jpg" 既不是 URL 也不是路径，永远显示不出来。 */
    cover: coverPathOf(r.cover),
    covered: 0,
    lastOrd: 0
  };

  return {
    book,
    toc: capped.map((s, i) => ({ ord: i, title: s.title || '正文' })),
    adapter: r.adapter,
    candidates: r.candidates || [],
    dir: stored.dir || dir
  };
}

function readSection(root, bookId, ord) {
  const dir = bookDir(root, bookId);
  const sec = sections.readSection(dir, ord);
  if (sec && Array.isArray(sec.blocks)) {
    /* 正文块里只存图片文件名；给渲染进程时补上真实路径，读完就删（别把绝对路径写回盘） */
    sec.blocks.forEach((b) => {
      if (b.kind !== 'img' || !b.src) return;
      const p = sections.imagePath(dir, b.src);
      b.file = p;
      b.src = '';
    });
  }
  return sec;
}

function countSections(root, bookId) {
  return sections.countOnDisk(bookDir(root, bookId));
}

function diskSize(root, bookId) {
  return sections.sizeOnDisk(bookDir(root, bookId));
}

function removeBook(root, bookId) {
  return sections.removeBookDir(bookDir(root, bookId));
}

/** 让"换编码重读"能只换编码、不换 id：把旧书目录删掉重写一遍 */
function reparse(root, book, filePath, encoding) {
  const buf = fs.readFileSync(filePath);
  const ctx = { path: filePath, ext: extOf(filePath), size: buf.length, name: book.srcName };
  const r = registry.parse(buf, ctx);
  const capped = sections.capSections(r.sections || []);
  const stored = sections.writeSections(bookDir(root, book.id), capped);
  const stat = r.stats || {};
  const next = Object.assign({}, book, {
    sectionCount: stored.count,
    chars: stat.chars || 0,
    paragraphs: stat.paragraphs || 0,
    tocSource: r.tocSource || null,
    encoding: r.encoding || encoding || book.encoding || '',
    note: r.note || ''
  });
  return { book: next, toc: capped.map((s, i) => ({ ord: i, title: s.title || '正文' })) };
}

/**
 * 直接从"章节块"建一本书（不走 txt 中转）。
 * 抓站点的正文里有图片块，走 txt 会把图片压成一行占位文本，再由正则还原极不可靠。
 * payload: { title, author, format, render, label, note, srcName, sections:[{title,blocks}], images:[{name,data}], cover, stats }
 */
function importBlocks(root, payload) {
  const p = payload || {};
  ensureRoot(root);
  const id = newId();
  const dir = bookDir(root, id);
  const capped = sections.capSections(p.sections || []);
  const stored = capped.length
    ? sections.writeSections(dir, capped, p.images || [], p.cover || '')
    : { dir: null, count: 0 };
  let chars = 0;
  let paras = 0;
  capped.forEach((sec) => {
    (sec.blocks || []).forEach((b) => {
      if (b && b.kind === 'img') return;
      const tx = String((b && b.text) || '');
      chars += tx.length;
      if (tx.trim()) paras += 1;
    });
  });
  const book = {
    id: id,
    title: trimTitle(p.title || p.srcName || '未命名'),
    author: trimTitle(p.author || ''),
    format: p.format || 'txt',
    render: p.render || 'text',
    label: p.label || p.format || 'txt',
    encoding: p.encoding || 'utf-8',
    srcPath: '',
    srcName: p.srcName || '',
    srcSize: p.srcSize || 0,
    srcHash: p.srcHash || '',
    sectionCount: stored.count,
    chars: chars,
    paragraphs: paras,
    tocSource: p.tocSource || null,
    note: p.note || '',
    cover: p.cover || '',
    covered: 0,
    lastOrd: 0
  };
  return { book: book, toc: capped.map((s2, i) => ({ ord: i, title: s2.title || '正文' })), dir: stored.dir || dir };
}

module.exports = {
  importFile: importFile,
  importBlocks: importBlocks,
  sha1: sha1,
  readSection: readSection,
  countSections: countSections,
  diskSize: diskSize,
  removeBook: removeBook,
  reparse: reparse,
  bookDir: bookDir,
  ensureRoot: ensureRoot
};
