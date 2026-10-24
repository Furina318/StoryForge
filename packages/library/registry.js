'use strict';
/**
 * 格式注册表：所有 adapter 打一遍分，分最高的上；都不及格就走兜底。
 *
 * 加新格式 = 加一个文件 + 在 ADAPTERS 里加一行。**不用改别的地方**。
 * 这就是"为书源预留"的那层接口：将来 web 书源 adapter 也只是往这里加一个 id。
 *
 * 探测链的约定（方案 §4.1）：魔数优先，扩展名只加分。
 * 所以一个改名成 .txt 的 PDF 依然会被 pdf adapter 认出来。
 */
const { binaryRatio } = require('./encoding');

const ADAPTERS = [
  require('./adapters/epub.js'),
  require('./adapters/pdf.js'),
  require('./adapters/md.js'),
  require('./adapters/txt.js'),
  require('./adapters/rawtext.js'),
  require('./adapters/external.js')
];

const PASS = 0.5;

function byId(id) {
  for (let i = 0; i < ADAPTERS.length; i++) if (ADAPTERS[i].id === id) return ADAPTERS[i];
  return null;
}

/** 返回 [{ id, score }]，按分数降序，方便 UI 显示"我把它当成什么了" */
function detect(buf, ctx) {
  return ADAPTERS.map((a) => {
    let s = 0;
    try { s = a.probe(buf, ctx) || 0; } catch (e) { s = 0; }
    return { id: a.id, score: s, adapter: a };
  }).sort((x, y) => y.score - x.score);
}

/**
 * 解析入口：永远返回一个可落库的结果，不抛"导入失败"。
 * adapter 自己炸了（比如坏 JSON）也要退化成兜底，让用户至少能看见书。
 */
function parse(buf, ctx) {
  const ranked = detect(buf, ctx);
  const best = ranked[0];
  let adapter = best && best.score >= PASS ? best.adapter : null;

  if (!adapter) {
    adapter = binaryRatio(buf) < 0.05 ? byId('text') : byId('external');
  }

  let out = null;
  try {
    out = adapter.parse(buf, ctx);
  } catch (e) {
    out = null;
    ctx = Object.assign({}, ctx, { adapterError: String((e && e.message) || e) });
  }
  if (!out) out = byId('external').parse(buf, ctx);

  out.adapter = adapter.id;
  out.adapterScore = best ? Math.round(best.score * 100) / 100 : 0;
  out.candidates = ranked.slice(0, 3).map((r) => ({ id: r.id, score: Math.round(r.score * 100) / 100 }));
  if (ctx && ctx.adapterError && !out.note) out.note = '解析时出了点问题（' + ctx.adapterError + '），已退回外部打开。';
  return out;
}

module.exports = { ADAPTERS, PASS, detect, parse, byId };
