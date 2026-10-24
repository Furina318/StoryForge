/* StoryForge · 审阅代理（reference 栏）
 *
 * 跟规则引擎分工：
 *   规则 = 能写成算法的（谁死了还在说话、地点跳了没转场、伏笔超期）→ 承诺准确率
 *   审阅 = 只能读懂才判的（这段解释太密、这个伏笔回收得太机械、这里读起来不对）→ 只作参考
 *
 * 这个包里只有"怎么问"和"怎么收"，没有网络代码：调模型由调用方（app.js / auxCall）负责。
 * 所以它在 Node 里能被单测，在浏览器里也能直接用。
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.SFReview = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const KINDS = {
    logic: '逻辑/一致性',
    density: '解释过密',
    payoff: '回收机械',
    voice: '语气/节奏',
    other: '其他'
  };

  const SEVERITY = ['blocker', 'major', 'minor'];

  function clip(s, n) {
    s = String(s || '').replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  /* 引文不能带省略号，否则校验时对不上原文 */
  function quoteOf(s, n) {
    return String(s || '').replace(/\s+/g, ' ').trim().slice(0, n || 60);
  }

  function norm(s) {
    return String(s || '')
      .replace(/[\s\u3000]+/g, '')
      .replace(/[“”"'‘’]/g, '"')
      .replace(/[「」]/g, '"');
  }

  /* 送给模型的正文：带段落号，模型只能引用这些段落 */
  function blocksForPrompt(chapter, limit) {
    const bs = (chapter.blocks || []).filter((b) => String(b.text || '').trim());
    const max = limit || 60;
    const list = bs.slice(0, max);
    return {
      text: list.map((b) => '[' + b.id + '] ' + b.text).join('\n'),
      omitted: Math.max(0, bs.length - list.length)
    };
  }

  function systemPrompt(ctx) {
    const c = ctx.chapter;
    return [
      '你是一个中文小说的审稿人，只负责挑问题，不负责改写。',
      '读者是你的老板：他写了一章，想知道"哪里读起来不对"，但他不想被你教训。',
      '',
      '规则：',
      '1. 只输出 JSON 数组，不要任何解释、不要 markdown 代码块。',
      '2. 每条形如 {"kind":"logic|density|payoff|voice|other","severity":"blocker|major|minor",',
      '   "claim":"一句话说清问题","quote":"从正文里逐字抄的一句原文，必须是原文子串",',
      '   "suggestion":"一句话给方向，不要替他写","confidence":0-1}',
      '3. quote 必须逐字出现在正文里，长度 6–80 字；抄不准就不要报这条。',
      '4. 最多 6 条，宁可少报也不要凑数；没有值得说的问题就输出 []。',
      '5. 不要评判"写得好不好"这种主观品味，只报读者会绊住的地方：',
      '   - 前后矛盾：谁知道了不该知道的事、谁在不在场、东西从哪来的没交代',
      '   - 解释过密：人物之间像在互相讲设定，尤其连续几段对白都在说明规则',
      '   - 回收机械：伏笔回收得太急，一句"原来如此"就翻篇，没有代价也没有余波',
      '   - 语气节奏：同一段里叙述视角跳了，或者引号里的语气和人物卡不像一个人',
      '',
      '本章信息：第 ' + c.idx + ' 章《' + (c.title || '') + '》，视角：' + ((c.card && c.card.pov) || '未标注'),
      c.card && c.card.goal ? '本章目标：' + c.card.goal : '',
      c.card && c.card.conflict ? '本章冲突：' + c.card.conflict : ''
    ].filter(Boolean).join('\n');
  }

  function userPrompt(ctx) {
    const c = ctx.chapter;
    const pack = blocksForPrompt(c, ctx.limit);
    const out = ['正文（每段前面是段落号）：', pack.text];
    if (pack.omitted) out.push('（另有 ' + pack.omitted + ' 段因为太长没放进来，不要点评它们）');
    if (ctx.prevSummary) out.push('前一章的梗概（仅供参考，不要点评）：' + clip(ctx.prevSummary, 300));
    return out.join('\n\n');
  }

  /* 宽松解析：模型偶尔会带 ```json 围栏或前后废话 */
  function parse(text) {
    const raw = String(text || '').trim();
    if (!raw) return [];
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const body = fenced ? fenced[1] : raw;
    const start = body.indexOf('[');
    const end = body.lastIndexOf(']');
    if (start < 0 || end <= start) return [];
    let arr;
    try {
      arr = JSON.parse(body.slice(start, end + 1));
    } catch (e) {
      return [];
    }
    if (!Array.isArray(arr)) return [];
    return arr.filter((x) => x && typeof x === 'object').map((x) => ({
      kind: KINDS[x.kind] ? x.kind : 'other',
      severity: SEVERITY.indexOf(x.severity) >= 0 ? x.severity : 'minor',
      claim: clip(x.claim, 160),
      quote: clip(x.quote, 120),
      suggestion: clip(x.suggestion, 160),
      confidence: typeof x.confidence === 'number' ? Math.max(0, Math.min(1, x.confidence)) : 0.5
    }));
  }

  /* 证据校验：quote 必须是某一段原文的子串（归一化后比较），否则整条丢掉。
     这条规则和状态抽取是同一套标准——"说不出来源就不算数"。 */
  function validate(chapter, items) {
    const blocks = (chapter.blocks || []).filter((b) => String(b.text || '').trim());
    const kept = [];
    const dropped = [];
    (items || []).forEach((it) => {
      const q = norm(it.quote);
      if (!q || q.length < 4) { dropped.push({ item: it, why: '没有引文' }); return; }
      let hit = null;
      for (let i = 0; i < blocks.length; i++) {
        if (norm(blocks[i].text).indexOf(q) >= 0) { hit = blocks[i]; break; }
      }
      if (!hit) { dropped.push({ item: it, why: '引文对不上原文' }); return; }
      kept.push(Object.assign({}, it, { blockId: hit.id }));
    });
    const seen = {};
    const uniq = kept.filter((it) => {
      const k = it.kind + '|' + norm(it.claim).slice(0, 24);
      if (seen[k]) return false;
      seen[k] = 1;
      return true;
    });
    return { kept: uniq.slice(0, 6), dropped: dropped };
  }

  /* 没有 Key 时的示例审阅：只做"能算的"，并且明确告诉用户这是示例 */
  const MECH = /(至此|终于|原来|就这样|于是|这才明白|总算)/;
  const EXPOS = /(规矩|道理|本分|从来|向来|所谓|意味着|本质|其实|原来|才算|算数|意思就是|也就是说)/;

  function mockReview(chapter) {
    const bs = (chapter.blocks || []).filter((b) => String(b.text || '').trim());
    const items = [];

    const mech = bs.filter((b) => MECH.test(b.text) && String(b.text).length < 60);
    if (mech.length >= 2) {
      items.push({
        kind: 'payoff', severity: 'minor', blockId: mech[0].id,
        claim: '本章有 ' + mech.length + ' 处"至此/终于/原来"式的转折句，回收来得太快',
        quote: quoteOf(mech[0].text, 60),
        suggestion: '把其中一处往后放一章：先让人物做错一件事，回收才有代价',
        confidence: 0.5
      });
    }

    const dlg = bs.filter((b) => /^[「『"]/.test(String(b.text).trim()));
    const expo = dlg.filter((b) => EXPOS.test(b.text));
    if (expo.length >= 3) {
      items.push({
        kind: 'density', severity: 'minor', blockId: expo[0].id,
        claim: '有 ' + expo.length + ' 段对白在解释规则（占对白 ' + Math.round(expo.length / dlg.length * 100) + '%）',
        quote: quoteOf(expo[0].text, 60),
        suggestion: '挑一段改成"人物做错 → 被人纠正"，规矩从冲突里露出来',
        confidence: 0.5
      });
    }

    const long = bs.filter((b) => String(b.text).length > 160);
    if (long.length) {
      items.push({
        kind: 'voice', severity: 'minor', blockId: long[0].id,
        claim: '有一段 ' + String(long[0].text).length + ' 字没分段，读起来会累',
        quote: quoteOf(long[0].text, 60),
        suggestion: '在动作和心里话之间断开，一段只做一件事',
        confidence: 0.4
      });
    }

    return items;
  }

  return {
    KINDS: KINDS,
    clip: clip,
    quoteOf: quoteOf,
    blocksForPrompt: blocksForPrompt,
    systemPrompt: systemPrompt,
    userPrompt: userPrompt,
    parse: parse,
    validate: validate,
    mockReview: mockReview
  };
});
