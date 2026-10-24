const assert = require('assert');
const V = require('../../packages/blocks/versioning.js');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + ' → ' + e.message); }
}

const base = '梅雨落在旧书店的玻璃上，像一层没擦干净的旧墨。沈砚把台灯往左挪了挪，光正好压在那页缺了角的纸上。';

t('tokenize 按句号断句', () => {
  const tk = V.tokenize(base);
  assert.strictEqual(tk.length, 2);
  assert.ok(tk[1].endsWith('。'));
});

t('只有 AI 改了第一句 → 取 AI 的，第二句保留我的改动', () => {
  const ours = base.replace('缺了角', '缺角');
  const theirs = base.replace('梅雨落在', '梅雨停在');
  const r = V.merge3Detailed(base, ours, theirs);
  assert.strictEqual(r.conflicts, 0);
  const text = V.merge3(base, ours, theirs).text;
  assert.ok(text.includes('梅雨停在'), text);
  assert.ok(text.includes('缺角'), text);
});

t('同一句两边改成不同内容 → 冲突，交由用户选', () => {
  const ours = base.replace('缺了角', '缺角');
  const theirs = base.replace('缺了角', '少了一角的');
  const r = V.merge3Detailed(base, ours, theirs);
  assert.strictEqual(r.conflicts, 1);
  const conf = r.segments.find(s => s.type === 'conflict');
  assert.ok(conf.ours.includes('缺角'));
  assert.ok(conf.theirs.includes('少了一角的'));
});

t('AI 在中间插一句 → 判定为插入，不算冲突', () => {
  const theirs = base.replace('沈砚把台灯', '雨声更密了。沈砚把台灯');
  const r = V.merge3Detailed(base, base, theirs);
  assert.strictEqual(r.conflicts, 0);
  assert.ok(V.merge3(base, base, theirs).text.includes('雨声更密了。'));
});

t('我删掉一句、AI 没动 → 结果里没有那句', () => {
  const ours = base.replace('沈砚把台灯往左挪了挪，光正好压在那页缺了角的纸上。', '');
  const r = V.merge3Detailed(base, ours, base);
  const text = V.merge3(base, ours, base).text;
  assert.ok(!text.includes('台灯'), text);
  assert.ok(text.includes('梅雨落在'));
});

t('我改了、AI 删了同一句 → 冲突（删除 vs 改写）', () => {
  const ours = base.replace('缺了角', '缺角');
  const theirs = base.replace('沈砚把台灯往左挪了挪，光正好压在那页缺了角的纸上。', '');
  const r = V.merge3Detailed(base, ours, theirs);
  assert.strictEqual(r.conflicts, 1);
});

t('三边完全相同 → 零冲突零改动', () => {
  const r = V.merge3Detailed(base, base, base);
  assert.strictEqual(r.conflicts, 0);
  assert.ok(r.segments.every(s => s.type === 'same'));
  assert.strictEqual(V.merge3(base, base, base).text, base);
});

console.log(`\nblocks/merge: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
