'use strict';
/**
 * PDF adapter（P0.5 只做"原版打开"）。
 *
 * 这里**不解析正文**：教材里的图、表、双栏、公式一旦被抽成纯文字就废了，
 * 所以我们只登记"这是一本 PDF，用内置查看器原版打开"。
 * 目录暂时用 Chromium 查看器自带的书签/缩略图面板；把 outline 抽到自己左栏
 * 是 B 阶段（pdf.js + canvas）才做的事，那时才需要 pdfjs-dist 依赖。
 */
const EXTS = ['pdf'];

function hasMagic(buf) {
  if (!buf || buf.length < 5) return false;
  const head = buf.subarray(0, 1024).toString('latin1');
  return head.indexOf('%PDF-') >= 0;
}

function probe(buf, ctx) {
  const ext = String((ctx && ctx.ext) || '').toLowerCase();
  if (hasMagic(buf)) return 0.99;
  if (EXTS.indexOf(ext) >= 0) return 0.6;   // 文件头被前面塞了垃圾字节的 pdf
  return 0;
}

function parse(buf, ctx) {
  const base = String((ctx && (ctx.name || ctx.path)) || '').split(/[\\/]/).pop() || '未命名';
  return {
    format: 'pdf',
    render: 'paged',
    label: 'PDF',
    encoding: '',
    title: base.replace(/\.pdf$/i, '') || '未命名',
    sections: [],
    tocSource: null,
    stats: { sections: 0, chars: 0, paragraphs: 0 },
    note: 'PDF 默认在应用内翻（pdf.js 渲染，页码/缩放/夜间都有；扫描件也能看）。' +
      '顶栏「原版窗口」可切到 Chromium 自带查看器，缩放/搜索/书签更全。正文不做文字回流。'
  };
}

module.exports = { id: 'pdf', EXTS, probe, parse, hasMagic };
