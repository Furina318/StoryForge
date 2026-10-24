/* 规则黄金样本（test/rules/cases.js）
 *
 * 每个 case 是一份精简 payload（形状与 apps/ui/store.js 返回的一致）：
 *   { name, payload, chapterId, expect: ['R-DEAD-01@3', ...], ignore: ['R-STYLE-02'] }
 *
 * expect 里写的是"必须报出来的 (规则, 章号)"；没写的组合一律视为"不该报"。
 * ignore 里的规则不参与判定（统计类规则受基线样本影响太大，用别的手段验）。
 *
 * 造样本的原则（跟 docs/v0.1.0-规则设计文档.md 一致）：
 *   - 每个正例旁边放一个"看起来像但合法"的反例（回忆、合法转场、已回收的伏笔）；
 *   - 文本用中文真实标点，不然分句逻辑测不到；
 *   - 抽取字段（actors/place/moveTo/scene）是手写的，等价于"抽取结果正确"这一前提。
 */

function b(id, text, extra) {
  return Object.assign({ id: id, text: text, src: 'human' }, extra || {});
}

function chapter(idx, id, blocks, extra) {
  return Object.assign({
    id: id, idx: idx, title: '第 ' + idx + ' 章', status: 'draft',
    card: { goal: '', conflict: '', turn: '', pov: '', cast: [], targetWords: 1500 },
    blocks: blocks, rev: 1, summary: ''
  }, extra || {});
}

/* 十章的骨架：前五章有正文，后五章留空（测"未抽取章节"的不可判定提示） */
function goldenChapters() {
  return [
    chapter(1, 'c1', [
      b('c1b1', '沈砚把最后一张纸翻过来，字迹工整得像刻出来的，偏偏每个字都缺最后一笔。', { actors: ['沈砚'], place: '沈砚的阁楼' }),
      b('c1b2', '他伸手在灯下照了照，纸背透出一点淡墨，仿佛有人刻意描过一遍。', { actors: ['沈砚'], place: '沈砚的阁楼' }),
      b('c1b3', '楼下有人叫他下楼吃饭，他应了一声，把纸压在镇纸下面。', { actors: ['沈砚', '老周'], place: '沈砚的阁楼' })
    ]),
    chapter(2, 'c2', [
      b('c2b1', '老周在柜台后面翻账本，翻到一半忽然停了手。', { actors: ['老周'], place: '旧货铺' }),
      b('c2b2', '他说这账本不干净，让你别再碰。说完就把账本合上了。', { actors: ['老周'], place: '旧货铺' }),
      b('c2b3', '第二天清晨，旧货铺的卷帘门上贴了一张纸，写着暂停营业。', { actors: [], place: '旧货铺' })
    ]),
    chapter(3, 'c3', [
      b('c3b1', '三天后，沈砚在阁楼里听见有人叫他的名字。', { actors: ['沈砚', '老周'], place: '沈砚的阁楼' }),
      b('c3b2', '那声音带着一点搪瓷杯碰柜台的轻响，是老周的腔调。', { actors: ['老周'], place: '沈砚的阁楼' }),
      b('c3b3', '城南旧货市场那天人很多，沈砚蹲在一个摊子前，翻出一叠发脆的账本。', { actors: ['沈砚'], place: '城南旧货市场' }),
      b('c3b4', '摊主说这些东西是从城西一户人家里收来的，主人上个月没了。', { actors: ['摊主'], place: '城南旧货市场' })
    ]),
    chapter(4, 'c4', [
      b('c4b1', '他锁上阁楼的门，沿着巷子走到城南旧货市场，路上买了一个冷掉的烧饼。', { actors: ['沈砚'], place: '巷子', moveTo: '城南旧货市场' }),
      b('c4b2', '市场里的摊子已经收了一半，只有卖旧书的还亮着一盏灯。', { actors: ['沈砚'], place: '城南旧货市场' }),
      b('c4b3', '他蹲下去，把那叠账本一页页翻过去，指腹上留下薄薄一层灰。', { actors: ['沈砚'], place: '城南旧货市场' })
    ]),
    chapter(5, 'c5', [
      b('c5b1', '他想起很多年前的那个下午，老周在柜台后面教他认字。', { actors: ['老周', '沈砚'], place: '旧货铺', scene: 'flashback' }),
      b('c5b2', '那时候老周的手还没抖，写字一笔到底，写完还要拿起来对着光看。', { actors: ['老周'], place: '旧货铺', scene: 'flashback' }),
      b('c5b3', '沈砚把账本合上，忽然想起来，老周从来不叫他「小沈」。', { actors: ['沈砚'], place: '旧货铺' })
    ]),
    chapter(6, 'c6', [], { status: 'planned' }),
    chapter(7, 'c7', [], { status: 'planned' }),
    chapter(8, 'c8', [], { status: 'planned' }),
    chapter(9, 'c9', [], { status: 'planned' }),
    chapter(10, 'c10', [], { status: 'planned' })
  ];
}

function goldenPayload() {
  return {
    project: {
      id: 'p_golden', name: '黄金样本', genre: '悬疑',
      style: { pack: 'noir', pov: '第一人称', banned: [] }
    },
    chapters: goldenChapters(),
    entities: [
      { id: 'e_shen', kind: '主角', name: '沈砚' },
      { id: 'e_zhou', kind: '配角', name: '老周' },
      { id: 'e_tan', kind: '配角', name: '摊主' }
    ],
    worldRules: [],
    confirmedStates: [
      { id: 'cs1', entity: 'e_zhou', field: 'alive', value: 'dead', chapter: 2, block: 'c2b3', quote: '旧货铺的卷帘门上贴了一张纸，写着暂停营业' }
    ],
    proposedStates: [],
    foreshadows: [
      { id: 'f1', title: '缺笔的字', plantedChapter: 1, plantedBlock: 'c1b1', due: 1, status: 'planted', related: [] },
      { id: 'f2', title: '暂停营业的纸', plantedChapter: 2, plantedBlock: 'c2b3', due: 3, status: 'resolved', resolvedChapter: 2, related: [] }
    ],
    waivers: []
  };
}

var cases = [
  {
    name: 'golden10：埋伏笔超期 / 逝者行动 / 地点跳变 / AI 味',
    payload: goldenPayload(),
    chapterId: 'c4',
    expect: [
      'R-STYLE-01@1',   /* c1b2 的「仿佛」 */
      'R-DEAD-01@3',    /* 老周 ch2 死了，ch3 还在说话 */
      'R-LOC-01@3',     /* 阁楼 → 市场，没有 moveTo */
      'R-FS-01@4'       /* 缺笔的字 due 1，ch4 已超期 3 章 */
    ],
    ignore: ['R-STYLE-02']
  },
  {
    name: '反例：死者只出现在回忆里，不该报',
    payload: (function () {
      var p = goldenPayload();
      /* 把 ch3 的两段都标成回忆，并把 ch3 的地点统一，去掉地点跳变 */
      p.chapters[2].blocks = p.chapters[2].blocks.map(function (x, i) {
        return Object.assign({}, x, { scene: 'flashback', place: '旧货铺', actors: ['沈砚'] });
      });
      return p;
    })(),
    chapterId: 'c4',
    expect: ['R-STYLE-01@1', 'R-FS-01@4'],
    ignore: ['R-STYLE-02']
  },
  {
    name: '反例：有合法的转场（moveTo 与后文一致），不该报地点跳变',
    payload: (function () {
      var p = goldenPayload();
      p.chapters[2].blocks[2] = Object.assign({}, p.chapters[2].blocks[2], { moveTo: '城南旧货市场' });
      return p;
    })(),
    chapterId: 'c4',
    expect: ['R-STYLE-01@1', 'R-DEAD-01@3', 'R-FS-01@4'],
    ignore: ['R-STYLE-02']
  },
  {
    name: '反例：平行叙事的场景标记可豁免地点跳变',
    payload: (function () {
      var p = goldenPayload();
      p.chapters[2].blocks[3] = Object.assign({}, p.chapters[2].blocks[3], { scene: 'parallel' });
      return p;
    })(),
    chapterId: 'c4',
    expect: ['R-STYLE-01@1', 'R-DEAD-01@3', 'R-FS-01@4'],
    ignore: ['R-STYLE-02']
  },
  {
    name: 'waiver 绑内容哈希：文本没改 → 抑制；改过 → 重新出现',
    payload: goldenPayload(),
    chapterId: 'c4',
    expect: ['R-DEAD-01@3', 'R-LOC-01@3', 'R-FS-01@4'],  /* STYLE-01 被抑制 */
    ignore: ['R-STYLE-02'],
    setup: function (p) {
      var R = require('../../packages/rules/index.js');
      p.waivers = [{
        ruleId: 'R-STYLE-01', key: 'b:c1b2:tone', blockId: 'c1b2',
        textHash: R.hashText(p.chapters[0].blocks[1].text), expired: false
      }];
      return p;
    }
  },
  {
    name: 'waiver 失效：段落改过之后，同一条应该重新报出来',
    payload: goldenPayload(),
    chapterId: 'c4',
    expect: ['R-STYLE-01@1', 'R-DEAD-01@3', 'R-LOC-01@3', 'R-FS-01@4'],
    ignore: ['R-STYLE-02'],
    setup: function (p) {
      var R = require('../../packages/rules/index.js');
      var old = R.hashText('他伸手在灯下照了照，纸背透出一点淡墨，仿佛有人刻意描过一遍。');
      /* 用户改了一个字：waiver 记的哈希对不上，应该失效 */
      p.chapters[0].blocks[1].text = '他伸手在灯下照了照，纸背透出一点淡墨，仿佛有人刻意描过一遍字。';
      p.waivers = [{ ruleId: 'R-STYLE-01', key: 'b:c1b2:tone', blockId: 'c1b2', textHash: old, expired: false }];
      return p;
    }
  },
  {
    name: 'R-KNOW-01：没人报名字，却写"把她的名字记在了心里"',
    payload: (function () {
      var p = goldenPayload();
      p.chapters[0].blocks.push(
        b('c1kb1', '沈砚却把这女孩的名字，记在了心里。', { actors: ['沈砚'], place: '沈砚的阁楼' })
      );
      return p;
    })(),
    chapterId: 'c4',
    expect: ['R-STYLE-01@1', 'R-DEAD-01@3', 'R-LOC-01@3', 'R-FS-01@4', 'R-KNOW-01@1'],
    ignore: ['R-STYLE-02']
  },
  {
    name: 'R-KNOW-01 反例：先自报名字，再写记住了，不该报',
    payload: (function () {
      var p = goldenPayload();
      p.chapters[0].blocks.push(
        b('c1kb2', '「我叫阿桑。」女孩说。', { actors: ['阿桑'], place: '沈砚的阁楼' }),
        b('c1kb3', '沈砚把这女孩的名字，记在了心里。', { actors: ['沈砚'], place: '沈砚的阁楼' })
      );
      return p;
    })(),
    chapterId: 'c4',
    expect: ['R-STYLE-01@1', 'R-DEAD-01@3', 'R-LOC-01@3', 'R-FS-01@4'],
    ignore: ['R-STYLE-02']
  }
];

if (typeof module === 'object' && module.exports) module.exports = { cases: cases, goldenPayload: goldenPayload };
