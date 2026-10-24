'use strict';
/**
 * 分节落盘。
 *
 * 为什么不把正文塞进 SQLite：
 *  1. db.js 的 backup() 会把整库复制一份、留 20 份（db.js:23-81），
 *     一本 3MB 的小说会让每次备份都多 3MB，20 本就吃掉 60MB；
 *  2. 正文是"一次写、多次读"的冷数据，放文件里让 VACUUM / FTS 索引都轻；
 *  3. 用户在资源管理器里能直接看到自己导入的书。
 *
 * 目录形状（跟着书走，复制一个文件夹就复制了整本书）：
 *   <root>/books/<bookId>/sec/0.json   { ord, title, blocks:[{kind,text}] }
 */
const fs = require('node:fs');
const path = require('node:path');

/* 单节上限：一本 3MB 的 txt 如果只有"第一章"，整个节会变成 3MB 的一个 JSON，
   阅读器一打开就要解析 3MB —— 所以按块数和字数再切几刀。 */
const MAX_SECTION_CHARS = 60000;
const MAX_SECTION_BLOCKS = 400;

function sectionChars(sec) {
  let n = 0;
  (sec.blocks || []).forEach((b) => { n += (b.text || '').length; });
  return n;
}

/** 超长的节切成「标题（续 1）」「标题（续 2）」；不超长的原样返回 */
function capSections(sections) {
  const out = [];
  (sections || []).forEach((sec) => {
    const blocks = sec.blocks || [];
    if (!blocks.length) {
      out.push({ title: sec.title || '正文', blocks: [] });
      return;
    }
    if (blocks.length <= MAX_SECTION_BLOCKS && sectionChars(sec) <= MAX_SECTION_CHARS) {
      out.push({ title: sec.title || '正文', blocks: blocks.slice() });
      return;
    }
    let cur = [];
    let n = 0;
    let part = 0;
    const flush = () => {
      if (!cur.length) return;
      const title = (sec.title || '正文') + (part ? '（续 ' + part + '）' : '');
      out.push({ title, blocks: cur });
      cur = [];
      n = 0;
      part++;
    };
    blocks.forEach((b) => {
      cur.push(b);
      n += (b.text || '').length;
      if (cur.length >= MAX_SECTION_BLOCKS || n >= MAX_SECTION_CHARS) flush();
    });
    flush();
  });
  return out;
}

function rand() {
  return Math.random().toString(36).slice(2, 8);
}

/**
 * 整本写盘。先写到临时目录再一次性换名：
 * 导入中途崩溃时，书架上不会出现一本"有一半章节"的坏书。
 * images: [{name, data, mime}] → 落到 <bookDir>/img/<name>，正文块里只留 name。
 */
function writeSections(bookDir, sections, images, coverName) {
  const tmp = bookDir + '.tmp-' + rand();
  fs.mkdirSync(path.join(tmp, 'sec'), { recursive: true });
  try {
    (images || []).forEach((im) => {
      if (!im || !im.name || !im.data) return;
      const dir = path.join(tmp, 'img');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, im.name), im.data);
    });
    /* 封面单独存一份 _cover.<ext>：以后找封面不用猜是哪张图 */
    if (coverName) {
      const im = (images || []).filter((x) => x && x.name === coverName)[0];
      if (im && im.data) {
        const dir = path.join(tmp, 'img');
        fs.mkdirSync(dir, { recursive: true });
        const ext = (String(coverName).split('.').pop() || 'jpg').toLowerCase();
        fs.writeFileSync(path.join(dir, '_cover.' + ext), im.data);
      }
    }
    sections.forEach((sec, i) => {
      const payload = { ord: i, title: sec.title || '正文', blocks: sec.blocks || [] };
      fs.writeFileSync(path.join(tmp, 'sec', i + '.json'), JSON.stringify(payload), 'utf8');
    });
    fs.rmSync(bookDir, { recursive: true, force: true });
    fs.renameSync(tmp, bookDir);
  } catch (e) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e2) { /* 清不掉就算了 */ }
    throw e;
  }
  return { dir: bookDir, count: sections.length };
}

function imagePath(bookDir, name) {
  return path.join(bookDir, 'img', String(name || '').replace(/[\\/]/g, '_'));
}

function sectionPath(bookDir, ord) {
  return path.join(bookDir, 'sec', Number(ord) + '.json');
}

function readSection(bookDir, ord) {
  const file = sectionPath(bookDir, ord);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return null;
  }
  try {
    const o = JSON.parse(raw);
    return { ord: Number(ord), title: o.title || '正文', blocks: o.blocks || [] };
  } catch (e) {
    return null;
  }
}

/** 已经落盘几节（书源网页书会陆续下，不能信 DB 里的 section_count） */
function countOnDisk(bookDir) {
  try {
    return fs.readdirSync(path.join(bookDir, 'sec')).filter((f) => /^\d+\.json$/.test(f)).length;
  } catch (e) {
    return 0;
  }
}

function removeBookDir(bookDir) {
  try { fs.rmSync(bookDir, { recursive: true, force: true }); } catch (e) { return false; }
  return true;
}

function sizeOnDisk(bookDir) {
  let total = 0;
  try {
    fs.readdirSync(path.join(bookDir, 'sec')).forEach((f) => {
      try { total += fs.statSync(path.join(bookDir, 'sec', f)).size; } catch (e) { /* 忽略单文件失败 */ }
    });
  } catch (e) { /* 目录不存在 */ }
  return total;
}

module.exports = {
  MAX_SECTION_CHARS,
  MAX_SECTION_BLOCKS,
  capSections,
  writeSections,
  readSection,
  sectionPath,
  imagePath,
  countOnDisk,
  removeBookDir,
  sizeOnDisk
};
