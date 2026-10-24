/* StoryForge v0.1.0 — 种子数据与项目模板
 *
 * 这里只放"内容"，不放交互。两个用途：
 *   1. 首次启动时播种演示项目《补字人》（数据里有几处故意的错，用来演示体检）；
 *   2. 「新建项目」向导向导出一份空项目：章节卡按模板生成，资料卡留空由用户逐步补。
 *
 * blocks 上的 actors / place / moveTo / scene 是"模拟的抽取结果"：
 * 规则引擎只读这些字段，不读自然语言。真实实现里它们来自 extract 模块。
 */

window.SF_DATA = (function () {
  let seq = 0;
  function uid(prefix) {
    seq += 1;
    return (prefix || 'id') + '_' + Date.now().toString(36).slice(-4) + seq.toString(36);
  }

  const project = {
    id: 'p_demo',
    name: '补字人',
    genre: '悬疑',
    logline: '一个替旧书补字的人，发现手里那页手稿能预告别人的死。',
    sellPoint: '补的是字，也是命。',
    desire: '沈砚想弄清师父当年为什么停笔',
    conflict: '手稿每补一个字，就有人死',
    conflicts: ['super', 'self', 'info'],
    conflictLead: '补完最后一个字，可能就轮到自己',
    targetWords: 70000,
    chapterCount: 10,
    wordsPerChapter: 7000,
    isDemo: true,
    style: {
      pack: 'noir',
      pov: '第三人称限知',
      tense: '过去时',
      distance: '近',
      sentence: '中',
      dialogue: '中',
      metaphor: '克制',
      tone: '冷静、克制、雨气',
      banned: ['很显然', '众所周知', '仿佛', '不禁'],
      sample: '',
      fp: null
    }
  };

  /* 示例项目的章节卡。正文不写在这里：正文在 content/补字人/chNN.md，
     跑 node scripts/build-content.js 生成 apps/ui/content.js，再由 applyContent() 挂上来。 */
  const DEMO_CARDS = [
    { idx: 1, title: '第一章 缺笔的字', status: 'done', cast: ['沈砚', '老周'],
      goal: '沈砚接手一页缺笔手稿，发现补上的字会改掉内容',
      conflict: '老周劝他别修，理由说不清',
      turn: '手稿背面出现昨晚没有的一行字',
      plant: '缺笔的字、师父之死', payoff: '' },
    { idx: 2, title: '第二章 第二个字', status: 'done', cast: ['沈砚', '老周'],
      goal: '补完第一个字，第二天老周在河湾被认出来',
      conflict: '簿子上多出一行：周守义，已故',
      turn: '他去河边认尸、签字，决定把簿子收起来',
      plant: '手稿会自己长字', payoff: '老周之死',
      changes: [{ entity: '阿桑', field: '身份', from: '街上的小孩', to: '跟着沈砚学补字' }] },
    { idx: 3, title: '第三章 城南旧事', status: 'draft', cast: ['沈砚', '老周', '阿桑'],
      goal: '去城南客栈打听死去的陆先生，摸到第二本簿子',
      conflict: '老周出现在客栈，说自己没死',
      turn: '他说：账本在省悟堂，你要补的不是字，是自己的名字',
      plant: '账本的主人', payoff: '老周的称呼' },
    { idx: 4, title: '第四章 账本第一页', status: 'draft', cast: ['沈砚', '阿桑'],
      goal: '翻账本第一页，看见十年里每一个死者的名字',
      conflict: '其中一个名字是沈砚自己',
      turn: '他决定把第三个字补完，看看到底是谁在记账',
      plant: '', payoff: '账本的主人' },
    { idx: 5, title: '第五章 城西', status: 'draft', cast: ['沈砚', '老周', '阿桑'],
      goal: '进城西的省悟堂，找邵先生要总账',
      conflict: '老周带路，说当年替邵先生做过事',
      turn: '他们在匾后拿到底册，惊动了堂里的人',
      plant: '', payoff: '师父之死' },
    { idx: 6, title: '第六章 停笔', status: 'draft', cast: ['沈砚', '老周'],
      goal: '在河堤上问出师父死的真相',
      conflict: '老周承认那天夜里他在楼下',
      turn: '师父不是自己跳的：屋里还有第三个人',
      plant: '', payoff: '',
      changes: [{ entity: '沈砚', field: '信念', from: '师父是自己跳下去的', to: '屋里还有第三个人' }] },
    { idx: 7, title: '第七章 摊主', status: 'draft', cast: ['沈砚', '老周', '阿桑'],
      goal: '灰长衫来报信：邵先生在收账，副本有九本',
      conflict: '邵先生要他补一个字：他娘的姓',
      turn: '补上，他就姓邵；补不上，他什么也不是',
      plant: '', payoff: '' },
    { idx: 8, title: '第八章 第三个字', status: 'draft', cast: ['沈砚', '阿桑'],
      goal: '回祠堂，把缺的那一竖补进「沅氏」',
      conflict: '字补上了，沈砚自己的名字没了',
      turn: '他站在那儿，想不起自己叫什么',
      plant: '', payoff: '' },
    { idx: 9, title: '第九章 补字人', status: 'draft', cast: ['沈砚', '阿桑', '老周'],
      goal: '按师父留的话去坟前取铁盒',
      conflict: '一张白纸、一支旧笔：最后一笔是「人」',
      turn: '他补回自己的名字，也补上了邵云生缺的那一横',
      plant: '', payoff: '' },
    { idx: 10, title: '第十章 雨停', status: 'draft', cast: ['沈砚', '阿桑', '老周'],
      goal: '把转寄册烧了，给街坊补完最后几十个名字',
      conflict: '雨停，收阿桑做徒弟',
      turn: '他把招牌上缺的一撇补上：旧书店三个字，齐了',
      plant: '', payoff: '' }
  ];

  const chapters = DEMO_CARDS.map(function (c) {
    return {
      id: 'c' + c.idx,
      idx: c.idx,
      title: c.title,
      status: c.status,
      card: {
        goal: c.goal,
        conflict: c.conflict,
        turn: c.turn,
        pov: '沈砚',
        cast: c.cast.slice(),
        plant: c.plant,
        payoff: c.payoff,
        changes: (c.changes || []).map(function (x) { return Object.assign({}, x); }),
        targetWords: 7000
      },
      blocks: []
    };
  });

  const entities = [
    { id: 'e_shen', name: '沈砚', kind: '主角', desire: '弄清师父为什么停笔，把账补完',
      wound: '师父死时他不在场', voice: '话少，句子短，不用形容词', note: '旧书店修书匠，补了四千多本书',
      /* 同一个人三条线：对手艺、对师父的死、对"谁来定生死" */
      arcs: [
        { label: '对手艺',
          from: '补字就是修东西，把缺的笔画补上',
          to: '补字是替人把没说完的话说完',
          beats: [
            { chapter: 1, text: '补上第一个字，手是稳的' },
            { chapter: 9, text: '在坟前把最后一笔补回自己名字上' }
          ] },
        { label: '对师父的死',
          from: '师父是自己想不开，跳下去的',
          to: '屋里还有第三个人，师父是被推的',
          beats: [
            { chapter: 6, text: '河堤上知道师父不是自己跳下去的' },
            { chapter: 9, text: '在祠堂把这件事说出口' }
          ] },
        { label: '对"谁有资格定生死"',
          from: '账本记的是命，只好照记',
          to: '账本记的是人；记错了就得改回来',
          beats: [
            { chapter: 4, text: '看见账本第一页上写着自己的名字' },
            { chapter: 8, text: '把「沅氏」缺的那一竖补上' }
          ],
          forbidden: ['字改不了命'],
          reachChapter: 9 }
      ] },
    { id: 'e_zhou', name: '老周', kind: '配角', desire: '活着，最好别欠谁',
      wound: '欠师父一条命', voice: '爱用反问，句子长，带口音', note: '旧货铺老板，名字叫周守义',
      /* 配角也一样：欠的债、对沈砚的态度，两条线同时走 */
      arcs: [
        { label: '欠师父的那条命',
          from: '躲着那件事，只想活着',
          to: '把欠师父的还上，哪怕还完就完了',
          beats: [
            { chapter: 3, text: '在客栈门口被撞见，赖不掉' },
            { chapter: 6, text: '在河堤上把那天夜里的事说了' }
          ],
          forbidden: ['省悟堂'],
          reachChapter: 6 },
        { label: '对沈砚',
          from: '当他是个不懂事的后生，能瞒就瞒',
          to: '把他当同一条船上的人',
          beats: [
            { chapter: 2, text: '劝他别修那本簿子' },
            { chapter: 7, text: '在省悟堂门口把他拉走' }
          ] }
      ] },
    { id: 'e_sang', name: '阿桑', kind: '配角', desire: '有个人肯教她',
      wound: '娘死的时候没人给她补字', voice: '短句，直接，偶尔冒一句让人愣住的话', note: '十一二岁，认得纸，后来做了徒弟' },
    { id: 'e_shao', name: '邵云生', kind: '反派', desire: '把账本收全，让这一行继续',
      wound: '六岁在河上被捞起来，姓是借的', voice: '慢，客气，不解释', note: '省悟堂的先生，字缺一横' },
    { id: 'e_master', name: '沈怀山', kind: '配角', desire: '（已故）', wound: '把自己写进了账',
      voice: '只在别人的回忆里出现', note: '沈砚的师父，补了四十一年字' },
    { id: 'e_book', name: '缺笔手稿', kind: '物品', desire: '', wound: '',
      voice: '每补一个字，内容会跟着变', note: '字字缺最后一笔' },
    { id: 'e_shop', name: '沈砚的阁楼', kind: '地点', desire: '', wound: '',
      voice: '旧书店二层，窗朝南', note: '工作台、砚台、一柜旧书' },
    { id: 'e_inn', name: '城南聚贤客栈', kind: '地点', desire: '', wound: '',
      voice: '两层木楼，门前的石阶被踩出凹坑', note: '三十七号房死过一个陆先生' },
    { id: 'e_market', name: '城南旧货市场', kind: '地点', desire: '', wound: '',
      voice: '天黑后还亮着灯的书铺堆到房梁', note: '老麦的铺子在这儿' }
  ];

  const worldRules = [
    { id: 'w1', kind: '规则', name: '补字', text: '手稿缺的字可以补，补完内容会按补的字变化，不可撤回。' },
    { id: 'w2', kind: '规则', name: '预告', text: '手稿上出现的名字，对方在七日内死亡。' },
    { id: 'w3', kind: '地点', name: '阁楼', text: '沈砚住处兼工作室，只在雨夜听见异响。' },
    { id: 'w4', kind: '势力', name: '收书人', text: '城西有一批专门收旧账本的人，身份不明。' }
  ];

  /* 已确认状态（confirmed）——只有这些进上下文、参与规则判定 */
  const confirmedStates = [
    { entity: '老周', field: '生死', value: '已故', chapter: 2, block: 'b2-12',
      quote: '雨停之后，有人在城南的河湾里找到了老周。' },
    { entity: '沈砚', field: '位置', value: '城南聚贤客栈', chapter: 3, block: 'b3-1',
      quote: '城南的客栈叫「聚贤」' },
    { entity: '缺笔手稿', field: '内容', value: '簿子上多了一行：周守义，已故', chapter: 2, block: 'b2-11',
      quote: '写着「周守义」，后面跟着两个字：「已故」' }
  ];

  /* 待确认（proposed）——闸门卡片 */
  const proposedStates = [
    { id: 'ps1', entity: '老周', field: '生死', from: '在世', to: '已故', chapter: 2, block: 'b2-12',
      quote: '有人在城南的河湾里找到了老周', conf: 0.92, checked: true },
    { id: 'ps2', entity: '沈砚', field: '位置', from: '沈砚的阁楼', to: '城南聚贤客栈', chapter: 3, block: 'b3-1',
      quote: '城南的客栈叫「聚贤」', conf: 0.88, checked: true },
    { id: 'ps3', entity: '缺笔手稿', field: '内容', from: '缺最后一笔', to: '多出一行「周守义，已故」', chapter: 2, block: 'b2-11',
      quote: '周守义', conf: 0.81, checked: true },
    { id: 'ps4', entity: '沈砚', field: '已知信息', from: '—', to: '账本上也有他自己的名字', chapter: 4, block: 'b4-18',
      quote: '周守义。后面写的是「已结账」', conf: 0.55, checked: false },
    { id: 'ps5', entity: '老周', field: '存在', from: '已故', to: '仍然活着', chapter: 3, block: 'b3-27',
      quote: '老周站在客栈的门口', conf: 0.77, checked: false }
  ];

  const foreshadows = [
    { id: 'f1', title: '缺笔的字', due: 1, plantedChapter: 1, plantedBlock: 'b1-3',
      status: 'planted', related: ['沈砚'], note: '每个字都缺最后一笔，到第十章才补完（故意超期）' },
    { id: 'f2', title: '师父之死', due: 5, plantedChapter: 1, plantedBlock: 'b1-40',
      status: 'planted', related: ['沈怀山', '老周'], note: '师父走的那年也补过一本书' },
    { id: 'f3', title: '账本的主人', due: 4, plantedChapter: 3, plantedBlock: 'b3-40',
      status: 'planted', related: ['邵云生'], note: '底册在，就有记账的人' },
    { id: 'f4', title: '老周的称呼', due: 3, plantedChapter: 3, plantedBlock: 'b3-27',
      status: 'touched', related: ['老周'], note: '死了的人站在客栈门口' },
    { id: 'f5', title: '邵先生缺的那一横', due: 12, plantedChapter: 7, plantedBlock: 'b7-1',
      status: 'planted', related: ['邵云生'], note: '这一笔要补在他娘的姓里' }
  ];

  /* ---------------- 阻力清单（新建项目多选） ---------------- */

  /* 分类参考叙事学通行的四类（人与自然 / 人与人 / 人与自我 / 人与社会）及其常见扩展
   * （命运与超自然、技术与规则、时间）。这里按"写作者实际怎么想"重排成四组，
   * 并在 UI 里明确：这是起点清单，不是限制，用户可以只选一个，也可以一个不选。 */
  const CONFLICT_KINDS = [
    { key: 'rival', group: '人', label: '对手', desc: '有人明确要拦住主角', eg: '同行抢生意 / 追捕者 / 竞争者' },
    { key: 'close', group: '人', label: '亲近的人', desc: '爱与立场冲突', eg: '家人反对 / 爱人隐瞒 / 朋友背叛' },

    { key: 'system', group: '结构', label: '制度与群体', desc: '不是某个人，是一套规则', eg: '官府 / 门派规矩 / 行规 / 舆论' },
    { key: 'cost', group: '结构', label: '代价与限制', desc: '做得到，但要付钱', eg: '能力有反噬 / 每次使用都失去什么' },

    { key: 'self', group: '内部', label: '自我', desc: '主角跟自己的恐惧、愧疚、欲望过不去', eg: '不敢面对 / 觉得自己不配' },
    { key: 'moral', group: '内部', label: '道德困境', desc: '两个都对的选项只能选一个', eg: '救人还是救证据 / 说实话会害人' },

    { key: 'survive', group: '外部', label: '生存与环境', desc: '天气、地理、身体、资源', eg: '暴雨封路 / 缺钱 / 伤病' },
    { key: 'time', group: '外部', label: '时间', desc: '有个期限在逼近', eg: '三天之内 / 赶不上就永远错过' },
    { key: 'info', group: '外部', label: '信息差', desc: '有人知道，有人不知道', eg: '被隐瞒的身世 / 误认身份 / 谎言' },
    { key: 'super', group: '外部', label: '超自然与规则', desc: '世界本身有一套不讲理的规则', eg: '诅咒 / 契约 / 预言 / 手稿的规矩' },
    { key: 'tech', group: '外部', label: '技术与工具', desc: '东西会坏、会用错、会反咬', eg: '机器失灵 / 数据被改 / 依赖成瘾' }
  ];

  const CONFLICT_GROUPS = ['人', '结构', '内部', '外部'];

  /* ---------------- 文风包：预设 + 可改 + 可投喂 ---------------- */

  const STYLE_PACKS = [
    {
      key: 'cold', label: '冷硬白描', desc: '句子短，少形容词，动作说话',
      pov: '第三人称限知', tense: '过去时', distance: '远', sentence: '短促', dialogue: '多', metaphor: '克制',
      tone: '冷、干、不解释', banned: ['仿佛', '不禁', '一丝']
    },
    {
      key: 'classic', label: '古典雅致', desc: '书面语，节奏舒缓，用意象',
      pov: '第三人称全知', tense: '过去时', distance: '中', sentence: '长句', dialogue: '少', metaphor: '中',
      tone: '雅、静、有余味', banned: ['超级', '搞定', 'OK']
    },
    {
      key: 'webnovel', label: '网文爽感', desc: '段落短，对话多，每章留钩子',
      pov: '第三人称限知', tense: '过去时', distance: '近', sentence: '短促', dialogue: '多', metaphor: '克制',
      tone: '爽、快、带火气', banned: ['不知过了多久', '总而言之']
    },
    {
      key: 'noir', label: '悬疑冷调', desc: '信息克制，环境压人，句尾留白',
      pov: '第一人称', tense: '过去时', distance: '极近', sentence: '中', dialogue: '中', metaphor: '克制',
      tone: '压抑、可疑、雨气', banned: ['很明显', '显然']
    },
    {
      key: 'street', label: '市井烟火', desc: '口语、方言味、物件细节多',
      pov: '第三人称限知', tense: '过去时', distance: '近', sentence: '中', dialogue: '多', metaphor: '中',
      tone: '热、吵、有人情', banned: ['心中暗道']
    },
    {
      key: 'lyric', label: '散文诗化', desc: '长句、通感、情绪先行',
      pov: '第一人称', tense: '现在时', distance: '极近', sentence: '长句', dialogue: '少', metaphor: '浓',
      tone: '软、亮、略带伤感', banned: ['突然', '猛地']
    }
  ];

  /* 本地文风指纹：不联网也能给出可核对的结构指标，供"投喂样本"时对照预设 */
  function styleFingerprint(text) {
    const raw = (text || '').replace(/\r/g, '').trim();
    if (!raw) return null;
    const paras = raw.split(/\n+/).map((s) => s.trim()).filter(Boolean);
    const sentences = raw.split(/[。！？…]+/).map((s) => s.trim()).filter((s) => s.length > 0);
    const lens = sentences.map((s) => s.length);
    const avg = lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 0;
    const sd = lens.length > 1 ? Math.sqrt(lens.reduce((a, b) => a + (b - avg) * (b - avg), 0) / lens.length) : 0;
    const dialogParas = paras.filter((p) => /[「“"]/.test(p)).length;
    const meta = (raw.match(/像|仿佛|宛如|好似|似的/g) || []).length;
    const totalChars = raw.length;
    return {
      chars: totalChars,
      paras: paras.length,
      sentences: sentences.length,
      avgLen: Math.round(avg * 10) / 10,
      sdLen: Math.round(sd * 10) / 10,
      dialogueRatio: Math.round((dialogParas / Math.max(1, paras.length)) * 100) / 100,
      metaphorPer1k: Math.round((meta / Math.max(1, totalChars)) * 10000) / 100,
      shortRatio: Math.round((lens.filter((n) => n <= 12).length / Math.max(1, lens.length)) * 100) / 100
    };
  }

  /* ---------------- 模板：新建项目时生成章节卡的骨架 ---------------- */

  const TEMPLATES = {
    threeAct: {
      label: '三幕结构 · 短篇 / 中篇',
      hint: '铺垫 25% · 对抗 50% · 收束 25%',
      beats: [
        ['日常被打断', '主角的日常出现第一个裂缝'],
        ['不得不回应', '裂缝扩大，主角必须做选择'],
        ['越界', '主角跨过一条自己定的界线'],
        ['代价出现', '选择的代价落在别人身上'],
        ['中点反转', '原本的理解被推翻'],
        ['失去抓手', '盟友离开，主角孤立'],
        ['最低点', '主角失败，暴露真正的软肋'],
        ['重新出发', '用一个具体的动作回到战场'],
        ['最终对抗', '与核心冲突正面相撞'],
        ['收束', '回答开篇提出的问题']
      ]
    },
    golden3: {
      label: '网文黄金三章 · 前 10 章',
      hint: '第 1 章给冲突，第 2 章给升级，第 3 章给爽点',
      beats: [
        ['开场冲突', '第一页就出事，主角被迫卷入'],
        ['升级', '敌人加码，主角露出一点本事'],
        ['第一个爽点', '主角赢一次，读者知道值得追'],
        ['世界展开', '规则露出冰山一角'],
        ['盟友出现', '一个会长期跟着的角色登场'],
        ['第一次失败', '主角的判断出错'],
        ['代价', '有人为这次错误付钱'],
        ['能力变化', '主角获得或失去一样东西'],
        ['反派现身', '真正的对手露面'],
        ['小高潮', '阶段性目标达成，更大的麻烦露头']
      ]
    },
    mystery: {
      label: '悬疑双线',
      hint: '明线查案，暗线是二十年前的旧事',
      beats: [
        ['异常出现', '一件不该发生的事发生了'],
        ['第一次调查', '主角开始问问题'],
        ['旧案浮出', '发现与多年前的一桩事有关'],
        ['证人消失', '关键的嘴闭上了'],
        ['误导', '一条看起来更顺的线索'],
        ['暗线推进', '过去的时间线走到关键节点'],
        ['反击', '有人开始针对主角'],
        ['两条线交汇', '明暗线指向同一个人'],
        ['真相', '主角拼出全貌'],
        ['余波', '真相被接受或被掩盖']
      ]
    },
    shortTwist: {
      label: '短篇反转',
      hint: '一个场景、两个人、一次反转',
      beats: [
        ['建立', '把两个人放进一个有张力的场景'],
        ['试探', '对话开始带刺'],
        ['第一次揭示', '一件被隐瞒的事被说出来'],
        ['升级', '变得不能回头'],
        ['反证', '出现一条推翻前面的话'],
        ['逼近', '逼到必须摊牌'],
        ['摊牌', '说破'],
        ['反转', '前面所有细节换了含义'],
        ['收束', '留下一个不安的余味'],
        ['余音', '最后一句改主意']
      ]
    }
  };

  function buildChapters(count, templateKeyOrBeats) {
    const beats = Array.isArray(templateKeyOrBeats)
      ? templateKeyOrBeats.filter((b) => b && (b.label || b.goal || (b[0] && b[1])))
        .map((b) => Array.isArray(b) ? [b[0], b[1]] : [b.label || '第 ' + (b.idx || ''), b.goal || ''])
      : (TEMPLATES[templateKeyOrBeats] || TEMPLATES.threeAct).beats;
    const tpl = { beats: beats.length ? beats : TEMPLATES.threeAct.beats };
    const n = Math.max(1, Math.min(200, +count || 10));
    const out = [];
    for (let i = 1; i <= n; i += 1) {
      /* 章数超过节拍数时不再循环套用（会造出一串同名章节），补空卡由用户自己填 */
      const beat = tpl.beats[i - 1] || ['', ''];
      out.push({
        id: uid('c'),
        idx: i,
        title: '第 ' + i + ' 章 ' + (beat[0] || '').trim() ? ('第 ' + i + ' 章 ' + (beat[0] || '').trim()) : ('第 ' + i + ' 章'),
        status: 'planned',
        card: {
          goal: beat[1],
          conflict: '',
          turn: '',
          pov: '',
          cast: [],
          plant: '',
          payoff: '',
          targetWords: 1500
        },
        blocks: []
      });
    }
    return out;
  }

  /* 示例小说的正文在 content/补字人/chNN.md 里写，跑 node scripts/build-content.js 生成 content.js。
     这里只做"把正文挂到章节卡上"，元数据（谁在场、在哪、有没有转场）由正文里的 @@ 指令决定。 */
  function applyContent(chs) {
    const src = (typeof window !== 'undefined' && window.SF_CONTENT) || null;
    if (!src) return chs;
    return chs.map((c) => {
      const paras = src['c' + c.idx];
      if (!paras || !paras.length) return c;
      const blocks = paras.map((p, k) => {
        const b = { id: 'b' + c.idx + '-' + (k + 1), text: typeof p === 'string' ? p : p.text };
        if (p.actors && p.actors.length) b.actors = p.actors.slice();
        if (p.place) b.place = p.place;
        if (p.moveTo) b.moveTo = p.moveTo;
        if (p.scene) b.scene = p.scene;
        return b;
      });
      c.blocks = blocks;
      c.status = c.idx <= 2 ? 'done' : 'draft';
      c.card.targetWords = 7000;
      return c;
    });
  }

  function demoPayload() {
    return {
      project: JSON.parse(JSON.stringify(project)),
      chapters: applyContent(JSON.parse(JSON.stringify(chapters))),
      entities: JSON.parse(JSON.stringify(entities)),
      worldRules: JSON.parse(JSON.stringify(worldRules)),
      foreshadows: JSON.parse(JSON.stringify(foreshadows)),
      proposedStates: JSON.parse(JSON.stringify(proposedStates)),
      confirmedStates: JSON.parse(JSON.stringify(confirmedStates)),
      waivers: [],
      kv: { lastChapterId: 'c3' }
    };
  }

  function blankPayload(opts) {
    const o = opts || {};
    const count = Math.max(1, Math.min(200, +o.chapterCount || 10));
    const chaptersOut = buildChapters(count, o.beats && o.beats.length ? o.beats : (o.template || 'threeAct'));
    return {
      project: {
        id: o.id || uid('p'),
        name: o.name || '未命名项目',
        genre: o.genre || '',
        logline: o.logline || '',
        sellPoint: o.sellPoint || '',
        desire: o.desire || '',
        conflict: o.conflict || '',
        conflicts: Array.isArray(o.conflicts) ? o.conflicts.slice() : [],
        conflictLead: o.conflictLead || '',
        targetWords: o.targetWords || count * 1500,
        chapterCount: count,
        isDemo: false,
        style: o.style || { pack: '', pov: '', tense: '', distance: '', sentence: '', dialogue: '', metaphor: '', tone: '', banned: [], sample: '', fp: null }
      },
      chapters: chaptersOut,
      entities: [],
      worldRules: o.worldRules || [],
      foreshadows: [],
      proposedStates: [],
      confirmedStates: [],
      waivers: [],
      kv: { lastChapterId: chaptersOut[0].id }
    };
  }

  /* 上下文清单：真实实现由 context 编译器算 token；原型按字数估（中文约 1 字 0.7 token） */
  function contextAssetsOf(d, chapterIdx) {
    const out = [];
    const p = d.project || {};
    const proj = [p.genre, p.logline, p.sellPoint, p.desire, p.conflict].filter(Boolean).join(' / ');
    out.push({ type: '项目设定', name: p.genre ? (p.name + ' · ' + p.genre) : '项目设定', tokens: Math.max(20, Math.round(proj.length * 0.7)) });

    const done = (d.chapters || []).filter((c) => c.idx < chapterIdx && c.blocks.length);
    done.slice(-3).forEach((c) => {
      out.push({ type: '章摘要', name: '第 ' + c.idx + ' 章', tokens: Math.round(c.card.goal.length * 0.7) + 60 });
    });
    if (done.length > 3) out.push({ type: '章摘要', name: '第 ' + (chapterIdx - 4) + ' 章及更早', tokens: 120 });

    const cur = (d.chapters || []).filter((c) => c.idx === chapterIdx)[0];
    if (cur) {
      const cardText = [cur.card.goal, cur.card.conflict, cur.card.turn, cur.card.pov, (cur.card.cast || []).join('、')].filter(Boolean).join(' ');
      out.push({ type: '章节卡', name: '第 ' + chapterIdx + ' 章 卡片', tokens: Math.max(40, Math.round(cardText.length * 0.7)) });
    }

    const cast = cur ? (cur.card.cast || []) : [];
    const cards = (d.entities || []).filter((e) => !cast.length || cast.indexOf(e.name) >= 0);
    if (cards.length) {
      const t = cards.reduce((a, e) => a + (e.name.length + (e.desire || '').length + (e.wound || '').length + (e.voice || '').length), 0);
      out.push({ type: '角色卡', name: cards.map((e) => e.name).slice(0, 4).join('、'), tokens: Math.max(60, Math.round(t * 0.7)) });
    }

    const worlds = (d.worldRules || []).slice(0, 4);
    if (worlds.length) {
      const t = worlds.reduce((a, w) => a + (w.name.length + (w.text || '').length), 0);
      out.push({ type: '世界观', name: worlds.map((w) => w.name).slice(0, 3).join('、'), tokens: Math.max(40, Math.round(t * 0.7)) });
    }

    out.push({ type: '风格卡', name: styleName(p.style), tokens: 90 });

    const cl = conflictNames(p);
    if (cl.length) out.push({ type: '阻力清单', name: cl.join('、'), tokens: Math.min(180, 40 + cl.length * 30) });

    const fs = (d.foreshadows || []).filter((f) => f.status !== 'resolved' && f.status !== 'abandoned');
    if (fs.length) out.push({ type: '伏笔', name: fs.length + ' 条待回收', tokens: Math.min(220, 40 + fs.length * 35) });

    return out;
  }

  /* 阻力清单的中文名与文风卡摘要：UI 与上下文面板、生成 prompt 都用同一套 */
  function conflictNames(p) {
    const keys = (p && p.conflicts) || [];
    return keys.map((k) => {
      const hit = CONFLICT_KINDS.filter((c) => c.key === k || c.label === k)[0];
      return hit ? hit.label : k;
    }).filter(Boolean);
  }

  function styleName(st) {
    const s = st || {};
    if (!s.pov && !s.pack && !s.tone) return '默认（未设置）';
    const pack = (STYLE_PACKS.filter((p) => p.key === s.pack)[0] || {}).label;
    const bits = [pack, s.pov, s.sentence, s.tone].filter(Boolean);
    return bits.length ? bits.join(' / ') : '自定义';
  }

  function stylePromptLine(st) {
    const s = st || {};
    const bits = [];
    if (s.pov) bits.push('人称：' + s.pov);
    if (s.tense) bits.push('时态：' + s.tense);
    if (s.distance) bits.push('叙述距离：' + s.distance);
    if (s.sentence) bits.push('句子：' + s.sentence);
    if (s.dialogue) bits.push('对话：' + s.dialogue);
    if (s.metaphor) bits.push('比喻：' + s.metaphor);
    if (s.tone) bits.push('情绪基调：' + s.tone);
    if (s.banned && s.banned.length) bits.push('禁用词：' + s.banned.join('、'));
    if (s.fp) bits.push('样本节奏：平均句长 ' + s.fp.avgLen + ' 字，对话段占比 ' + Math.round(s.fp.dialogueRatio * 100) + '%，比喻 ' + s.fp.metaphorPer1k + '/千字');
    return bits.join('；');
  }

  return {
    project, chapters, entities, worldRules,
    confirmedStates, proposedStates, foreshadows,
    templates: TEMPLATES,
    conflictKinds: CONFLICT_KINDS,
    conflictGroups: CONFLICT_GROUPS,
    stylePacks: STYLE_PACKS,
    styleFingerprint, conflictNames, styleName, stylePromptLine,
    uid, buildChapters, demoPayload, blankPayload, contextAssetsOf,
    contextBudget: 8000,
    settings: {
      baseURL: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      priceIn: 2, priceOut: 8, timeout: 120,
      slots: { draft: 'deepseek-chat', summary: 'deepseek-chat', extract: 'deepseek-chat' }
    }
  };
})();

/* 兼容旧引用：window.SF_DATA 仍是演示项目本身 */
window.SF_DATA.chapters = window.SF_DATA.chapters || [];
