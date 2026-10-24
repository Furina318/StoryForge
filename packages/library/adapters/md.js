'use strict';
/**
 * Markdown adapter。
 *
 * 只管"结构"：标题、围栏代码、引用、列表、分隔线。
 * 行内样式（**粗**、`代码`、[链接](…)）留给阅读视图渲染时处理，
 * 因为那部分必须配合 esc() 做转义，在 UI 层统一做才不会漏。
 */
const { decodeText, binaryRatio } = require('../encoding');
const toc = require('../toc');

const EXTS = ['md', 'markdown', 'mdown', 'mkd'];

function probe(buf, ctx) {
  const ext = String((ctx && ctx.ext) || '').toLowerCase();
  let s = EXTS.indexOf(ext) >= 0 ? 0.85 : 0;
  if (binaryRatio(buf) > 0.05) return s ? 0.1 : 0;
  const head = decodeText(buf.subarray(0, 32 * 1024)).text;
  let md = 0;
  if (/^---\n[\s\S]{0,400}?\n---\n/.test(head)) md += 2;          // frontmatter
  if (/^#{1,6}\s+\S/m.test(head)) md += 2;                        // ATX 标题
  if (/^```/m.test(head)) md += 1;                                 // 围栏代码
  if (/^\s*[-*+]\s+\S/m.test(head)) md += 1;                       // 列表
  if (/\[[^\]]+\]\([^)]+\)/.test(head)) md += 1;                   // 链接
  s += Math.min(md * 0.08, 0.3);
  return Math.min(s, 0.99);
}

function parse(buf, ctx) {
  const dec = decodeText(buf);
  const r = toc.parseMd(dec.text);
  const base = String((ctx && (ctx.name || ctx.path)) || '').split(/[\\/]/).pop() || '未命名';
  return {
    format: 'md',
    render: 'richtext',
    label: 'Markdown',
    encoding: dec.enc,
    title: r.title || base.replace(/\.(md|markdown|mdown|mkd)$/i, '').trim() || '未命名',
    author: r.author || '',
    sections: r.sections,
    tocSource: r.tocSource,
    stats: r.stats,
    note: ''
  };
}

module.exports = { id: 'md', EXTS, probe, parse };
