'use strict';
/**
 * EPUB adapter。
 *
 * EPUB 就是一个 zip：META-INF/container.xml 指向 OPF，OPF 里有 manifest（id → 文件）
 * 和 spine（阅读顺序），toc.ncx / nav.xhtml 给章节标题，每章是一个 xhtml。
 *
 * 这一层只做三件事：解 zip、按 spine 排章节、把 xhtml 变成段落块。
 * **不渲染图片、不解析 CSS**——这是纯文本阅读，插图在 v1 里不显示（书里会写明）。
 *
 * 为什么自己写 zip 解析：只为了 inflate 一个 Node 内置的 zlib 就够，
 * 不想为了一本书的目录去引一个 200KB 的压缩库；EPUB 的 zip 都是最常见的那种
 * （stored / deflate、无 zip64），EOCD + 中央目录两百行能吃完。
 */
const zlib = require('node:zlib');
const path = require('node:path');
const toc = require('../toc');

const EXTS = ['epub'];

/* ---------------- zip 读取 ---------------- */

function isZip(buf) {
  return buf && buf.length > 22 && buf[0] === 0x50 && buf[1] === 0x4b;
}

function hasMagic(buf) {
  if (!isZip(buf)) return false;
  /* mimetype 必须是 zip 里第一个条目且不压缩；简单起见在前 4KB 里找这串 */
  return buf.subarray(0, 4096).toString('latin1').indexOf('application/epub+zip') >= 0;
}

function findEocd(buf) {
  const min = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

function openZip(buf) {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('不是有效的 zip（找不到目录尾）');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (cdOff + cdSize > buf.length) throw new Error('zip 目录越界（文件可能被截断）');

  const entries = new Map();
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const rawSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    entries.set(name, { name, method, compSize, rawSize, localOff });
    p += 46 + nameLen + extraLen + cmtLen;
  }

  function read(name) {
    const e = entries.get(name);
    if (!e) return null;
    const lo = e.localOff;
    if (buf.readUInt32LE(lo) !== 0x04034b50) throw new Error('zip 本地头损坏：' + name);
    const nLen = buf.readUInt16LE(lo + 26);
    const xLen = buf.readUInt16LE(lo + 28);
    const start = lo + 30 + nLen + xLen;
    const data = buf.subarray(start, start + e.compSize);
    if (e.method === 0) return data;
    if (e.method === 8) return zlib.inflateRawSync(data);
    throw new Error('不支持的压缩方式 ' + e.method + '：' + name);
  }

  function text(name) {
    const b = read(name);
    return b ? b.toString('utf8') : null;
  }

  return { names: Array.from(entries.keys()), entries, read, text };
}

/* ---------------- XML 小工具 ---------------- */

function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '…')
    .replace(/&ldquo;/g, '“').replace(/&rdquo;/g, '”')
    .replace(/&lsquo;/g, '‘').replace(/&rsquo;/g, '’')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function attr(tag, name) {
  const m = tag.match(new RegExp(name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\')'));
  return m ? decodeEntities(m[2] != null ? m[2] : m[3]) : '';
}

function stripTags(s) {
  return String(s).replace(/<[^>]*>/g, '');
}

/* ---------------- xhtml → 段落块 ---------------- */

const BLOCK_END = /<\/(p|div|h[1-6]|li|tr|blockquote|section|article|dd|dt)\s*>|<br\s*\/?>/gi;

function htmlToBlocks(html) {
  let s = String(html || '');
  s = s.replace(/<\?xml[\s\S]*?\?>/gi, '');
  s = s.replace(/<!DOCTYPE[\s\S]*?>/gi, '');
  s = s.replace(/<head[\s\S]*?<\/head>/gi, '');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  /* 图片先摘出来变成一行标记，别让 stripTags 把 src 吃掉（顺序沿用文中位置） */
  s = s.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = (tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i) || [])[1] || '';
    return src ? '\n@@SFIMG:' + src + '@@\n' : '\n';
  });
  s = s.replace(BLOCK_END, '\n');
  s = stripTags(s);
  s = decodeEntities(s);

  const blocks = [];
  s.split('\n').forEach((line) => {
    /* 行内标签被吃掉后，中英文混排里多出来的连续空格压成一个；CJK 之间本来就没有空格 */
    let t = line.replace(/[\t ]+/g, ' ').trim();
    if (!t) return;
    const im = t.match(/^@@SFIMG:(.+)@@$/);
    if (im) {
      blocks.push({ kind: 'img', src: im[1].trim() });
      return;
    }
    /* 中文排版里不该有空格的地方（`&nbsp;` 撑出来的、标签之间的换行压出来的）一律去掉：
       "光芒 、" → "光芒、"，“银发 少女” → “银发少女”。英文单词之间的空格保留。 */
    const CJK = '[\\u3000-\\u303f\\u3400-\\u9fff\\uff00-\\uffef]';
    t = t.replace(new RegExp('(' + CJK + ')[ \\t]+(?=' + CJK + ')', 'g'), '$1');
    t = t.replace(/[ \t]+([、。，！？：；）」』】…—～·])/g, '$1');
    t = t.replace(/([「『【（])[ \t]+/g, '$1');
    /* 只有标点/装饰符号的行（"·" "──" "＊"）不是正文 */
    if (t.length <= 3 && !/[\u4e00-\u9fa5A-Za-z0-9]/.test(t)) return;
    blocks.push({ kind: 'para', text: t });
  });
  return blocks;
}

/* ---------------- OPF / NCX ---------------- */

function readContainer(zip) {
  const xml = zip.text('META-INF/container.xml');
  if (!xml) throw new Error('没有 META-INF/container.xml，不像 EPUB');
  const m = xml.match(/<rootfile[^>]*full-path\s*=\s*"([^"]+)"/i);
  if (!m) throw new Error('container.xml 里没有 rootfile');
  return m[1];
}

function parseOpf(xml) {
  const manifest = new Map();
  const re = /<item\b[^>]*>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const tag = m[0];
    const id = attr(tag, 'id');
    const href = attr(tag, 'href');
    if (!id || !href) continue;
    manifest.set(id, { href, type: attr(tag, 'media-type'), props: attr(tag, 'properties') });
  }

  const spine = [];
  const sre = /<itemref\b[^>]*>/gi;
  while ((m = sre.exec(xml))) {
    const idref = attr(m[0], 'idref');
    if (idref) spine.push(idref);
  }

  const meta = (name) => {
    const r = new RegExp('<(?:dc:)?' + name + '[^>]*>([\\s\\S]*?)</(?:dc:)?' + name + '>', 'i');
    const mm = xml.match(r);
    return mm ? decodeEntities(stripTags(mm[1])).trim() : '';
  };

  const tocId = (xml.match(/<spine[^>]*\btoc\s*=\s*"([^"]+)"/i) || [])[1] || '';

  return {
    manifest,
    spine,
    tocId,
    title: meta('title'),
    creator: meta('creator'),
    language: meta('language')
  };
}

function parseNcx(xml) {
  /* navPoint 是嵌套的：外层 navPoint 里还有子 navPoint。
     用"每个 navPoint 起点切到下个 navPoint 起点"的办法取它自己的 label/content，
     嵌套的部分自然落进子条目，不会被外层吞掉。 */
  const starts = [];
  const re = /<navPoint\b/gi;
  let m;
  while ((m = re.exec(xml))) starts.push(m.index);
  const out = [];
  for (let i = 0; i < starts.length; i++) {
    const chunk = xml.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : xml.length);
    const label = (chunk.match(/<text[^>]*>([\s\S]*?)<\/text>/i) || [])[1] || '';
    const src = (chunk.match(/<content[^>]*\bsrc\s*=\s*"([^"]+)"/i) || [])[1] || '';
    if (!src) continue;
    out.push({
      label: decodeEntities(stripTags(label)).replace(/\s+/g, ' ').trim(),
      src,
      depth: ((chunk.match(/<navPoint\b/gi) || []).length > 0) ? 1 : 1
    });
  }
  return out;
}

function parseNav(xml) {
  const out = [];
  const re = /<a\b[^>]*href\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(xml))) {
    out.push({ label: decodeEntities(stripTags(m[2])).trim(), src: decodeEntities(m[1]), depth: 1 });
  }
  return out;
}

function resolve(baseDir, href) {
  const clean = String(href).split('#')[0];
  let decoded = clean;
  try { decoded = decodeURIComponent(clean); } catch (e) { decoded = clean; }
  return path.posix.normalize(path.posix.join(baseDir, decoded));
}

/* ---------------- adapter ---------------- */

function probe(buf, ctx) {
  if (hasMagic(buf)) return 0.99;
  const ext = String((ctx && ctx.ext) || '').toLowerCase();
  if (EXTS.indexOf(ext) >= 0) return isZip(buf) ? 0.9 : 0.3;
  return 0;
}

function parse(buf, ctx) {
  const zip = openZip(buf);
  const opfPath = readContainer(zip);
  const opfDir = path.posix.dirname(opfPath);
  const opf = parseOpf(zip.text(opfPath) || '');

  /* 章节标题：优先 NCX，其次 nav.xhtml */
  let labels = new Map();
  let tocKind = '';
  try {
    let ncxPath = '';
    if (opf.tocId && opf.manifest.get(opf.tocId)) ncxPath = resolve(opfDir, opf.manifest.get(opf.tocId).href);
    if (!ncxPath) {
      opf.manifest.forEach((it) => {
        if (/nav\.x?html?$/i.test(it.href) || /nav/.test(it.props || '')) {
          if (!ncxPath) ncxPath = resolve(opfDir, it.href);
        }
      });
    }
    if (ncxPath && zip.text(ncxPath)) {
      const xml = zip.text(ncxPath);
      const list = /<navPoint\b/i.test(xml) ? parseNcx(xml) : parseNav(xml);
      list.forEach((it) => {
        const key = resolve(opfDir, it.src.replace(/^\.\//, ''));
        if (it.label && !labels.has(key)) labels.set(key, it.label);
      });
      tocKind = labels.size ? 'epub-toc' : '';
    }
  } catch (e) {
    labels = new Map();
  }

  const sections = [];
  let chars = 0;
  let paras = 0;

  /* 图片：字节跟着书一起落盘，正文里只留文件名（reader 负责按路径显示） */
  const images = { list: [], byPath: new Map() };
  function pickImage(fullPath, page) {
    const key = String(fullPath || '');
    if (!key) return '';
    if (images.byPath.has(key)) {
      const n0 = images.byPath.get(key);
      if (page && page.indexOf(n0) < 0) page.push(n0);
      return n0;
    }
    let buf = null;
    try { buf = zip.read(key); } catch (e) { buf = null; }
    if (!buf || !buf.length) return '';
    const ext = (key.match(/\.(jpe?g|png|gif|webp|svg|bmp)$/i) || [, 'jpg'])[1].toLowerCase();
    const name = 'i' + (images.list.length + 1) + '.' + ext;
    images.list.push({ name, data: buf, mime: imageMime(name) });
    images.byPath.set(key, name);
    if (page && page.indexOf(name) < 0) page.push(name);
    return name;
  }

  /* 封面：OPF 的 <meta name="cover"> → manifest properties="cover-image" → 第一张图 */
  let cover = '';
  try {
    const cov = (opf.coverId && opf.manifest.get(opf.coverId)) ||
      (() => { let hit = null; opf.manifest.forEach((it) => { if (!hit && /cover-image/i.test(it.props || '')) hit = it; }); return hit; })();
    if (cov && cov.href) cover = pickImage(resolve(opfDir, cov.href), null);
    if (!cover) {
      let firstImg = '';
      opf.manifest.forEach((it) => { if (!firstImg && /^image\//i.test(it.type || '')) firstImg = it.href; });
      if (firstImg) cover = pickImage(resolve(opfDir, firstImg), null);
    }
  } catch (e) { cover = ''; }

  const base = String((ctx && (ctx.name || ctx.path)) || '').split(/[\\/]/).pop() || '未命名';
  const fileTitle = base.replace(/\.epub$/i, '').replace(/^\s*[《<]|[》>]\s*$/g, '').trim();
  const bookTitle = (opf.title || fileTitle || '').trim();

  /* 一堆书里这些标题是模板留下的占位，不如"第 N 节" */
  const JUNK_TITLE = /^(封面|封底|书名页|扉页|标题|未知|无标题|未命名|contents|cover|title|untitled)$/i;

  function niceTitle(raw, ord) {
    let t = String(raw || '').replace(/\s+/g, ' ').trim();
    if (t.length > 60) t = t.slice(0, 60);
    if (!t) return '第 ' + ord + ' 节';
    if (JUNK_TITLE.test(t)) return '第 ' + ord + ' 节';
    if (bookTitle && t === bookTitle) return '第 ' + ord + ' 节 · 书名页';
    return t;
  }

  opf.spine.forEach((id, i) => {
    const it = opf.manifest.get(id);
    if (!it) return;
    if (it.type && !/x?html/i.test(it.type)) return;
    const file = resolve(opfDir, it.href);
    let html = null;
    try { html = zip.text(file); } catch (e) { html = null; }
    if (!html) return;

    /* 先把这一页的图挑出来：正文里留 img 块，字节收进 images（一会儿跟书一起落盘） */
    const srcMap = new Map();
    const pageImages = [];
    html.replace(/<img\b[^>]*>/gi, (tag) => {
      const src = (tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i) || [])[1];
      if (!src) return tag;
      const full = resolve(path.posix.dirname(file), src.split('#')[0]);
      const name = pickImage(full, pageImages);
      if (name) srcMap.set(src, name);
      return tag;
    });

    const blocks = htmlToBlocks(html);
    blocks.forEach((b) => {
      if (b.kind === 'img') {
        const mapped = srcMap.get(b.src);
        b.src = mapped || '';
      }
    });
    const kept = blocks.filter((b) => b.kind !== 'img' || b.src);
    blocks.length = 0;
    Array.prototype.push.apply(blocks, kept);
    if (!blocks.length) return;                    // 封面这种只有图的跳过
    let total = 0;
    blocks.forEach((b) => { if (b.kind === 'para') total += (b.text || '').length; });

    /* 先算标题再决定丢不丢：封面页常常只有"封面"两个字 + 书名，
       它的标题本身就是 JUNK_TITLE；这种不管排第几都不该进目录。 */
    let rawLabel = labels.get(file) || '';
    if (!rawLabel || JUNK_TITLE.test(rawLabel.trim())) {
      const h = html.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i);
      const t = h ? decodeEntities(stripTags(h[1])).replace(/\s+/g, ' ').trim() : '';
      if (t && t.length <= 60 && !JUNK_TITLE.test(t)) rawLabel = t;
    }
    if (!rawLabel) {
      const dt = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
      const t2 = decodeEntities(stripTags(dt)).replace(/\s+/g, ' ').trim();
      if (t2 && t2.length <= 60 && !JUNK_TITLE.test(t2)) rawLabel = t2;
    }

    /* 短页（<120 字）＝ 封面 / 版权页 / 彩插说明。除了"整本书只有这一页"，
       一律不进目录；标题是占位词或书名本身的短页也不进。 */
    const looksLikeJunk = !rawLabel || JUNK_TITLE.test(rawLabel.trim()) || (bookTitle && rawLabel.trim() === bookTitle);
    if (total < 120 && (sections.length > 0 || looksLikeJunk)) return;

    const title = niceTitle(rawLabel, sections.length + 1);

    blocks.forEach((b) => {
      if (b.kind !== 'para') return;
      chars += (b.text || '').replace(/\s/g, '').length;
      paras++;
    });
    sections.push({ title, blocks });
  });

  if (!sections.length) throw new Error('EPUB 里没有可读的正文（只有图片？）');

  return {
    format: 'epub',
    render: 'text',
    label: 'EPUB',
    encoding: 'utf-8',
    title: bookTitle || '未命名',
    author: opf.creator || '',
    sections,
    cover: cover || '',
    images: images.list,
    tocSource: tocKind || 'epub-spine',
    stats: { sections: sections.length, chars, paragraphs: paras },
    note: 'EPUB 排文字 + 章节插图/封面（原图的画质，缩放到版心宽）；自定义字体与排版样式不还原。'
  };
}

function imageMime(name) {
  const e = (String(name).match(/\.([a-z0-9]+)$/i) || [, 'jpg'])[1].toLowerCase();
  if (e === 'png') return 'image/png';
  if (e === 'gif') return 'image/gif';
  if (e === 'webp') return 'image/webp';
  if (e === 'svg') return 'image/svg+xml';
  if (e === 'bmp') return 'image/bmp';
  return 'image/jpeg';
}

module.exports = { id: 'epub', EXTS, probe, parse, hasMagic, openZip, htmlToBlocks, parseOpf, parseNcx, decodeEntities };
