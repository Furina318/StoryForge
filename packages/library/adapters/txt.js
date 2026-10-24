'use strict';
/**
 * 纯文本 adapter。
 *
 * 只负责"这是一份文本，帮我切出目录"，编码、分段这些事情都交给 encoding/toc。
 * 判不出来（比如 .dat 里其实是 txt）也没关系：registry 会把候选里分最高的挑出来。
 */
const { decodeText, binaryRatio } = require('../encoding');
const toc = require('../toc');

const EXTS = ['txt', 'text', 'log', 'novel'];

function guessTitle(ctx) {
  const base = String((ctx && (ctx.name || ctx.path)) || '').split(/[\\/]/).pop() || '未命名';
  return base.replace(/\.(txt|text|log|novel)$/i, '').replace(/^《|》$/g, '').replace(/作者[:：].*$/, '').trim() || '未命名';
}

function probe(buf, ctx) {
  const ext = String((ctx && ctx.ext) || '').toLowerCase();
  let s = EXTS.indexOf(ext) >= 0 ? 0.7 : 0;
  if (binaryRatio(buf) > 0.05) return s ? 0.1 : 0;   // 二进制文件别抢文本的活
  s += 0.15;
  /* 正文里有几行像"第N章"，说明它确实像本小说，给点加成 */
  const head = decodeText(buf.subarray(0, 64 * 1024)).text;
  let hits = 0;
  head.split('\n').forEach((line) => { if (toc.chapterTitle(line)) hits++; });
  if (hits >= 2) s += 0.1;
  return Math.min(s, 0.98);
}

function parse(buf, ctx) {
  const dec = decodeText(buf);
  const r = toc.parseTxt(dec.text);
  return {
    format: 'txt',
    render: 'text',
    label: '纯文本',
    encoding: dec.enc,
    title: guessTitle(ctx),
    sections: r.sections,
    tocSource: r.tocSource,
    stats: r.stats,
    note: dec.lossy ? '编码不太确定：按 ' + dec.enc + ' 读的，如果满屏乱码请用「换编码重读」' : ''
  };
}

module.exports = { id: 'txt', EXTS, probe, parse, guessTitle };
