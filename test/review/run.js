/* 审阅代理的回归测试（不联网）
 *
 * 只测两件事：
 *   1. 模型胡说八道时能不能挡住（引文对不上原文 → 整条丢掉）
 *   2. 没有 Key 时的示例审阅不会乱报（拿示例小说跑，条数 ≤ 3 且都能定位到段落）
 */
const assert = require('assert');
const RV = require('../../packages/review/index.js');

let pass = 0;
let fail = 0;
function ok(name, fn) {
  try {
    fn();
    pass += 1;
    console.log('  ✓ ' + name);
  } catch (e) {
    fail += 1;
    console.log('  ✗ ' + name + '\n    ' + e.message);
  }
}

const chapter = {
  id: 'c1', idx: 1, title: '第一章',
  card: { pov: '沈砚', goal: '补第一页', conflict: '老周拦他' },
  blocks: [
    { id: 'b1', text: '梅雨落在旧书店的玻璃上，像一层没擦干净的旧墨。' },
    { id: 'b2', text: '「别修了。」老周说，「这书我认得。」' },
    { id: 'b3', text: '他修过四千多本书，从未见过这样一页。' }
  ]
};

console.log('审阅代理');

ok('引文能对上的留下，对不上的丢掉', () => {
  const items = [
    { kind: 'logic', severity: 'major', claim: '这里说不通', quote: '他修过四千多本书', suggestion: '补一句', confidence: 0.8 },
    { kind: 'density', severity: 'minor', claim: '编的', quote: '这句话原文里没有', suggestion: '', confidence: 0.9 }
  ];
  const r = RV.validate(chapter, items);
  assert.strictEqual(r.kept.length, 1);
  assert.strictEqual(r.kept[0].blockId, 'b3');
  assert.strictEqual(r.dropped.length, 1);
});

ok('标点归一化后仍能匹配（模型爱把「」改成引号）', () => {
  const r = RV.validate(chapter, [{ kind: 'voice', severity: 'minor', claim: 'x', quote: '"别修了。"老周说', confidence: 0.6 }]);
  assert.strictEqual(r.kept.length, 1);
  assert.strictEqual(r.kept[0].blockId, 'b2');
});

ok('同一条问题重复报只留一条', () => {
  const q = '他修过四千多本书';
  const r = RV.validate(chapter, [
    { kind: 'logic', claim: '同一个问题', quote: q },
    { kind: 'logic', claim: '同一个问题', quote: q }
  ]);
  assert.strictEqual(r.kept.length, 1);
});

ok('最多 6 条', () => {
  const many = [];
  for (let i = 0; i < 10; i++) many.push({ kind: 'other', claim: 'x' + i, quote: '梅雨落在旧书店' });
  assert.strictEqual(RV.validate(chapter, many).kept.length, 6);
});

ok('parse 能吃围栏和前后废话，吃不下就返回空数组', () => {
  const t = '好的，结果如下：\n```json\n[{"kind":"logic","severity":"major","claim":"a","quote":"b"}]\n```\n希望有帮助';
  const arr = RV.parse(t);
  assert.strictEqual(arr.length, 1);
  assert.strictEqual(arr[0].kind, 'logic');
  assert.deepStrictEqual(RV.parse('我没看懂你的要求'), []);
});

ok('未知 kind / severity 有兜底', () => {
  const arr = RV.parse('[{"kind":"who","severity":"fatal","claim":"a","quote":"b"}]');
  assert.strictEqual(arr[0].kind, 'other');
  assert.strictEqual(arr[0].severity, 'minor');
});

ok('prompt 里带上了段落号，模型只能引用这些段落', () => {
  const u = RV.userPrompt({ chapter: chapter });
  assert.ok(u.indexOf('[b1]') >= 0 && u.indexOf('[b3]') >= 0);
  const s = RV.systemPrompt({ chapter: chapter });
  assert.ok(s.indexOf('JSON') >= 0 && s.indexOf('第 1 章') >= 0);
});

ok('示例审阅的每一条都能定位到段落', () => {
  const long = '很长的一段'.repeat(40);
  const ch = {
    id: 'c9', idx: 9, title: '第九章',
    blocks: [
      { id: 'x1', text: '至此，事情算完了。' },
      { id: 'x2', text: '「这是规矩。」老人说。' },
      { id: 'x3', text: '「你向来不听。」' },
      { id: 'x4', text: '「所谓补字，意思就是补命。」' },
      { id: 'x5', text: long }
    ]
  };
  const items = RV.validate(ch, RV.mockReview(ch));
  assert.ok(items.kept.length >= 1 && items.kept.length <= 3);
  assert.deepStrictEqual(items.dropped, []);
  items.kept.forEach((it) => assert.ok(ch.blocks.some((b) => b.id === it.blockId)));
});

console.log('\n审阅代理：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
