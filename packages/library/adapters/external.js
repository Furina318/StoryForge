'use strict';
/**
 * 兜底二：不认识的二进制。
 *
 * 不报错、不拦截：卡片照样进书架，打开时用系统默认程序（多半是浏览器或 PDF 阅读器）。
 * 这样"我拖进来一个 .epub"的结果是"书架上多了一本书，双击会用系统阅读器打开"，
 * 而不是一个红色提示把人挡在门外。
 */
function probe() {
  return 0.05;
}

function parse(buf, ctx) {
  const base = String((ctx && (ctx.name || ctx.path)) || '').split(/[\\/]/).pop() || '未命名';
  return {
    format: 'external',
    render: 'launch',
    label: '外部程序',
    encoding: '',
    title: base.replace(/\.[A-Za-z0-9]{1,5}$/, '') || '未命名',
    sections: [],
    tocSource: null,
    stats: { sections: 0, chars: 0, paragraphs: 0 },
    note: '这个格式 StoryForge 还不能在内部排版，打开时会交给系统默认程序。源文件不会被改动。'
  };
}

module.exports = { id: 'external', probe, parse };
