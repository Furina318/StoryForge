/* StoryForge — 规则引擎（packages/rules）
 *
 * 设计约束（与 docs/v0.1.0-规则设计文档.md 一致）：
 *   1) 只读 confirmed 状态，proposed 一律不进判定；
 *   2) 每条 issue 必须带 blockId + quote，quote 必须是原文子串；
 *   3) 不调 LLM，同输入必同输出（可以在纯 Node 里跑测试）；
 *   4) 判定三态：hit / clear / skip（skip 必须带原因，不能混进 clear）。
 *
 * 双端可用：浏览器挂 window.SFRules，Node 走 module.exports。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SFRules = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var AI_TONE = [
    '不禁', '不由得', '仿佛', '似乎', '一丝', '一抹', '与此同时', '然而',
    '殊不知', '这一切', '命运', '宿命', '嘴角勾起', '深邃的眼眸', '空气仿佛凝固'
  ];
  var SOFT = ['似乎', '然而', '一丝', '一抹', '这一切'];

  var TH = {
    fsWarnGap: 2, fsBlockGap: 4,
    hitsMajor: 3, chapterAlarm: 8, minChapterChars: 200,
    drift: { avgSentLen: 8, dialogueRatio: 0.15, metaphorPer1k: 4, paraP90: 40 },
    minSd: { avgSentLen: 3, dialogueRatio: 0.05, metaphorPer1k: 1.5, paraP90: 15 }
  };

  function norm(s) {
    return String(s == null ? '' : s).normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '');
  }
  function countChars(s) {
    return (norm(s).replace(/\s/g, '').match(/[\u4e00-\u9fff\u3400-\u4dbfa-zA-Z0-9]/g) || []).length;
  }
  function sentences(text) {
    return norm(text).split(/[。！？…；!?]/).map(function (x) { return x.trim(); }).filter(Boolean);
  }
  function dialogueChars(text) {
    var n = 0, re = /[「『"“]([^」』"”]*)[」』"”]/g, m;
    while ((m = re.exec(norm(text)))) n += countChars(m[1]);
    return n;
  }
  function metaphorSentences(text) {
    return sentences(text).filter(function (s) { return /像|如|仿佛|似的/.test(s); }).length;
  }
  function pct90(arr) {
    if (!arr.length) return 0;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    return a[Math.min(a.length - 1, Math.floor(a.length * 0.9))];
  }
  function stats(blocks) {
    var text = blocks.map(function (b) { return b.text; }).join('\n');
    var cc = countChars(text), ss = sentences(text);
    var lens = blocks.map(function (b) { return countChars(b.text); });
    return {
      charCount: cc,
      sentences: ss.length,
      avgSentLen: ss.length ? +(cc / ss.length).toFixed(1) : 0,
      dialogueRatio: cc ? +(dialogueChars(text) / cc).toFixed(3) : 0,
      metaphorPer1k: cc ? +((metaphorSentences(text) / cc) * 1000).toFixed(1) : 0,
      paraP90: pct90(lens)
    };
  }
  function mean(a) { return a.reduce(function (x, y) { return x + y; }, 0) / (a.length || 1); }
  function sd(a) {
    if (a.length < 2) return 0;
    var m = mean(a);
    return Math.sqrt(a.reduce(function (s, x) { return s + (x - m) * (x - m); }, 0) / (a.length - 1));
  }
  function clip(s, n) {
    s = String(s || '').replace(/\s+/g, '');
    return s.length > n ? s.slice(0, n) : s;
  }
  function sentenceAt(text, term) {
    var ss = sentences(text), i;
    for (i = 0; i < ss.length; i++) if (ss[i].indexOf(term) >= 0) return clip(ss[i], 60);
    return clip(text, 60);
  }

  /* FNV-1a：给 waiver 绑内容用（改一个字哈希就变，忽略自动失效） */
  function hashText(s) {
    var h = 0x811c9dc5, t = norm(s);
    for (var i = 0; i < t.length; i++) {
      h ^= t.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8);
  }

  /* ---------- R-STYLE-01 禁忌词 / AI 味 ---------- */
  function style01(ctx, out, status) {
    var hitsByBlock = {}, total = 0;
    var pool = [];
    AI_TONE.concat((ctx.project.style && ctx.project.style.banned) || []).forEach(function (t) {
      if (t && pool.indexOf(t) < 0) pool.push(t);
    });
    ctx.chapter.blocks.forEach(function (b) {
      if (ctx.waived('R-STYLE-01', b.id)) { status.skipped += 1; return; }
      var hits = [];
      pool.forEach(function (term) {
        var idx = norm(b.text).indexOf(term);
        if (idx < 0) return;
        var occurrences = norm(b.text).split(term).length - 1;
        if (SOFT.indexOf(term) >= 0 && occurrences < 2) return;
        hits.push(term);
        total += occurrences;
      });
      if (hits.length) hitsByBlock[b.id] = hits;
    });
    Object.keys(hitsByBlock).forEach(function (bid) {
      var terms = hitsByBlock[bid], b = ctx.block(bid);
      var sev = terms.length >= TH.hitsMajor ? 'major' : 'minor';
      out.push({
        ruleId: 'R-STYLE-01', severity: sev, lane: 'rule', chapter: ctx.chapter.idx,
        claim: '出现 ' + terms.length + ' 处 AI 味短语：' + terms.join('、'),
        evidence: [{ blockId: bid, quote: sentenceAt(b.text, terms[0]) }],
        suggestion: '可参考本地替换表：' + terms.slice(0, 2).map(function (t) {
          return '「' + t + '」→ 删或改动作';
        }).join('；'),
        blockSeq: ctx.seqOf(bid),
        coalesce: 'b:' + bid + ':tone'
      });
    });
    return { blockHits: Object.keys(hitsByBlock).length, total: total };
  }

  /* ---------- R-STYLE-02 统计漂移 ---------- */
  function style02(ctx, out, status) {
    var cur = ctx.stats;
    if (cur.charCount < TH.minChapterChars) return { skipped: '本章字数不足 ' + TH.minChapterChars + '，样本太小' };
    var base = ctx.baseline;
    if (!base) return { skipped: '尚无基线章节' };
    var rows = [], keys = ['avgSentLen', 'dialogueRatio', 'metaphorPer1k', 'paraP90'];
    keys.forEach(function (k) {
      var x = cur[k], mu = base[k].mean, s = Math.max(base[k].sd, TH.minSd[k]);
      if (Math.abs(x - mu) > Math.max(TH.drift[k], 2 * s)) {
        rows.push({ k: k, x: x, mu: mu, s: s, delta: Math.abs(x - mu) });
      }
    });
    rows.sort(function (a, b) { return (b.delta / b.s) - (a.delta / a.s); });
    var label = { avgSentLen: '平均句长', dialogueRatio: '对话占比', metaphorPer1k: '比喻密度', paraP90: '段落长度 P90' };
    var unit = { avgSentLen: ' 字', dialogueRatio: '%', metaphorPer1k: '/千字', paraP90: ' 字' };
    var fmt = function (k, v) { return k === 'dialogueRatio' ? Math.round(v * 100) + '%' : Math.round(v * 10) / 10 + unit[k]; };
    rows.slice(0, 2).forEach(function (r) {
      out.push({
        ruleId: 'R-STYLE-02', severity: 'minor', lane: 'rule', chapter: ctx.chapter.idx,
        claim: '本章' + label[r.k] + ' ' + fmt(r.k, r.x) + '，前 ' + ctx.baselineCount + ' 章平均 ' +
          fmt(r.k, r.mu) + '（波动 ±' + fmt(r.k, r.s) + '）。是不是这段本来就这样？',
        evidence: [{ blockId: ctx.chapter.blocks[0].id, quote: clip(ctx.chapter.blocks[0].text, 40) }],
        coalesce: 'ch:' + ctx.chapter.id + ':drift:' + r.k
      });
    });
    return { hit: rows.length };
  }

  /* ---------- R-FS-01 伏笔超期 ---------- */
  function fs01(ctx, out, status) {
    var cur = ctx.chapter.idx;
    ctx.foreshadows.forEach(function (f) {
      if (f.status !== 'planted' && f.status !== 'touched') return;
      if (!f.due) { status.skipped += 1; return; }
      var dl = cur - Math.max(f.due, f.plantedChapter || 0);
      if (dl < 1) return;
      if (ctx.waived('R-FS-01', 'fs:' + f.id)) { status.skipped += 1; return; }
      var sev = dl >= TH.fsBlockGap ? 'blocker' : dl >= TH.fsWarnGap ? 'major' : 'minor';
      var b = ctx.block(f.plantedBlock);
      out.push({
        ruleId: 'R-FS-01', severity: sev, lane: 'rule', chapter: cur,
        claim: '「' + f.title + '」预计第 ' + f.due + ' 章回收，已超期 ' + dl + ' 章',
        evidence: b ? [{ blockId: f.plantedBlock, quote: sentenceAt(b.text, f.title.slice(0, 2)) }] : [],
        suggestion: '写进本章，或延后 3 章',
        coalesce: 'fs:' + f.id
      });
    });
  }

  /* ---------- R-FS-02 伏笔记录不完整 ---------- */
  function fs02(ctx, out, status) {
    ctx.foreshadows.forEach(function (f) {
      if (f.status === 'resolved' && !f.plantedBlock) {
        out.push({
          ruleId: 'R-FS-02', severity: 'minor', lane: 'rule', chapter: ctx.chapter.idx,
          claim: '「' + f.title + '」标记为已回收，但没有记录埋设位置',
          evidence: [], suggestion: '回到埋设那一章，点该段的伏笔标记', coalesce: 'fs2:' + f.id
        });
      }
      if (f.status === 'resolved' && f.plantedChapter && f.resolvedChapter &&
        f.resolvedChapter < f.plantedChapter) {
        out.push({
          ruleId: 'R-FS-02', severity: 'blocker', lane: 'rule', chapter: ctx.chapter.idx,
          claim: '「' + f.title + '」的回收章（' + f.resolvedChapter + '）早于埋设章（' + f.plantedChapter + '）',
          evidence: [], suggestion: '把回收章改到埋设之后', coalesce: 'fs2b:' + f.id
        });
      }
      if (f.status !== 'resolved' && f.due == null) {
        out.push({
          ruleId: 'R-FS-02', severity: 'minor', lane: 'rule', chapter: ctx.chapter.idx,
          claim: '「' + f.title + '」还没有预期回收章，超期检查无法生效',
          evidence: [], suggestion: '给这条伏笔写一个预计回收章', coalesce: 'fs2c:' + f.id
        });
      }
    });
  }

  /* ---------- 人物弧线（ARC 系列）
   *
   * 前提一：弧线是**可选**的。没写弧线的角色，这几条规则一律 skip，不算"通过"也不算"失败"。
   * 前提二：一个人的变化不止一条线。所以弧线是**一组线**，不是"一个类型"：
   *   entity.arcs = [
   *     { label:'对师父的看法', from:'他是自己跳下去的', to:'屋里还有第三个人',
   *       beats:[{chapter:6,text:'河堤上问出口'}],
   *       forbidden:['屋里还有第三个人'], reachChapter:6 },
   *     { label:'对这门手艺', from:'补字是修东西', to:'补字是替人把话说完', beats:[...] }
   *   ]
   * label 只是给人看的，可留空；几条线之间没有主次，也不要求"有始有终"。
   * 旧的单条写法（entity.arc）仍然读得到，当作一条没名字的线。
   * 章节卡上还可以写 card.changes：[{entity,field,from,to}] —— 这一章谁变了。
   */

  /* 把 entity 上的弧线统一成数组：兼容 arcs（多条）与 arc（旧单条） */
  function arcList(ent) {
    if (!ent) return [];
    var raw = [];
    if (Array.isArray(ent.arcs)) raw = ent.arcs.slice();
    if (ent.arc && ent.arc.on !== false) {
      var dup = raw.some(function (a) { return a && a.from === ent.arc.from && a.to === ent.arc.to; });
      if (!dup) raw.push(ent.arc);
    }
    return raw.filter(function (a) {
      if (!a || a.on === false) return false;
      return !!(a.from || a.to || (a.beats || []).length || (a.forbidden || []).length);
    });
  }

  function hasArc(ent) { return arcList(ent).length > 0; }

  function arcLabel(ent, arc, i) {
    var l = String(arc.label || '').trim();
    if (l) return '「' + ent.name + '」的「' + l + '」这条线';
    return '「' + ent.name + '」的第 ' + (i + 1) + ' 条弧线';
  }

  function arcEnds(arc) {
    var beats = (arc.beats || []).filter(function (b) { return b && b.chapter; });
    var last = beats.length ? beats[beats.length - 1].chapter : 0;
    return last;
  }

  /* 某角色的状态时间线：只读 confirmed，一条状态一个点 */
  function stateSeries(ctx, name, field) {
    return (ctx.confirmed || []).filter(function (s) {
      return s && s.entity === name && (!field || s.field === field) && s.chapter;
    }).sort(function (a, b) { return a.chapter - b.chapter; });
  }

  /* R-ARC-01 状态倒退：A → B → A，且这一章没有声明"他变了" */
  function arc01(ctx, out, status) {
    var arcs = (ctx.entities || []).filter(hasArc);
    if (!arcs.length) { status.skipped += 1; return; }
    arcs.forEach(function (ent) {
      var fields = {};
      stateSeries(ctx, ent.name).forEach(function (s) { if (s.field) fields[s.field] = 1; });
      Object.keys(fields).forEach(function (field) {
        var ser = stateSeries(ctx, ent.name, field);
        for (var i = 2; i < ser.length; i++) {
          var a = ser[i - 2], b = ser[i - 1], c = ser[i];
          if (!a.value || !c.value) continue;
          if (c.value !== a.value || b.value === a.value) continue;
          var ch = ctx.chapters.filter(function (x) { return x.idx === c.chapter; })[0];
          if (!ch) continue;
          if (ch.card && (ch.card.changes || []).some(function (x) { return x.entity === ent.name && x.field === field; })) continue;
          var key = 'arc1:' + ent.id + ':' + field + ':' + c.chapter;
          if (ctx.waived('R-ARC-01', key)) { status.skipped += 1; continue; }
          out.push({
            ruleId: 'R-ARC-01', severity: 'major', lane: 'rule', chapter: c.chapter,
            claim: '「' + ent.name + '」的「' + field + '」退回了更早的取值（第 ' + a.chapter + ' 章是「' + a.value +
              '」，第 ' + b.chapter + ' 章改成「' + b.value + '」，第 ' + c.chapter + ' 章又回到「' + c.value + '」），本章也没有写明这是他的一次转变',
            evidence: [{ blockId: c.block, quote: clip(c.quote, 40) }],
            contradicts: { blockId: b.block, quote: clip(b.quote, 40) },
            suggestion: '要么补一个说服人的反复理由，要么把这一章标记成一次转变',
            coalesce: key
          });
          break;
        }
      });
    });
  }

  /* R-ARC-02 越级：弧线上说"这时还不该有"的东西，提前出现了 */
  function arc02(ctx, out, status) {
    var ents = (ctx.entities || []).filter(function (e) {
      return arcList(e).some(function (a) { return (a.forbidden || []).length; });
    });
    if (!ents.length) { status.skipped += 1; return; }
    ents.forEach(function (ent) {
      arcList(ent).forEach(function (arc, ai) {
        if (!(arc.forbidden || []).length) return;
        var reach = arc.reachChapter || arcEnds(arc) || 0;
        if (!reach) return;
        arc.forbidden.forEach(function (term) {
          term = String(term || '').trim();
          if (term.length < 2) return;
          /* 同一句禁语只报第一次越级的那一章：连报五章等于刷屏，会把真正的问题淹掉 */
          var first = null, firstHits = [];
          ctx.chapters.forEach(function (ch) {
            if (first || ch.idx >= reach) return;
            var hits = ch.blocks.filter(function (b) {
              if (b.scene && ['dream', 'flashback', 'letter', 'vision', 'hallucination'].indexOf(b.scene) >= 0) return false;
              if (b.actors && b.actors.indexOf(ent.name) < 0) return false;
              return norm(b.text).indexOf(term) >= 0;
            });
            if (hits.length) { first = ch; firstHits = hits; }
          });
          if (!first) return;
          var key = 'arc2:' + ent.id + ':' + first.idx + ':' + term;
          if (ctx.waived('R-ARC-02', key)) { status.skipped += 1; return; }
          out.push({
            ruleId: 'R-ARC-02', severity: 'major', lane: 'rule', chapter: first.idx,
            claim: arcLabel(ent, arc, ai) + '里写着这一步「' + term + '」要到第 ' + reach +
              ' 章之后才出现，第 ' + first.idx + ' 章就提前用上了',
            evidence: firstHits.slice(0, 2).map(function (b) { return { blockId: b.id, quote: sentenceAt(b.text, term) }; }),
            suggestion: '要么改这一章，要么把这条线的这个节点往前挪',
            coalesce: key
          });
        });
      });
    });
  }

  /* R-ARC-03 转变无因：章节卡承诺"这一章谁变了"，正文里却没有证据 */
  function arc03(ctx, out, status) {
    var any = false;
    ctx.chapters.forEach(function (ch) {
      var changes = (ch.card && ch.card.changes) || [];
      changes.forEach(function (c) {
        any = true;
        if (ch.idx > ctx.chapter.idx) return;
        var hasState = (ctx.confirmed || []).some(function (s) {
          return s && s.entity === c.entity && s.chapter === ch.idx && (!c.field || s.field === c.field);
        });
        var hasScene = ch.blocks.some(function (b) {
          return b.actors && b.actors.indexOf(c.entity) >= 0;
        });
        if (hasState || hasScene) return;
        var key = 'arc3:' + ch.id + ':' + c.entity;
        if (ctx.waived('R-ARC-03', key)) { status.skipped += 1; return; }
        out.push({
          ruleId: 'R-ARC-03', severity: 'major', lane: 'rule', chapter: ch.idx,
          claim: '章节卡写着这一章「' + c.entity + '」要变（' + (c.from || '？') + ' → ' + (c.to || '？') +
            '），但本章既没有他出场的段落，也没有对应状态更新',
          evidence: [],
          suggestion: '补一场让他变的戏，或者把这条转变挪到别的章',
          coalesce: key
        });
      });
    });
    if (!any) status.skipped += 1;
  }

  /* R-ARC-04 弧线停滞：两个转折点之间，状态一动不动 */
  function arc04(ctx, out, status) {
    var ents = (ctx.entities || []).filter(function (e) {
      return arcList(e).some(function (a) { return (a.beats || []).length >= 2; });
    });
    if (!ents.length) { status.skipped += 1; return; }
    var ARC_GAP = 3;
    ents.forEach(function (ent) {
      /* 一个人有几条线时，停滞会同时出现在好几条线上。只报"跨度最大的那一段"：
         这条是 minor 的体感问题，一个角色一条就够作者动手了，报四条只会被无视。 */
      var best = null;
      arcList(ent).forEach(function (arc, ai) {
        var beats = (arc.beats || []).filter(function (b) { return b && b.chapter; })
          .sort(function (a, b) { return a.chapter - b.chapter; });
        for (var i = 0; i + 1 < beats.length; i++) {
          var from = beats[i].chapter, to = beats[i + 1].chapter;
          if (to - from < ARC_GAP) continue;
          var span = ctx.chapters.filter(function (ch) { return ch.idx > from && ch.idx < to; });
          if (!span.length || span.some(function (ch) { return !ch.blocks.length; })) continue;
          var changed = (ctx.confirmed || []).some(function (s) {
            return s && s.entity === ent.name && s.chapter > from && s.chapter < to;
          });
          if (changed) continue;
          if (!best || (to - from) > (best.to - best.from)) best = { arc: arc, ai: ai, from: from, to: to };
        }
      });
      if (!best) return;
      var key = 'arc4:' + ent.id + ':' + best.from + '-' + best.to;
      if (ctx.waived('R-ARC-04', key)) { status.skipped += 1; return; }
      out.push({
        ruleId: 'R-ARC-04', severity: 'minor', lane: 'rule', chapter: best.from,
        claim: arcLabel(ent, best.arc, best.ai) + '在第 ' + best.from + ' 章和第 ' + best.to + ' 章各有一个转折点，中间 ' +
          (best.to - best.from - 1) + ' 章状态没有任何变化，读起来会像在原地踏步',
        evidence: [],
        suggestion: '在这几章里加一次小变化（态度、习惯、和别人说话的方式都算）',
        coalesce: key
      });
    });
  }

  /* ---------- R-DEAD-01 已死亡角色继续行动 ---------- */
  function dead01(ctx, out, status) {
    var dead = ctx.confirmed.filter(function (s) {
      if (!s) return false;
      var isAliveField = s.field === 'alive' || s.field === '生死';
      var isDead = s.value === 'dead' || s.value === '已故';
      return isAliveField && isDead;
    });
    if (!dead.length) { status.skipped += 1; return; }
    dead.forEach(function (d) {
      var ent = ctx.byId(d.entity);
      ctx.chapters.forEach(function (ch) {
        if (ch.idx <= d.chapter) return;
        /* 同一章里同一具尸体只报一条：证据里最多列 3 段，剩下的在 claim 里说数量。
           一条一章还是逐段报，是误报率的分水岭——逐段报会在长章里刷出 20 条一样的错。 */
        var hits = ch.blocks.filter(function (b) {
          if (!b.actors || b.actors.indexOf(ent.name) < 0) return false;
          if (b.scene && ['dream', 'flashback', 'letter', 'vision', 'hallucination'].indexOf(b.scene) >= 0) return false;
          return true;
        });
        if (!hits.length) return;
        if (ctx.waived('R-DEAD-01', 'ch:' + ch.id + ':dead')) { status.skipped += 1; return; }
        var evidence = hits.slice(0, 3).map(function (b) {
          return { blockId: b.id, quote: clip(b.text, 60) };
        });
        evidence.push({ blockId: d.block, quote: clip(d.quote, 40) });
        out.push({
          ruleId: 'R-DEAD-01', severity: 'blocker', lane: 'rule', chapter: ch.idx,
          claim: '「' + ent.name + '」在第 ' + d.chapter + ' 章已死亡，第 ' + ch.idx + ' 章仍有主动行为'
            + (hits.length > 1 ? '（本章 ' + hits.length + ' 处，下面列前 3 处）' : ''),
          evidence: evidence,
          contradicts: { blockId: d.block, quote: d.quote },
          suggestion: '若是回忆/幻觉，请给该段打场景标记',
          coalesce: 'ch:' + ch.id + ':dead',
          hitCount: hits.length
        });
      });
    });
  }

  /* ---------- R-LOC-01 同章地点跳变缺转场 ---------- */
  function loc01(ctx, out, status) {
    ctx.chapters.forEach(function (ch) {
      if (ch.idx > ctx.chapter.idx && !ch.blocks.length) return;
      var locs = ch.blocks.filter(function (b) { return b.place; });
      var distinct = {};
      locs.forEach(function (b) { distinct[b.place] = 1; });
      if (Object.keys(distinct).length < 2) return;
      if (ch.blocks.some(function (b) { return b.scene === 'parallel'; })) return;
      var moves = ch.blocks.filter(function (b) { return b.moveTo; });
      if (!moves.length) {
        if (ctx.waived('R-LOC-01', 'ch:' + ch.id + ':loc')) { status.skipped += 1; return; }
        var first = locs[0], last = locs[locs.length - 1];
        out.push({
          ruleId: 'R-LOC-01', severity: 'major', lane: 'rule', chapter: ch.idx,
          claim: '本章从「' + first.place + '」到「' + last.place + '」，没有找到移动/转场描写',
          evidence: [{ blockId: first.id, quote: clip(first.text, 40) }, { blockId: last.id, quote: clip(last.text, 40) }],
          suggestion: '补一句转场，或把该段标为平行叙事',
          coalesce: 'ch:' + ch.id + ':loc'
        });
      } else {
        var move = moves[0];
        var after = locs.filter(function (b, i) { return i > ch.blocks.indexOf(move); })[0];
        if (after && after.place !== move.moveTo) {
          out.push({
            ruleId: 'R-LOC-01', severity: 'minor', lane: 'rule', chapter: ch.idx,
            claim: '移动到「' + move.moveTo + '」，但随后状态是「' + after.place + '」',
            evidence: [{ blockId: after.id, quote: clip(after.text, 40) }],
            coalesce: 'ch:' + ch.id + ':loc2'
          });
        }
      }
    });
  }

  /* ---------- R-KNOW-01 认知越界：说"记住了名字"，但前面没人说过 ---------- */
  /* 这是用户实际抓到的漏洞：第 1 章女孩从没报名字，第 55 段却写"他把这女孩的名字记在了心里"。
     判据很窄：只认"认知动词 + 名字/来历"这一种说法，且前文找不到名字的来源。 */
  var KNOW_A = /(知道|得知|认出|听出|记住|记下|记起|想起)[^。！？；\n]{0,8}(他|她|这|那|其|你|我)?的?(名字|姓名|真名|来历|身世)/;
  var KNOW_B = /(名字|姓名|真名)[^。！？；\n]{0,6}(记|刻|印|放)(在了|在|进了)(心里|心上|脑子里|心底)/;
  /* 只认"有人自报/被叫出名字"这一种来源：簿子上有名字、名字被挖走这类叙述不算，
     否则一本书里只要提过"名字"两个字，后面所有认知断言都会被放过 */
  var NAME_SRC_RE = /(我叫|我叫作|名叫|名字叫|自称|叫我做)/;

  function know01(ctx, out, status) {
    var pov = (ctx.chapter.card && ctx.chapter.card.pov) || '';
    /* 按时间顺序扫：只在"读到这一句时，读者还没被告知"的情况下报 */
    var seenSource = [];
    ctx.chapters.forEach(function (ch) {
      if (ch.idx > ctx.chapter.idx || !ch.blocks.length) return;
      ch.blocks.forEach(function (b) {
        var t = norm(b.text);
        if (NAME_SRC_RE.test(t)) seenSource.push(b.id);
        var ma = t.match(KNOW_A), mb = ma ? null : t.match(KNOW_B);
        var hit = ma || mb;
        if (!hit) return;
        if (NAME_SRC_RE.test(t)) return;                 // 同一段里就有来源
        if (seenSource.length) return;                   // 前面已经交代过
        if (b.scene === 'parallel') return;              // 平行叙事/回忆段不判
        if (ctx.waived('R-KNOW-01', 'ch:' + ch.id + ':' + b.id)) { status.skipped += 1; return; }
        var what = ma ? (ma[3] || '名字') : (mb[1] || '名字');
        out.push({
          ruleId: 'R-KNOW-01', severity: 'major', lane: 'rule', chapter: ch.idx,
          claim: (pov ? '「' + pov + '」' : '叙述者') + '这里写着知道了「' + what
            + '」，但到这一段为止没有人告诉过他、也没有从纸上读到过',
          evidence: [{ blockId: b.id, quote: clip(b.text, 60) }],
          suggestion: '要么让名字在前文被说出来（自报 / 他人提到 / 从簿子读到），要么把这句改成"记住了这张脸"',
          coalesce: 'ch:' + ch.id + ':' + b.id + ':know'
        });
      });
    });
  }

  /* ---------- R-STYLE-03 解释密集：连续对白在讲设定 ---------- */
  /* 只靠标点/词表判断"这一段在解释"很不稳，所以换成一个能验证的口径：
     对白里出现"规矩/道理/所谓/意味着/本质…"这类解释性词的段数。 */
  var EXPOS_RE = /(规矩|道理|本分|从来|向来|所谓|意味着|本质|其实|原来|才算|算数|意思就是|也就是说)/;
  var expoJudged = false;

  function isDialogueBlock(t) {
    t = String(t || '').trim();
    return t.charAt(0) === '「' || t.charAt(0) === '『' || t.charAt(0) === '"';
  }

  function style03(ctx, out, status) {
    var ch = ctx.chapter;
    var bs = ch.blocks.filter(function (b) { return String(b.text || '').trim(); });
    if (bs.length < 20 || ctx.stats.charCount < 800) return;
    expoJudged = true;
    var dlg = bs.filter(function (b) { return isDialogueBlock(b.text); });
    if (dlg.length < 20) return;
    var expo = dlg.filter(function (b) { return EXPOS_RE.test(norm(b.text)); });
    if (expo.length < 3) return;
    if (ctx.waived('R-STYLE-03', 'ch:' + ch.id + ':expo')) return;
    var sample = expo.slice(-2);
    out.push({
      ruleId: 'R-STYLE-03', severity: 'minor', lane: 'rule', chapter: ch.idx,
      claim: '本章有 ' + expo.length + ' 段对白在解释（规矩 / 道理 / 所谓 / 意味着…），'
        + '占对白的 ' + Math.round((expo.length / dlg.length) * 100) + '%，读起来像借人物之口讲设定',
      evidence: sample.map(function (b) { return { blockId: b.id, quote: clip(b.text, 50) }; }),
      suggestion: '挑一段改成"人物做错一件事 → 别人纠正他"，让规矩从冲突里露出来',
      coalesce: 'ch:' + ch.id + ':expo'
    });
  }

  var RULES = [
    { id: 'R-DEAD-01', name: '逝者行动', fn: dead01, kind: 'state' },
    { id: 'R-LOC-01', name: '地点跳变', fn: loc01, kind: 'state' },
    { id: 'R-FS-01', name: '伏笔超期', fn: fs01, kind: 'state' },
    { id: 'R-FS-02', name: '伏笔完整性', fn: fs02, kind: 'state' },
    { id: 'R-ARC-01', name: '状态倒退', fn: arc01, kind: 'state' },
    { id: 'R-ARC-02', name: '弧线越级', fn: arc02, kind: 'state' },
    { id: 'R-ARC-03', name: '转变无因', fn: arc03, kind: 'state' },
    { id: 'R-ARC-04', name: '弧线停滞', fn: arc04, kind: 'state' },
    { id: 'R-STYLE-01', name: 'AI 味短语', fn: style01, kind: 'text', perChapter: true },
    { id: 'R-STYLE-02', name: '统计漂移', fn: style02, kind: 'text', perChapter: true },
    { id: 'R-STYLE-03', name: '解释密集', fn: style03, kind: 'text', perChapter: true },
    { id: 'R-KNOW-01', name: '认知越界', fn: know01, kind: 'state' }
  ];

  /* ---------- 入口 ---------- */
  function run(data, chapterId) {
    var chapter = data.chapters.filter(function (c) { return c.id === chapterId; })[0];
    var out = { issues: [], indeterminate: [], stats: null, baseline: null, ruleStatus: [] };
    if (!chapter) return out;

    var byIdMap = {};
    data.entities.forEach(function (e) { byIdMap[e.id] = e; });
    var blockMap = {};
    data.chapters.forEach(function (ch) {
      ch.blocks.forEach(function (b) { blockMap[b.id] = b; });
    });

    /* 统计量一次算一遍：逐章规则会把全书跑一遍，每章再重算 stats 就是 O(n²) */
    var statsCache = {};
    function chStats(ch) {
      if (!statsCache[ch.id]) statsCache[ch.id] = stats(ch.blocks);
      return statsCache[ch.id];
    }

    function baselineFor(idx) {
      var baseChs = data.chapters.filter(function (c) {
        return c.idx < idx && c.status !== 'planned' && c.blocks.length;
      });
      if (!baseChs.length) return null;
      var baseStats = baseChs.map(function (c) { return chStats(c); });
      var b = {};
      ['avgSentLen', 'dialogueRatio', 'metaphorPer1k', 'paraP90'].forEach(function (k) {
        var arr = baseStats.map(function (s) { return s[k]; });
        b[k] = { mean: +mean(arr).toFixed(2), sd: +sd(arr).toFixed(2) };
      });
      return { values: b, count: baseChs.length };
    }

    var waivers = data.waivers || [];

    function waived(ruleId, coalesceKey, blockId) {
      return waivers.some(function (w) {
        if (w.expired || w.ruleId !== ruleId) return false;
        var hit = (w.key && w.key === coalesceKey) || (blockId && w.blockId === blockId) ||
          (w.blockId && w.blockId === coalesceKey);
        if (!hit) return false;
        /* 绑了内容哈希的 waiver：段落被改过就失效，需要重新判断 */
        if (w.textHash && w.blockId) {
          var b = blockMap[w.blockId];
          if (!b || hashText(b.text) !== w.textHash) return false;
        }
        return true;
      });
    }

    var ctx = {
      project: data.project || { style: {} },
      chapter: chapter,
      chapters: data.chapters,
      entities: data.entities || [],
      confirmed: data.confirmedStates || [],
      foreshadows: data.foreshadows || [],
      stats: stats(chapter.blocks),
      baseline: null,
      baselineCount: 0,
      byId: function (id) { return byIdMap[id] || { id: id, name: id }; },
      block: function (id) { return blockMap[id]; },
      seqOf: function (id) { return chapter.blocks.map(function (b) { return b.id; }).indexOf(id) + 1; },
      waived: function (ruleId, key) { return waived(ruleId, key, key); },
      hashText: hashText
    };

    var status = { skipped: 0 };
    var counts = {};

    RULES.forEach(function (rule) {
      var mine = [];
      var skipBefore = status.skipped;
      if (rule.perChapter) {
        data.chapters.forEach(function (ch) {
          if (!ch.blocks.length) return;
          var bl = baselineFor(ch.idx);
          var cctx = Object.assign({}, ctx, {
            chapter: ch,
            stats: chStats(ch),
            baseline: bl ? bl.values : null,
            baselineCount: bl ? bl.count : 0,
            seqOf: function (id) { return ch.blocks.map(function (b) { return b.id; }).indexOf(id) + 1; }
          });
          var r = rule.fn(cctx, mine, status) || {};
          if (r.skipped) {
            if (!counts[rule.id]) counts[rule.id] = { skipReasons: [] };
            counts[rule.id].skipReasons.push('第 ' + ch.idx + ' 章：' + r.skipped);
          }
        });
      } else {
        rule.fn(ctx, mine, status);
      }
      /* 非逐章规则没有拿到细则时，至少把"这条跳过过"记下来，不然界面会把 skip 显示成 clear */
      if (status.skipped > skipBefore) {
        counts[rule.id] = counts[rule.id] || {};
        if (!counts[rule.id].skipReasons || !counts[rule.id].skipReasons.length) {
          counts[rule.id].skipReasons = ['缺少可判定的输入（相关状态没确认 / 没有弧线 / 相关章还没写）'];
        }
      }
      counts[rule.id] = Object.assign(counts[rule.id] || {}, { hits: mine.length });
      mine.forEach(function (i) { out.issues.push(i); });
    });

    out.stats = stats(chapter.blocks);
    out.baseline = (baselineFor(chapter.idx) || {}).values || null;
    out.ruleStatus = RULES.map(function (rule) {
      var c = counts[rule.id] || {};
      var mine = out.issues.filter(function (i) { return i.ruleId === rule.id; });
      var st = mine.length ? 'hit' : ((c.skipReasons && c.skipReasons.length) ? 'skip' : 'clear');
      return {
        id: rule.id,
        name: rule.name,
        status: st,
        hits: mine.length,
        reason: st === 'skip' ? c.skipReasons[0] : ''
      };
    });

    (data.proposedStates || []).filter(function (p) { return !p.checked; }).forEach(function (p) {
      out.indeterminate.push('「' + p.entity + ' · ' + p.field + '」未确认，涉及该字段的规则已跳过');
    });
    var empty = data.chapters.filter(function (c) { return c.idx > chapter.idx && !c.blocks.length; }).length;
    if (empty) {
      out.indeterminate.push('第 ' + (chapter.idx + 1) + '–' + data.chapters.length +
        ' 章尚未抽取事件，' + (empty > 0 ? '3 条状态规则' : '') + '无法覆盖');
    }
    RULES.filter(function (r) { return r.kind === 'state'; }).forEach(function (r) {
      if (r.id === 'R-DEAD-01' && !(data.confirmedStates || []).length) {
        out.indeterminate.push('还没有任何已确认状态，逝者行动检查无输入');
      }
    });

    out.issues = out.issues.filter(function (it) {
      var blockIds = (it.evidence || []).map(function (e) { return e.blockId; });
      return !waivers.some(function (w) {
        if (w.expired || w.ruleId !== it.ruleId) return false;
        /* 哈希优先：段落被改过，任何形式的匹配都不算数（否则"改字后仍被忽略"这个坑又回来了） */
        if (w.textHash && w.blockId) {
          var b = blockMap[w.blockId];
          if (!b || hashText(b.text) !== w.textHash) return false;
        }
        if (it.coalesce && w.key === it.coalesce) return true;
        return !!w.blockId && blockIds.indexOf(w.blockId) >= 0;
      });
    });

    var order = { blocker: 0, major: 1, minor: 2 };
    out.issues.sort(function (a, b) {
      return order[a.severity] - order[b.severity] || (a.chapter - b.chapter) ||
        (a.blockSeq || 0) - (b.blockSeq || 0);
    });
    return out;
  }

  return {
    run: run,
    stats: stats,
    hashText: hashText,
    AI_TONE: AI_TONE,
    countChars: countChars,
    TH: TH,
    RULES: RULES.map(function (r) { return { id: r.id, name: r.name, kind: r.kind }; })
  };
});
