'use strict';
/**
 * 目录提取：纯函数，不碰磁盘，方便单测（test/library/run.js）。
 *
 * 两种输入：
 *   parseTxt(text) —— 中文小说 txt，靠正文里的"第N章"行切节；
 *   parseMd(text)  —— Markdown，靠标题层级切节。
 *
 * 所有判断都往"宁可少切，不要乱切"偏：切错了用户会看到一堆空章节，
 * 不如整本一节 + 自动分段（还能靠阅读器自带的进度条翻）。
 */

const CN_NUM = '零一二三四五六七八九十百千万两廿卅0-9０-９';

/** 整行就是一个章节标题的几种写法。注意都要求"整行匹配"，正文里的"第三章"不算。 */
const CH_TXT = [
  new RegExp('^(第[' + CN_NUM + ']{1,8}[章回节卷篇集部幕][^\\n]{0,30})$'),
  /^(Chapter\s+[0-9IVXLCivxlc]{1,6}[^\n]{0,30})$/,
  new RegExp('^(卷[' + CN_NUM + ']{1,6}[^\\n]{0,30})$'),
  /^(楔子|序章|序言|前言|引子|尾声|后记|终章|番外[^\n]{0,20})$/,
  /^([0-9０-９]{1,3}[、.．][^\n]{0,30})$/
];

function normalize(s) {
  return String(s == null ? '' : s)
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '');
}

/** 一行是不是章节标题；是就返回标题文本，不是返回 null */
function chapterTitle(line) {
  const t = String(line == null ? '' : line).trim();
  if (!t || t.length > 40) return null;
  /* 标题不会以句末标点收尾——这条挡掉了正文里"第三章讲的是…"这类句子 */
  if (/[。！？…]$/.test(t)) return null;
  for (let i = 0; i < CH_TXT.length; i++) {
    const m = t.match(CH_TXT[i]);
    if (m) return m[1].trim();
  }
  return null;
}

/**
 * 判断这份 txt 是"一行一段"还是"空行分段"（Word 另存的硬换行）。
 *
 * 两条判据，任一命中就算"一行一段"：
 *   1. 几乎没有空行（<5%）——纯 txt 导出的典型形态；
 *   2. 非空行里"以句末标点收尾"的比例 ≥60%——"每段一行 + 章间空一行"的形态。
 *
 * 为什么第 2 条必要：网文 txt 常在每章之间插一个空行，空行占比会到 15% 以上，
 * 只看空行会把整章 six 段粘成一段（阅读器里就是一个巨大的段落）。
 * 为什么第 2 条够安全：硬换行（按宽度折断）时一句话被切在中间，
 * 只有每段最后一行才以句号收尾，比例通常只有一两成。
 */
function oneParagraphPerLine(lines) {
  let nonEmpty = 0;
  let blank = 0;
  let ended = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) { blank++; continue; }
    nonEmpty++;
    if (/[。！？…；;:："'」』]$/.test(t) && t.length >= 12) ended++;
  }
  if (!nonEmpty) return true;
  if (blank / nonEmpty < 0.05) return true;
  return ended / nonEmpty >= 0.6;
}

/** 把正文切成段落（kind=para），并挑出章节标题（kind=head） */
function paragraphize(text) {
  const lines = normalize(text).split('\n');
  const oneLine = oneParagraphPerLine(lines);
  const items = [];
  let buf = [];
  const flush = () => {
    if (!buf.length) return;
    const t = buf.join('\n').trim();
    buf = [];
    if (t) items.push({ kind: 'para', text: t });
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+$/, '');
    if (!line.trim()) { if (!oneLine) flush(); continue; }
    if (oneLine) {
      const t = line.trim();
      const head = chapterTitle(t);
      items.push(head ? { kind: 'head', text: t, title: head, level: 1 } : { kind: 'para', text: t });
    } else {
      /* 空行分段模式也要认标题：'第一章 xxx' 自己占一行时不能糊进上一段 */
      const h = chapterTitle(line.trim());
      if (h) {
        flush();
        items.push({ kind: 'head', text: line.trim(), title: h, level: 1 });
        continue;
      }
      buf.push(line);
    }
  }
  flush();
  return { items, oneLine };
}

/** 章节候选要过这几道闸，否则当"没检测到目录"处理 */
function pickHeadings(items) {
  const hits = [];
  for (let i = 0; i < items.length; i++) {
    if (items[i].kind === 'head') hits.push({ i, title: items[i].title });
  }
  if (hits.length < 2 || hits.length > 800) return null;
  /* 第一个标题不该出现在书中很靠后的位置——那多半是正文里的巧合 */
  if (hits[0].i > items.length * 0.15) return null;
  return hits;
}

function blockOf(it) {
  if (it.kind === 'head') return { kind: 'heading', level: it.level || 1, text: it.text };
  return { kind: 'para', text: it.text };
}

/**
 * 按标题切节。每节 = { title, blocks[] }，标题本身不重复放进正文
 * （阅读视图会在节首自己画 h2，避免"标题出现两次"）。
 */
function groupByHeadings(items, hits) {
  const secs = [];
  const pre = [];
  for (let i = 0; i < hits[0].i; i++) if (items[i].kind === 'para') pre.push(blockOf(items[i]));
  if (pre.length) secs.push({ title: '开头', blocks: pre });
  for (let k = 0; k < hits.length; k++) {
    const start = hits[k].i + 1;
    const end = k + 1 < hits.length ? hits[k + 1].i : items.length;
    const blocks = [];
    for (let i = start; i < end; i++) {
      if (items[i].kind === 'para') blocks.push(blockOf(items[i]));
    }
    secs.push({ title: hits[k].title, blocks });
  }
  return secs;
}

/** 没检测到目录时的兜底：按字数切，一节约 3000 字，标题写成"第 N 节 · 自动分段" */
function autoSections(items, target) {
  const cap = target || 3000;
  const secs = [];
  let cur = [];
  let n = 0;
  const push = () => {
    if (!cur.length) return;
    secs.push({ title: '第 ' + (secs.length + 1) + ' 节 · 自动分段', blocks: cur });
    cur = [];
    n = 0;
  };
  for (let i = 0; i < items.length; i++) {
    if (items[i].kind !== 'para') continue;
    cur.push(blockOf(items[i]));
    n += items[i].text.length;
    if (n >= cap) push();
  }
  push();
  return secs;
}

function countChars(sections) {
  let n = 0;
  let paras = 0;
  sections.forEach((s) => (s.blocks || []).forEach((b) => {
    if (b.kind === 'para') { paras++; n += b.text.replace(/\s/g, '').length; }
  }));
  return { chars: n, paragraphs: paras };
}

function parseTxt(text) {
  const { items, oneLine } = paragraphize(text);
  const hits = pickHeadings(items);
  const sections = hits ? groupByHeadings(items, hits) : autoSections(items);
  const stat = countChars(sections);
  return {
    sections,
    tocSource: hits ? 'txt-regex' : 'auto',
    oneParagraphPerLine: oneLine,
    stats: Object.assign({ sections: sections.length }, stat)
  };
}

/* ---------------- Markdown ---------------- */

function splitFrontmatter(text) {
  const t = normalize(text);
  if (!/^---\n/.test(t)) return { frontmatter: {}, body: t };
  const end = t.indexOf('\n---', 4);
  if (end < 0) return { frontmatter: {}, body: t };
  const raw = t.slice(4, end);
  const fm = {};
  raw.split('\n').forEach((line) => {
    const m = line.match(/^([A-Za-z0-9_\-\u4e00-\u9fa5]+)\s*:\s*(.*)$/);
    if (m) fm[m[1].toLowerCase()] = m[2].replace(/^["']|["']$/g, '').trim();
  });
  const bodyStart = t.indexOf('\n', end + 4);
  return { frontmatter: fm, body: t.slice(bodyStart < 0 ? t.length : bodyStart + 1) };
}

const RE_FENCE = /^(```|~~~)/;
const RE_ATX = /^(#{1,6})\s+(.*\S)\s*$/;
const RE_SETEXT = /^(=+|-+)$/;
const RE_HR = /^\s{0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/;
const RE_QUOTE = /^\s{0,3}>\s?/;
const RE_LIST = /^\s{0,3}([-*+]|\d{1,3}[.)])\s+/;
const RE_TABLE = /^\s{0,3}\|.*\|/;

/**
 * Markdown → 块。
 * 代码围栏必须是状态机：否则 ```js 里的 `# 这是注释` 会被当成标题，
 * 整本书的目录就会多出几十个"注释"。
 */
function parseMdBlocks(body) {
  const lines = normalize(body).split('\n');
  const blocks = [];
  let para = [];
  let inFence = false;
  let fenceMark = '';
  let code = [];

  const flushPara = () => {
    if (!para.length) return;
    const t = para.join('\n').trim();
    para = [];
    if (t) blocks.push({ kind: 'para', text: t });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trim = line.trim();

    if (inFence) {
      if (trim.indexOf(fenceMark) === 0) {
        blocks.push({ kind: 'code', text: code.join('\n') });
        code = [];
        inFence = false;
        fenceMark = '';
      } else {
        code.push(line);
      }
      continue;
    }
    if (RE_FENCE.test(trim)) {
      flushPara();
      inFence = true;
      fenceMark = trim.slice(0, 3);
      continue;
    }
    if (!trim) { flushPara(); continue; }

    const atx = trim.match(RE_ATX);
    if (atx) {
      flushPara();
      blocks.push({ kind: 'heading', level: atx[1].length, text: atx[2].trim() });
      continue;
    }
    /* setext 标题：下一行全是 = 或 - */
    const nextLine = i + 1 < lines.length ? lines[i + 1].trim() : '';
    if (trim && nextLine && RE_SETEXT.test(nextLine) && !/^[-=]/.test(trim) && trim.length <= 80) {
      flushPara();
      blocks.push({ kind: 'heading', level: nextLine[0] === '=' ? 1 : 2, text: trim });
      i++;
      continue;
    }
    if (RE_HR.test(trim)) { flushPara(); blocks.push({ kind: 'hr', text: '' }); continue; }
    if (RE_QUOTE.test(line)) { flushPara(); blocks.push({ kind: 'quote', text: trim.replace(/^>\s?/, '') }); continue; }
    if (RE_TABLE.test(trim)) { flushPara(); blocks.push({ kind: 'code', text: trim }); continue; }
    if (RE_LIST.test(trim)) {
      flushPara();
      const m = trim.match(RE_LIST);
      const ordered = /\d/.test(m[1]);
      blocks.push({ kind: 'list', ordered, text: trim.replace(RE_LIST, '') });
      continue;
    }
    para.push(line);
  }
  if (inFence && code.length) blocks.push({ kind: 'code', text: code.join('\n') });
  flushPara();
  return blocks;
}

/** 取标题层级里最小的那一级作为分节层级（通常是 # 或 ##） */
function sectionLevel(blocks) {
  let min = 7;
  blocks.forEach((b) => { if (b.kind === 'heading' && b.level < min) min = b.level; });
  if (min > 3) min = 3;
  return min === 7 ? 2 : min;
}

function groupMd(blocks, level) {
  const secs = [];
  let cur = { title: '', blocks: [] };
  const flush = () => {
    if (cur.blocks.length || cur.title) secs.push({ title: cur.title || '正文', blocks: cur.blocks });
    cur = { title: '', blocks: [] };
  };
  blocks.forEach((b) => {
    if (b.kind === 'heading' && b.level === level) { flush(); cur.title = b.text; return; }
    cur.blocks.push(b);
  });
  flush();
  return secs.filter((s) => s.blocks.length || s.title !== '正文');
}

function parseMd(text) {
  const { frontmatter, body } = splitFrontmatter(text);
  const blocks = parseMdBlocks(body);
  const level = sectionLevel(blocks);
  let sections = groupMd(blocks, level);
  if (!sections.length) sections = [{ title: '正文', blocks: [{ kind: 'para', text: body.trim() }] }];
  const headings = blocks.filter((b) => b.kind === 'heading').length;
  const stat = countChars(sections);
  return {
    sections,
    title: frontmatter.title || (sections[0] && sections[0].title !== '正文' ? sections[0].title : '') || '',
    author: frontmatter.author || '',
    tocSource: headings ? 'md-heading' : 'auto',
    stats: Object.assign({ sections: sections.length, headings }, stat)
  };
}

module.exports = {
  normalize,
  chapterTitle,
  paragraphize,
  parseTxt,
  parseMd,
  parseMdBlocks,
  autoSections,
  countChars,
  RE_FENCE
};
