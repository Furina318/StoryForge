#!/usr/bin/env node
/* 人物弧线规则（R-ARC-01..04）单测 —— node test/arc/run.js
 *
 * 这里不追求"文采"，只钉死四件事：
 *   1) A→B→A 的状态倒退要报；章节卡上声明了"这一章他变了"就不报；
 *   2) 弧线写着"到第 8 章才该知道"的东西提前出现要报；
 *   3) 章节卡承诺了转变、正文里没人也没状态更新要报；有一个就不报；
 *   4) 两个转折点之间三章以上没有任何状态变化要报（minor）；
 *   5) 没写弧线的角色，四条规则全部 skip（不是 clear，也不是失败）。
 */
'use strict';

const path = require('node:path');
const rules = require(path.join(__dirname, '..', '..', 'packages', 'rules', 'index.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

function blk(id, text, actors, scene) {
  const b = { id, text };
  if (actors) b.actors = actors;
  if (scene) b.scene = scene;
  return b;
}

function chapter(idx, blocks, changes) {
  return {
    id: 'c' + idx, idx, title: '第 ' + idx + ' 章', status: 'draft',
    blocks,
    card: { goal: '', conflict: '', turn: '', pov: '沈砚', cast: [], targetWords: 1500, changes: changes || [] }
  };
}

function base(extra) {
  const d = {
    project: { style: {} },
    entities: [
      { id: 'e_shen', name: '沈砚', kind: '主角' },
      { id: 'e_zhou', name: '老周', kind: '配角' }
    ],
    chapters: [], confirmedStates: [], proposedStates: [],
    foreshadows: [], waivers: []
  };
  return Object.assign(d, extra || {});
}

function run(d, chapterId) {
  return rules.run(d, chapterId || 'c1');
}
function hits(res, rid) {
  return res.issues.filter((i) => i.ruleId === rid);
}
function statusOf(res, rid) {
  const s = res.ruleStatus.filter((x) => x.id === rid)[0];
  return s ? s.status : '(none)';
}

/* ───────── 1. ARC-01 状态倒退 ───────── */
console.log('\n■ R-ARC-01 状态倒退');

const arcShen = {
  on: true, kind: 'growth',
  from: '相信字能改命', to: '知道字改不了命，是人自己改',
  beats: [{ chapter: 1, text: '他信' }, { chapter: 3, text: '第一次动摇' }],
  forbidden: []
};

const d1 = base({
  entities: [{ id: 'e_shen', name: '沈砚', kind: '主角', arc: arcShen }],
  chapters: [
    chapter(1, [blk('b1-1', '沈砚觉得，字写对了，人就跟着对了。', ['沈砚'])]),
    chapter(2, [blk('b2-1', '他心里犯了疑：也许字改不了什么。', ['沈砚'])]),
    chapter(3, [blk('b3-1', '可他还是觉得，字写对了，人就跟着对了。', ['沈砚'])])
  ],
  confirmedStates: [
    { entity: '沈砚', field: '信念', value: '字能改命', chapter: 1, block: 'b1-1', quote: '字写对了，人就跟着对了' },
    { entity: '沈砚', field: '信念', value: '字改不了命', chapter: 2, block: 'b2-1', quote: '也许字改不了什么' },
    { entity: '沈砚', field: '信念', value: '字能改命', chapter: 3, block: 'b3-1', quote: '字写对了，人就跟着对了' }
  ]
});
let r1 = run(d1, 'c3');
ok('A→B→A 报一条 R-ARC-01', hits(r1, 'R-ARC-01').length === 1, '实际 ' + hits(r1, 'R-ARC-01').length);
ok('报在第 3 章', hits(r1, 'R-ARC-01')[0] && hits(r1, 'R-ARC-01')[0].chapter === 3);
ok('带证据块 b3-1', (hits(r1, 'R-ARC-01')[0] || {}).evidence && hits(r1, 'R-ARC-01')[0].evidence[0].blockId === 'b3-1');
ok('严重度 major', (hits(r1, 'R-ARC-01')[0] || {}).severity === 'major');

/* 章节卡声明了"这一章他变了" → 不报（这是有意的反复，不是漂移） */
const d1b = JSON.parse(JSON.stringify(d1));
d1b.chapters[2].card.changes = [{ entity: '沈砚', field: '信念', from: '字改不了命', to: '字能改命' }];
const r1b = run(d1b, 'c3');
ok('声明了转变就不报 ARC-01', hits(r1b, 'R-ARC-01').length === 0);
ok('但 ARC-03 认为有转变证据（有状态/有出场）→ 也不报', hits(r1b, 'R-ARC-03').length === 0);

/* 没有弧线的角色完全不参与 */
const d1c = JSON.parse(JSON.stringify(d1));
d1c.entities = [{ id: 'e_shen', name: '沈砚', kind: '主角' }];
const r1c = run(d1c, 'c3');
ok('没写弧线 → ARC-01 skip', statusOf(r1c, 'R-ARC-01') === 'skip', statusOf(r1c, 'R-ARC-01'));
ok('没写弧线 → 不报任何 ARC-01', hits(r1c, 'R-ARC-01').length === 0);

/* ───────── 2. ARC-02 越级 ───────── */
console.log('\n■ R-ARC-02 弧线越级');

const arcZhou = {
  on: true, kind: 'redemption',
  from: '只想活着', to: '把欠师父的还上',
  beats: [{ chapter: 1, text: '躲' }, { chapter: 8, text: '还' }],
  forbidden: ['账本第十页', '省悟堂的地窖'],
  reachChapter: 8
};

const d2 = base({
  entities: [
    { id: 'e_shen', name: '沈砚', kind: '主角', arc: arcShen },
    { id: 'e_zhou', name: '老周', kind: '配角', arc: arcZhou }
  ],
  chapters: [
    chapter(1, [blk('b1-1', '老周把账本第十页撕下来，塞进袖子里。', ['老周'])]),
    chapter(2, [blk('b2-1', '老周说他不想去省悟堂的地窖。', ['老周'])]),
    chapter(9, [blk('b9-1', '老周带他去了省悟堂的地窖。', ['老周'])])
  ],
  confirmedStates: []
});
const r2 = run(d2, 'c1');
const a2 = hits(r2, 'R-ARC-02');
ok('第 1 章提前用「账本第十页」→ 报', a2.some((i) => i.chapter === 1 && /账本第十页/.test(i.claim)));
ok('第 2 章提前提「省悟堂的地窖」→ 报', a2.some((i) => i.chapter === 2));
ok('第 9 章（≥ reach 8）不报', !a2.some((i) => i.chapter === 9));
ok('不同禁语各算一条', a2.length === 2, '实际 ' + a2.length);

/* 回忆/幻觉里的不算 */
const d2b = JSON.parse(JSON.stringify(d2));
d2b.chapters[0].blocks[0].scene = 'flashback';
const r2b = run(d2b, 'c1');
ok('闪回段落不判越级', !hits(r2b, 'R-ARC-02').some((i) => i.chapter === 1));

/* 不是这个角色的段落不算 */
const d2c = JSON.parse(JSON.stringify(d2));
d2c.chapters[0].blocks[0].actors = ['沈砚'];
const r2c = run(d2c, 'c1');
ok('别人说的不算他越级', !hits(r2c, 'R-ARC-02').some((i) => i.chapter === 1));

/* ───────── 3. ARC-03 转变无因 ───────── */
console.log('\n■ R-ARC-03 转变无因');

const d3 = base({
  entities: [{ id: 'e_shen', name: '沈砚', kind: '主角', arc: arcShen }],
  chapters: [
    chapter(1, [blk('b1-1', '沈砚在灯下补字。', ['沈砚'])]),
    chapter(2, [blk('b2-1', '街上下着雨，没有人来。', [])],
      [{ entity: '老周', field: '态度', from: '躲着', to: '肯说了' }])
  ],
  confirmedStates: []
});
const r3 = run(d3, 'c2');
const a3 = hits(r3, 'R-ARC-03');
ok('承诺了老周要变，本章他没出场也没状态 → 报', a3.length === 1, '实际 ' + a3.length);
ok('报在老周承诺的那一章（第 2 章）', a3[0] && a3[0].chapter === 2);
ok('claim 里写了 from → to', a3[0] && /躲着/.test(a3[0].claim) && /肯说了/.test(a3[0].claim));

/* 他出场了就不报（人在场至少还有机会变） */
const d3b = JSON.parse(JSON.stringify(d3));
d3b.chapters[1].blocks[0].actors = ['老周'];
ok('角色出场了就不报', hits(run(d3b, 'c2'), 'R-ARC-03').length === 0);

/* 有当章状态更新也不报 */
const d3c = JSON.parse(JSON.stringify(d3));
d3c.confirmedStates = [{ entity: '老周', field: '态度', value: '肯说了', chapter: 2, block: 'b2-1', quote: '下雨' }];
ok('有状态更新就不报', hits(run(d3c, 'c2'), 'R-ARC-03').length === 0);

/* 未来的章不判（还没写不算错） */
ok('第 3 章之后的承诺不报', hits(run(d3, 'c1'), 'R-ARC-03').length === 0);

/* ───────── 4. ARC-04 弧线停滞 ───────── */
console.log('\n■ R-ARC-04 弧线停滞');

const arcLong = {
  on: true, kind: 'growth',
  from: '沉默', to: '开口',
  beats: [{ chapter: 1, text: '第一次露面' }, { chapter: 6, text: '终于说出口' }],
  forbidden: []
};
const d4 = base({
  entities: [{ id: 'e_shen', name: '沈砚', kind: '主角', arc: arcLong }],
  chapters: [1, 2, 3, 4, 5, 6].map((i) => chapter(i, [blk('b' + i + '-1', '沈砚坐着，什么也没说。', ['沈砚'])])),
  confirmedStates: [
    { entity: '沈砚', field: '想法', value: '沉默', chapter: 1, block: 'b1-1', quote: '什么也没说' }
  ]
});
const r4 = run(d4, 'c3');
const a4 = hits(r4, 'R-ARC-04');
ok('第 1–6 章之间没有状态变化 → 报', a4.length === 1, '实际 ' + a4.length);
ok('严重度是 minor（提示级）', a4[0] && a4[0].severity === 'minor');
ok('提示在第 1 章', a4[0] && a4[0].chapter === 1);

/* 中间有变化就不报 */
const d4b = JSON.parse(JSON.stringify(d4));
d4b.confirmedStates.push({ entity: '沈砚', field: '想法', value: '想说', chapter: 3, block: 'b3-1', quote: '坐着' });
ok('中间有状态变化就不报', hits(run(d4b, 'c3'), 'R-ARC-04').length === 0);

/* 中间有没写的章 → 判不了，skip 而不是报 */
const d4c = JSON.parse(JSON.stringify(d4));
d4c.chapters[2].blocks = [];
ok('中间有空白章 → 不报（不能拿没写的章当证据）', hits(run(d4c, 'c3'), 'R-ARC-04').length === 0);

/* ───────── 5. 全部可选 ───────── */
console.log('\n■ 弧线是可选的');
const d5 = base({
  chapters: [chapter(1, [blk('b1-1', '沈砚坐着。', ['沈砚'])])]
});
const r5 = run(d5, 'c1');
['R-ARC-01', 'R-ARC-02', 'R-ARC-03', 'R-ARC-04'].forEach((rid) => {
  ok('没有弧线时 ' + rid + ' 是 skip', statusOf(r5, rid) === 'skip', statusOf(r5, rid));
});
ok('没有弧线时四条都不报', ['R-ARC-01', 'R-ARC-02', 'R-ARC-03', 'R-ARC-04']
  .every((rid) => hits(r5, rid).length === 0));


/* ───────── 6. 多条并行的线（没有类型，只有自由文本） ───────── */
const d6 = base({
  entities: [
    /* 同一个人两条线：一条讲他对师父的看法，一条讲他对这门手艺 */
    { id: 'e_shen', name: '沈砚', kind: '主角', arcs: [
      { label: '对师父的看法', from: '他是自己跳下去的', to: '屋里还有第三个人',
        beats: [{ chapter: 6, text: '河堤上问出口' }], forbidden: ['第三个人'], reachChapter: 6 },
      { label: '对手艺的看法', from: '补字是修东西', to: '补字是替人把话说完',
        beats: [{ chapter: 2, text: '第一次替人抄家书' }, { chapter: 9, text: '补回自己的名字' }] }
    ] }
  ],
  chapters: [
    chapter(1, [blk('b1-1', '沈砚把笔放下，说：我知道屋里还有第三个人。', ['沈砚'])]),
    chapter(2, [blk('b2-1', '沈砚替人抄了一封家书。', ['沈砚'])]),
    chapter(3, [blk('b3-1', '沈砚坐着发呆。', ['沈砚'])])
  ]
});
const r6 = run(d6, 'c1');
const a2s = hits(r6, 'R-ARC-02');
ok('两条线里只有带禁语的那条报越级', a2s.length === 1, '实际 ' + a2s.length);
ok('越级提示带上了线名', a2s.length === 1 && a2s[0].claim.indexOf('对师父的看法') >= 0, a2s[0] && a2s[0].claim);
ok('另一条线（没有禁语）不报越级', a2s.every((x) => x.claim.indexOf('对手艺的看法') < 0));
const a4s = hits(r6, 'R-ARC-04');
ok('停滞提示也用线名指认是哪条线', a4s.every((x) => x.claim.indexOf('对手艺的看法') >= 0), a4s.map((x) => x.claim).join(' | '));

/* 没有名字的线：用「第 N 条弧线」代替，不能报出一条看不懂的错 */
const d7 = base({
  entities: [{ id: 'e_zhou', name: '老周', kind: '配角', arcs: [
    { from: '躲着', to: '还上', forbidden: ['省悟堂'], reachChapter: 6 },
    { from: '欠着', to: '还清', beats: [{ chapter: 1, text: '被撞见' }, { chapter: 5, text: '说出口' }] }
  ] }],
  chapters: [
    chapter(1, [blk('b1-1', '老周站在省悟堂门口。', ['老周'])]),
    chapter(2, [blk('b2-1', '老周在铺子里。', ['老周'])]),
    chapter(3, [blk('b3-1', '老周还是没开口。', ['老周'])]),
    chapter(4, [blk('b4-1', '老周低着头。', ['老周'])]),
    chapter(5, [blk('b5-1', '老周说了。', ['老周'])])
  ]
});
const r7 = run(d7, 'c1');
const a7 = hits(r7, 'R-ARC-02');
ok('没有线名时也报得出来', a7.length === 1, '实际 ' + a7.length);
ok('没有线名时用「第 N 条弧线」指代', a7.length === 1 && a7[0].claim.indexOf('第 1 条弧线') >= 0, a7[0] && a7[0].claim);

/* 旧写法（entity.arc 单条）与新写法（entity.arcs）并存：不能报两遍 */
const d8 = base({
  entities: [{ id: 'e_zhou', name: '老周', kind: '配角',
    arc: { from: '躲着', to: '还上', forbidden: ['省悟堂'], reachChapter: 6 },
    arcs: [{ from: '躲着', to: '还上', forbidden: ['省悟堂'], reachChapter: 6 }] }],
  chapters: [chapter(1, [blk('b1-1', '老周站在省悟堂门口。', ['老周'])])]
});
const r8 = run(d8, 'c1');
ok('同一条线写两遍（旧字段 + 新字段）只报一次', hits(r8, 'R-ARC-02').length === 1, '实际 ' + hits(r8, 'R-ARC-02').length);

/* 类型字段不参与任何判定：写什么、有没有写，结论都不变 */
const d9a = base({
  entities: [{ id: 'e_zhou', name: '老周', kind: '配角',
    arcs: [{ kind: '成长', from: '躲着', to: '还上', forbidden: ['省悟堂'], reachChapter: 6 }] }],
  chapters: [chapter(1, [blk('b1-1', '老周站在省悟堂门口。', ['老周'])])]
});
const d9b = JSON.parse(JSON.stringify(d9a));
d9b.entities[0].arcs[0].kind = '随便什么';
const n1 = run(d9a, 'c1').issues.length, n2 = run(d9b, 'c1').issues.length;
ok('改掉/去掉「类型」不影响任何结论', n1 === n2, n1 + ' vs ' + n2);

console.log('\narc: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
