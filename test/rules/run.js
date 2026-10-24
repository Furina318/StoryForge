#!/usr/bin/env node
/* 规则黄金样本跑测（test/rules/run.js）
 *
 *   node test/rules/run.js
 *   node test/rules/run.js --verbose     # 打印每条 issue 的 claim
 *
 * 判定口径：
 *   - expect 里列出的 (规则, 章号) 必须报出来 → 否则算 FN；
 *   - 报出来但不在 expect 里 → 算 FP（ignore 里的规则整条跳过）；
 *   - 一条规则只要有一处 FP，这一条就算"不可信"，所以门槛是 precision ≥ 0.95。
 * 退出码：0 = 达标；1 = 有规则不达标（CI 用）。
 */
'use strict';

const path = require('node:path');
const rules = require(path.join(__dirname, '..', '..', 'packages', 'rules', 'index.js'));
const { cases } = require(path.join(__dirname, 'cases.js'));

const VERBOSE = process.argv.includes('--verbose');
const THRESHOLD = { precision: 0.95, recall: 0.6 };

function key(issue) {
  return issue.ruleId + '@' + issue.chapter;
}

let totalTP = 0, totalFP = 0, totalFN = 0;
const perRule = {};

cases.forEach((c) => {
  const payload = c.setup ? c.setup(JSON.parse(JSON.stringify(c.payload))) : c.payload;
  const res = rules.run(payload, c.chapterId);
  const ignore = c.ignore || [];
  const gotAll = res.issues.filter((i) => ignore.indexOf(i.ruleId) < 0).map(key);
  /* 同一 (规则, 章) 可能有多条 issue（比如同章两处逝者行动），判定按去重后的集合算 */
  const got = Array.from(new Set(gotAll));
  const want = c.expect.slice();
  const gotSet = new Set(got);
  const wantSet = new Set(want);
  const fp = got.filter((k) => !wantSet.has(k));
  const fn = want.filter((k) => !gotSet.has(k));

  console.log('\n■ ' + c.name);
  console.log('  want: ' + (want.length ? want.join(', ') : '(无)'));
  console.log('  got : ' + (got.length ? got.join(', ') : '(无)') +
    (fp.length ? '   ✗ 多报: ' + fp.join(', ') : '') +
    (fn.length ? '   ✗ 漏报: ' + fn.join(', ') : ''));

  if (VERBOSE) {
    res.issues.forEach((i) => console.log('    - [' + i.severity + '] ' + i.ruleId + '@' + i.chapter + ' ' + i.claim));
    console.log('    ruleStatus: ' + res.ruleStatus.map((s) => s.id.replace('R-', '') + '=' +
      s.status + (s.reason ? '(' + s.reason + ')' : '')).join(' '));
  }

  const bump = (ruleId, field) => {
    perRule[ruleId] = perRule[ruleId] || { tp: 0, fp: 0, fn: 0 };
    perRule[ruleId][field] += 1;
  };
  got.forEach((k) => {
    const rid = k.split('@')[0];
    if (wantSet.has(k)) { bump(rid, 'tp'); totalTP += 1; } else { bump(rid, 'fp'); totalFP += 1; }
  });
  want.forEach((k) => {
    if (!gotSet.has(k)) { bump(k.split('@')[0], 'fn'); totalFN += 1; }
  });
});

console.log('\n规则            命中  多报  漏报  精确率  召回率');
console.log('---------------------------------------------------');
let failed = [];
Object.keys(perRule).sort().forEach((rid) => {
  const r = perRule[rid];
  const p = r.tp + r.fp ? r.tp / (r.tp + r.fp) : 1;
  const rc = r.tp + r.fn ? r.tp / (r.tp + r.fn) : 1;
  const okP = p >= THRESHOLD.precision;
  const okR = rc >= THRESHOLD.recall;
  if (!okP || !okR) failed.push(rid + (okP ? '' : ' 精确率 ' + p.toFixed(2)) + (okR ? '' : ' 召回率 ' + rc.toFixed(2)));
  console.log(
    rid.padEnd(14) + String(r.tp).padStart(5) + String(r.fp).padStart(6) + String(r.fn).padStart(6) +
    (p * 100).toFixed(1).padStart(7) + '%' + (rc * 100).toFixed(1).padStart(7) + '%'
  );
});
console.log('---------------------------------------------------');
console.log('合计：命中 ' + totalTP + ' · 多报 ' + totalFP + ' · 漏报 ' + totalFN);

if (failed.length) {
  console.log('\n✗ 不达标：' + failed.join('；'));
  process.exit(1);
}
console.log('\n✓ 全部规则达标（精确率 ≥ ' + THRESHOLD.precision + '，召回率 ≥ ' + THRESHOLD.recall + '）');
