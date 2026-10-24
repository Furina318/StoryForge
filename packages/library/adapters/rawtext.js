'use strict';
/**
 * 兜底一：能当文本读的文件。
 *
 * epub / docx / zip 里其实是文本的、扩展名是 .dat/.nfo/.html/.csv 的，
 * 都先在这里尽力读一遍。读出来是乱码也有价值——至少能看见字，
 * 比"导入失败"友好得多（方案 §4：失败态应该不存在）。
 */
const { decodeText, binaryRatio } = require('../encoding');
const toc = require('../toc');

function probe(buf) {
  const ratio = binaryRatio(buf);
  if (ratio > 0.05) return 0;
  return 0.4;   // 低于 0.5 的及格线：只有"没有正经 adapter 认得"时才会被挑中
}

function parse(buf, ctx) {
  const dec = decodeText(buf);
  const { items } = toc.paragraphize(dec.text);
  const sections = toc.autoSections(items);
  const stat = toc.countChars(sections);
  const base = String((ctx && (ctx.name || ctx.path)) || '').split(/[\\/]/).pop() || '未命名';
  return {
    format: 'text',
    render: 'text',
    label: '纯文本（兜底）',
    encoding: dec.enc,
    title: base.replace(/\.[A-Za-z0-9]{1,5}$/, '') || '未命名',
    sections,
    tocSource: 'auto',
    stats: Object.assign({ sections: sections.length }, stat),
    note: '没认出具体格式，按纯文本尽力读了一遍：' +
      (dec.lossy ? '编码也不确定（试了 ' + dec.enc + '），有乱码可以「换编码重读」。' : '内容应该是完整的。')
  };
}

module.exports = { id: 'text', probe, parse };
