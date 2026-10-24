'use strict';
/**
 * 编码探测。
 *
 * 中文 txt 十有八九不是 UTF-8：网上抓的旧稿大多是 GBK/GB18030，
 * 也有 Windows 记事本存的带 BOM 的 UTF-8、或者 UTF-16。
 * 判错了整本书都是方块，所以这里比"试试 utf-8"要认真一点：
 *
 *   1. BOM 优先（UTF-8 BOM / UTF-16LE / UTF-16BE）
 *   2. 没有 BOM 但零字节分布规律 → 判 UTF-16
 *   3. UTF-8 严格模式（fatal:true）能过就是 UTF-8 —— 前提是 fatal，
 *      默认行为是遇非法字节塞 � 不报错，那样永远判不出来
 *   4. 否则在 gb18030 / big5 里按"乱码分"取最低的（gb18030 是 GBK 超集，排前面）
 */

/** 超过这个大小的文件不进内存：导入器会直接拒绝，别把应用拖死 */
const MAX_BYTES = 200 * 1024 * 1024;

function decodeAs(buf, enc) {
  if (enc === 'utf-16be') {
    /* WHATWG 里有 utf-16be，但行为随 Node/ICU 版本漂；手工换字节最稳 */
    const a = Buffer.from(buf.length % 2 ? buf.subarray(0, buf.length - 1) : buf);
    a.swap16();
    return a.toString('utf16le');
  }
  return new TextDecoder(enc).decode(buf);
}

/** 乱码打分：U+FFFD 最重（解码器自己报的错），控制字符次之 */
function garbleScore(text) {
  const n = Math.min(text.length, 200000);
  let bad = 0;
  let ctrl = 0;
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c === 0xfffd) bad++;
    else if (c === 0) ctrl += 4;
    else if (c < 9 || (c > 13 && c < 32)) ctrl++;
  }
  return bad * 100 + ctrl * 10;
}

/** 靠零字节分布猜 UTF-16（英文为主时零字节很多，中文则是每隔一个字节一个零） */
function sniffUtf16(buf) {
  const n = Math.min(buf.length, 8192);
  if (n < 16) return null;
  let even0 = 0;
  let odd0 = 0;
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) { if (i % 2 === 0) even0++; else odd0++; }
  }
  const half = n / 2;
  if (odd0 > half * 0.4 && even0 < half * 0.15) return 'utf-16le';
  if (even0 > half * 0.4 && odd0 < half * 0.15) return 'utf-16be';
  return null;
}

/**
 * 二进制程度：返回 0..1。文本里不该出现的字节越多，越像二进制。
 * registry 用它给"认不出的文件"判该走纯文本还是系统程序。
 */
function binaryRatio(buf) {
  const n = Math.min(buf.length, 65536);
  if (!n) return 0;
  let odd = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0) { odd += 8; continue; }
    if (b < 7 || (b > 13 && b < 32)) odd++;
  }
  const r = odd / n;
  return r > 1 ? 1 : r;
}

/** 返回 { text, enc, lossy } —— lossy 表示"没把握，按最像的那种解出来的" */
function decodeText(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  if (!b.length) return { text: '', enc: 'utf-8', lossy: false };

  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
    return { text: decodeAs(b.subarray(3), 'utf-8'), enc: 'utf-8-bom', lossy: false };
  }
  if (b[0] === 0xff && b[1] === 0xfe) {
    return { text: decodeAs(b.subarray(2), 'utf-16le'), enc: 'utf-16le', lossy: false };
  }
  if (b[0] === 0xfe && b[1] === 0xff) {
    return { text: decodeAs(b.subarray(2), 'utf-16be'), enc: 'utf-16be', lossy: false };
  }
  const u16 = sniffUtf16(b);
  if (u16) return { text: decodeAs(b, u16), enc: u16, lossy: false };

  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(b), enc: 'utf-8', lossy: false };
  } catch (e) { /* 不是合法 UTF-8，往下试中文编码 */ }

  let best = null;
  ['gb18030', 'big5'].forEach((enc) => {
    let t;
    try { t = decodeAs(b, enc); } catch (e) { return; }
    const s = garbleScore(t);
    if (!best || s < best.score) best = { text: t, enc, score: s };
  });
  if (best) return { text: best.text, enc: best.enc, lossy: best.score > 0 };

  return { text: new TextDecoder('utf-8').decode(b), enc: 'utf-8', lossy: true };
}

module.exports = { MAX_BYTES, decodeText, decodeAs, binaryRatio, sniffUtf16, garbleScore };
