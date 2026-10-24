/**
 * wenku8（轻小说文库）书目 / 目录 / 正文的抓取与解析。
 *
 * 这里只做"把 HTML 变成结构化数据"，不做网络：网络由主进程注入
 * （优先用内嵌窗口那个 partition 的 session.fetch，这样用户在窗口里过掉的
 *  Cloudflare 验证会一并复用；拿不到再退回普通请求）。
 *
 * 页面形态（2026-10 实测）：
 *   书目  /book/<bid>.htm                     书名/作者/封面/简介
 *   目录  /novel/<type>/<bid>/index.htm       每章 <cid>.htm，相对链接
 *   正文  /novel/<type>/<bid>/<cid>.htm       正文在 id="content" 里
 */
'use strict';

const BASE = 'https://www.wenku8.net';

/** 从"书页链接 / 目录链接 / 纯书号"里取出 bid 与 type。 */
function parseRef(input) {
  const s = String(input || '').trim();
  if (/^\d+$/.test(s)) return { bid: Number(s), type: 0 };
  const m = s.match(/\/book\/(\d+)\.htm/i) || s.match(/[?&]id=(\d+)/i) || s.match(/\/novel\/(\d+)\/(\d+)\//i);
  if (m) {
    if (m.length === 3) return { bid: Number(m[2]), type: Number(m[1]) };
    return { bid: Number(m[1]), type: 0 };
  }
  return null;
}

function bookUrl(bid) {
  return BASE + '/book/' + bid + '.htm';
}
function tocUrl(bid, type) {
  return BASE + '/novel/' + (type || 0) + '/' + bid + '/index.htm';
}

function stripTags(s) {
  return String(s || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

/** 书目页 → { bid, title, author, cover, intro, tags } */
function parseBook(html, bid) {
  const h = String(html || '');
  const pageTitle = (h.match(/<title>([^<]*)<\/title>/i) || [])[1] || '';
  /* "书名 - 作者 - 文库 - 轻小说文库" */
  const parts = pageTitle.split(/\s+-\s+/).map((x) => x.trim()).filter(Boolean);
  const title = parts[0] || ('书号 ' + bid);
  const author = parts[1] || '';
  /* 封面：第一张来自 img.wenku8.com/image/ 的图（后面那些是"相关推荐"） */
  const coverSrc = (h.match(/<img[^>]+src="([^"]*img\.wenku8\.com\/image\/[^"]+)"/i) || [])[1] ||
    (h.match(/<img[^>]+src="([^"]*\/image\/\d+\/\d+\/[^"]+)"/i) || [])[1] || '';
  const cover = coverSrc ? (coverSrc.startsWith('http') ? coverSrc : BASE + coverSrc).replace(/^http:/i, 'https:') : '';
  /* 简介：内容简介：</span><br /><span …>正文</span> */
  const introMatch = h.match(/内容简介[：:][\s\S]{0,80}?<span[^>]*>([\s\S]*?)<\/span>/i) ||
    h.match(/id="content"[^>]*>([\s\S]*?)<\/div>/i);
  const intro = introMatch ? stripTags(introMatch[1]).replace(/\s+/g, ' ').replace(/\[[^\]]{0,10}\]/g, '').trim() : '';
  const tags = [...h.matchAll(/<a[^>]+href="[^"]*tags\.php[^"]*"[^>]*>([^<]+)<\/a>/gi)].map((m) => m[1].trim()).filter(Boolean);
  const latest = (h.match(/最近章节[：:][\s\S]{0,200}?<a href="([^"]+)"[^>]*>([^<]*)<\/a>/i) || []);
  /* 目录地址只能从书页里读：type 不一定是 0（例如 1973 是 /novel/1/1973/），猜错就 404 */
  const tocRaw = (h.match(/href="([^"]*\/novel\/(\d+)\/\d+\/index\.htm)"[^>]*>[^<]*(?:目录|查看目录|章节目录)/i) ||
    h.match(/href="([^"]*\/novel\/(\d+)\/\d+\/index\.htm)"/i) || []);
  const tocPath = tocRaw[1] || '';
  const tocType = tocRaw[2] != null ? Number(tocRaw[2]) : null;
  return {
    bid: Number(bid), title: title, author: author, cover: cover, intro: intro, tags: tags,
    latest: latest[2] ? latest[2].trim() : '', url: bookUrl(bid),
    tocPath: tocPath, tocType: tocType
  };
}

/** 目录页 → [{ cid, title, url }]（保持书里的顺序） */
function parseToc(html, bid, type) {
  const h = String(html || '');
  const out = [];
  const seen = {};
  const re = /<a[^>]+href="(\d+)\.htm"[^>]*>([^<]{1,80})<\/a>/gi;
  let m;
  while ((m = re.exec(h))) {
    const cid = Number(m[1]);
    const title = stripTags(m[2]).replace(/\s+/g, ' ').trim();
    if (!cid || !title || seen[cid]) continue;
    seen[cid] = 1;
    out.push({
      cid: cid,
      title: title,
      url: BASE + '/novel/' + (type || 0) + '/' + bid + '/' + cid + '.htm'
    });
    if (out.length >= 500) break;
  }
  return out;
}

/** 取 id="content" 那个 div 的完整内部 HTML：按 <div> 深度配对，
 *  否则内层 <div class="imgbox"> 的 </div> 会把后文整段截掉。 */
function contentDiv(html) {
  const h = String(html || '');
  const open = h.search(/<div[^>]*id="content"[^>]*>/i);
  if (open < 0) return '';
  const tagEnd = h.indexOf('>', open);
  if (tagEnd < 0) return '';
  let i = tagEnd + 1;
  let depth = 1;
  const re = /<div\b[^>]*>|<\/div\s*>/gi;
  re.lastIndex = i;
  let m;
  while ((m = re.exec(h))) {
    if (/^<\/div/i.test(m[0])) {
      depth -= 1;
      if (depth === 0) return h.slice(i, m.index);
    } else {
      depth += 1;
    }
  }
  return h.slice(i);
}

const NOISE = [
  /本文来自\s*轻小说文库/i,
  /轻之国度/i,
  /^\s*翻译[:：]/,
  /^\s*校对[:：]/,
  /^\s*录入[:：]/,
  /^\s*图源[:：]/,
  /^\s*生肉[:：]/,
  /^\s*感谢.{0,20}贴吧/,
  /^\s*转自\s*/,
  /转自.{0,12}(论坛|文库|轻书架|贴吧)/,
  /^\s*(台版|日版|网译版|文库版)\s*转自/,
  /录入组?$/,
  /^\s*轻书架/,
  /^\s*$/
];

/** 正文页 → { title, blocks: [段...] }（去掉站方水印与译制信息） */
function parseChapterRich(html) {
  const raw = String(html || '');
  let body = contentDiv(raw) || raw;
  const imgs = [];
  body = body.replace(/<img[^>]*src="([^"]+)"[^>]*>/gi, function (_all, src) {
    imgs.push(src);
    return '\n§IMG' + (imgs.length - 1) + '§\n';
  });
  body = body.replace(/<br\s*\/?>/gi, '\n');
  body = body.replace(/<\/p>/gi, '\n');
  const lines = body.replace(/<[^>]+>/g, '').split('\n').map(function (x) { return x.trim(); });
  const blocks = [];
  const marks = [];
  lines.forEach(function (ln) {
    const mm = ln.match(/^§IMG(\d+)§$/);
    if (mm) { marks.push({ at: blocks.length, i: Number(mm[1]) }); return; }
    if (!ln) return;
    if (NOISE.test(ln)) return;
    if (/^[\s·—\-–—=]+$/.test(ln)) return;
    blocks.push(ln);
  });
  return { blocks: blocks, imgs: imgs, marks: marks };
}

function parseChapter(html) {
  const h = String(html || '');
  const title = (h.match(/<title>([^<]*)<\/title>/i) || [])[1] || '';
  let raw = contentDiv(h);
  /* 图片：stripTags 会把 <img> 整个吃掉，正文就"断"在那里。
     先换成独立占位行，后面由下载流程抓图并换成真图片块。 */
  raw = raw.replace(/<img[^>]*src="([^"]+)"[^>]*>/gi, function (_all, src) {
    return '\n@@WKIMG:' + String(src).replace(/\s/g, '') + '@@\n';
  });
  raw = raw.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n');
  const text = stripTags(raw).replace(/\r/g, '');
  const lines = text.split('\n').map((x) => x.replace(/[ \t\u3000]+/g, ' ').trim());
  const blocks = [];
  lines.forEach((line) => {
    if (!line) return;
    if (NOISE.some((re) => re.test(line))) return;
    /* 站方在正文尾部塞的"最新最全…"之类宣传 */
    if (/最新最全的日本动漫轻小说/.test(line)) return;
    /* 站点把图片 alt 文本单独留成一行：丢掉，图片由 @@WKIMG 占位负责 */
    if (/^[!！]?\[图片\]\(?\s*$/.test(line)) return;
    blocks.push(line);
  });
  return { title: title.replace(/\s*-\s*轻小说文库.*$/, '').trim(), blocks: blocks };
}

/** 并发为 1 的整本抓取（限速，别把人家站打死） */
async function fetchAll(toc, getChapter, opts) {
  const o = opts || {};
  const wait = typeof o.delayMs === 'number' ? o.delayMs : 320;
  const onProgress = o.onProgress || function () {};
  const stopAt = o.maxChapters || toc.length;
  const out = [];
  for (let i = 0; i < toc.length && i < stopAt; i++) {
    const ch = toc[i];
    let blocks = [];
    try {
      const page = await getChapter(ch.url);
      blocks = parseChapter(page).blocks;
    } catch (e) {
      blocks = ['（这一章没抓下来：' + ((e && e.message) || e) + '）'];
    }
    out.push({ title: ch.title, blocks: blocks });
    onProgress(i + 1, Math.min(toc.length, stopAt));
    if (i + 1 < toc.length && i + 1 < stopAt && wait) {
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  return out;
}



/** 把抓下来的章节拼成一本 txt。
 *  注意：书库的 txt 目录是靠正文里「第N章」这类整行标题切节的，
 *  而 wenku8 的标题是「序章」「插图」「第一章 xxx」混着来——不规范化，目录就会乱成一团。
 */
function tidyTitle(raw, ordinal) {
  let t = stripTags(raw || '').replace(/\s+/g, ' ').trim();
  t = t.replace(/^第[0-9零一二三四五六七八九十百千两]{1,8}[章节回卷篇集部幕][\s:：.、-]*/, '');
  t = t.replace(/^(序章|序幕|序|终章|尾声|尾聲|后记|後記|番外|插图|插圖|彩页|彩頁|目录|目錄)[\s:：.、-]*/, '');
  t = t.replace(/[\r\n]+/g, ' ').trim();
  if (!t) t = '正文';
  if (t.length > 24) t = t.slice(0, 24);
  return '第' + ordinal + '章 ' + t;
}

function toTxt(book, chapters) {
  const head = [
    book.title || '',
    book.author ? '作者：' + book.author : ''
  ].filter(Boolean).join('\n');
  const parts = [];
  let n = 0;
  (chapters || []).forEach((c) => {
    const body = (c.blocks || []).join('\n\n').trim();
    if (!body || body.length < 30) return;          // 插图页/空页直接跳过
    n += 1;
    parts.push('\n\n' + tidyTitle(c.title, n) + '\n\n' + body);
  });
  return head + '\n' + parts.join('') + '\n';
}


/** 解析站内搜索结果页：按「链接是不是 /book/<id>.htm」认，标题取锚文本 */
/* 搜索结果只在 <table class="grid"> 里；侧栏的推荐/最新/排行榜也是 /book/N.htm，
   整页扫就会搜出一堆无关的书。这里先把结果表切出来。 */
function searchRegion(html) {
  const src = String(html || '');
  const i = src.search(/<table[^>]*class="[^"]*grid[^"]*"/i);
  if (i < 0) return src;
  const j = src.indexOf('</table>', i);
  return j > i ? src.slice(i, j) : src.slice(i);
}

/* 书名归一化后做「包含」或「最长公共子串」判断：过滤掉搜索页里的推荐位 */
function normTitle(t) {
  return String(t || '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[!-~]/g, (ch) => ch.toLowerCase())
    .replace(/[『』「」《》〈〉()（）\[\]【】!！?？,，.。、·…~～:：;；'"“”‘’—－-]/g, '');
}

function filterByQuery(items, q) {
  const list = Array.isArray(items) ? items : [];
  const nq = normTitle(q);
  if (!nq) return list;
  const kept = [];
  list.forEach((it) => {
    const nt = normTitle(it.title);
    if (!nt) return;
    if (nt.indexOf(nq) >= 0 || nq.indexOf(nt) >= 0) {
      kept.push(it);
      return;
    }
    /* 书名可能带副标题/外传名，用「查询串前 4 字」兜一层 */
    const probe = nq.slice(0, Math.min(4, nq.length));
    if (probe.length >= 2 && nt.indexOf(probe) >= 0) kept.push(it);
  });
  return kept;
}

function parseSearch(html, limit) {
  const max = Math.max(1, Math.min(60, Number(limit) || 30));
  const out = [];
  const seen = {};
  const region = searchRegion(html);
  const re = /<a[^>]+href="([^"]*\/book\/(\d+)\.htm)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(region)) !== null && out.length < max) {
    const bid = Number(m[2]);
    const title = stripTags(m[3]).replace(/\s+/g, " ").trim();
    if (!bid || !title || title.length > 60) continue;
    if (seen[bid]) continue;
    seen[bid] = 1;
    out.push({ bid: bid, title: title, url: bookUrl(bid) });
  }
  return out;
}


/** 从 Bing 结果页里捞 wenku8 的书号（不需要登录，站点被 CF 挡时这是兜底） */
function parseBing(html, limit) {
  const max = Math.max(1, Math.min(40, Number(limit) || 20));
  const out = [];
  const seen = {};
  const re = /https?:\/\/(?:www\.)?wenku8\.net\/book\/(\d+)\.htm/gi;
  const text = String(html || "");
  let m;
  while ((m = re.exec(text)) !== null && out.length < max) {
    const bid = Number(m[1]);
    if (!bid || seen[bid]) continue;
    seen[bid] = 1;
    out.push({ bid: bid, title: "书号 " + bid, url: bookUrl(bid) });
  }
  return out;
}


/** 从搜狗/360 的搜索结果里捞 wenku8 书号（顺带拿标题，搜狗给了 data-title） */
function parseWebSearch(html, limit) {
  const max = Math.max(1, Math.min(40, Number(limit) || 20));
  const out = [];
  const seen = {};
  const text = String(html || "");

  function push(bid, title) {
    const id = Number(bid);
    if (!id || seen[id] || out.length >= max) return;
    seen[id] = 1;
    out.push({ bid: id, title: (title || "").trim() || ("书号 " + id), url: bookUrl(id) });
  }

  /* 搜狗：data-url + data-title（标题是 URL 编码） */
  const reSogou = /data-url="https?:\/\/(?:www\.)?wenku8\.net\/book\/(\d+)\.htm"[^>]*?data-title="([^"]*)"/gi;
  let m;
  while ((m = reSogou.exec(text)) !== null) {
    let t = m[2] || "";
    try { t = decodeURIComponent(t); } catch (e) { /* 保留原文 */ }
    t = t.split(" - ")[0].replace(/\s+/g, " ").trim();
    push(m[1], t);
  }
  if (out.length) return out;

  /* 兜底：裸链接（360 的"相关搜索"就是这种），标题留给详情页去补 */
  const reAny = /wenku8\.net\/book\/(\d+)\.htm/gi;
  while ((m = reAny.exec(text)) !== null) push(m[1], "");
  return out;
}


/** 解析 /modules/article/alpha.php?alpha=B 这种索引页：一行一个「书名 + /book/N.htm」 */
function parseAlpha(html) {
  const out = [];
  const seen = {};
  const text = String(html || "");
  const re = /<a[^>]+href="[^"]*\/book\/(\d+)\.htm"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const bid = Number(m[1]);
    const title = stripTags(m[2]).replace(/\s+/g, " ").trim();
    if (!bid || !title || title.length > 60 || seen[bid]) continue;
    seen[bid] = 1;
    out.push({ bid: bid, title: title });
  }
  return out;
}

module.exports = {
  contentDiv: contentDiv,
  parseListing,
  searchRegion,
  filterByQuery,
  normTitle,
  BASE,
  parseRef,
  bookUrl,
  tocUrl,
  parseBook,
  parseToc,
  parseChapter,
  fetchAll,
  toTxt,
  parseSearch,
  parseBing,
  parseWebSearch,
  parseAlpha,
  tidyTitle,
  stripTags
};

/* 书单页（字母索引 / 排行榜 / 分类）：把"封面 + 书名 + 作者 + 书号"提出来 */
/* 书单页的正文在 <table class="grid"> 里；侧栏的「最新更新/排行榜」也是 /book/N.htm，
   整页扫就会把「排行榜」解析成和「全部」一样的结果。 */
function listRegion(html) {
  const t = String(html || '');
  const m = t.match(/<table[^>]*class="[^"]*grid[^"]*"[\s\S]*?<\/table>/i);
  if (m) return m[0];
  const c = t.match(/<div[^>]+id="content"[^>]*>([\s\S]*?)<\/div>/i);
  return c ? c[1] : '';
}

function parseListing(html, limit) {
  const out = [];
  const page = String(html || '');
  const region = listRegion(page);
  const src = region || page;
  const rowRe = /<a[^>]+href="(?:https?:\/\/[^"]*)?\/book\/(\d+)\.htm"[^>]*>([\s\S]{0,120}?)<\/a>/gi;
  let m;
  while ((m = rowRe.exec(src))) {
    const id = m[1];
    const inner = m[2];
    const title = inner.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!title || title.length < 2) continue;
    if (out.some((x) => x.bid === id)) continue;
    out.push({ bid: id, title: title, author: '', cover: '', url: 'https://www.wenku8.net/book/' + id + '.htm' });
    if (out.length >= (limit || 60)) break;
  }
  /* 同一块里通常紧跟 <img src="…s.jpg"> 与作者链接，粗粒度补一遍 */
  out.forEach((it) => {
    const seg = src.slice(Math.max(0, src.indexOf('/book/' + it.bid + '.htm') - 400), src.indexOf('/book/' + it.bid + '.htm') + 900);
    const im = seg.match(/img\.wenku8\.com\/image\/[^"']+/i);
    if (im) it.cover = 'https://' + im[0].replace(/^https?:\/\//, '');
    const au = seg.match(/author\.php\?author=[^"]*"[^>]*>([^<]{2,20})</i);
    if (au) it.author = au[1].trim();
  });
  return out;
}

