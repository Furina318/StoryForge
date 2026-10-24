/*!
 * SFBlocks — block 版本化的纯逻辑层（浏览器与 Node 共用）
 *
 * 三条规则（ADR D3）：
 *  1. block.text 永不 UPDATE。改一个字 = 派生一个新 block，老的写 superseded_by 指向新的。
 *  2. 章节内容不存"当前正文"，存"第 rev 版由哪些 block 按什么顺序组成"（block_rev 快照）。
 *     回滚 = 把 current_rev 指回旧快照，不删任何数据。
 *  3. 采纳 AI 输出 = 一条 patch（before/after + rationale），可以照着 diff 撤。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SFBlocks = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var seq = 0;
  function uid(prefix) {
    seq = (seq + 1) % 100000;
    return (prefix || 'b') + '_' + Date.now().toString(36).slice(-5) + seq.toString(36);
  }

  function norm(list) {
    return (list || []).map(function (b) {
      return { id: b.id, text: String(b.text == null ? '' : b.text), src: b.src || 'human' };
    });
  }

  /**
   * 把"编辑器里的下一版"和"当前版"对比，算出版本化要做的动作。
   * next 里带 id 的表示沿用（可能改了字），不带 id 或 id 以 __new 开头表示新段。
   *
   * 返回 { keep, replace:[{oldId,newId,text,ord}], insert:[...], delete:[oldId], blocks, renames }
   */
  function planCommit(prevBlocks, nextBlocks) {
    var prev = norm(prevBlocks);
    var next = norm(nextBlocks);
    var byId = {};
    prev.forEach(function (b, i) { b.ord = i; byId[b.id] = b; });

    var keep = [], replace = [], insert = [], del = [], out = [], renames = {};
    var seen = {};

    next.forEach(function (nb, i) {
      var ord = i + 1;
      var old = nb.id && byId[nb.id];
      if (old) {
        seen[old.id] = true;
        if (old.text === nb.text) {
          out.push({ id: old.id, text: nb.text, src: nb.src, ord: ord });
          keep.push(old.id);
        } else {
          var nid = uid('b');
          renames[old.id] = nid;
          replace.push({ oldId: old.id, newId: nid, text: nb.text, src: nb.src, ord: ord });
          out.push({ id: nid, text: nb.text, src: nb.src, ord: ord });
        }
      } else {
        var fid = nb.id && String(nb.id).indexOf('__new') !== 0 ? nb.id : uid('b');
        insert.push({ id: fid, text: nb.text, src: nb.src, ord: ord });
        out.push({ id: fid, text: nb.text, src: nb.src, ord: ord });
      }
    });

    prev.forEach(function (pb) {
      if (!seen[pb.id]) del.push(pb.id);
    });

    var changed = replace.length + insert.length + del.length > 0;
    return {
      changed: changed,
      keep: keep, replace: replace, insert: insert, delete: del,
      blocks: out, renames: renames
    };
  }

  /** 块级 diff：按 block 顺序比，能直接给"这一段被改了"的视图 */
  function diffBlocks(prevBlocks, nextBlocks) {
    var a = norm(prevBlocks), b = norm(nextBlocks);
    var out = [];
    var max = Math.max(a.length, b.length);
    for (var i = 0; i < max; i++) {
      var pa = a[i], pb = b[i];
      if (pa && pb && pa.text === pb.text) out.push({ type: 'same', text: pb.text, index: i });
      else if (pa && pb) out.push({ type: 'change', before: pa.text, after: pb.text, index: i });
      else if (pb) out.push({ type: 'add', text: pb.text, index: i });
      else out.push({ type: 'del', text: pa.text, index: i });
    }
    return out;
  }

  /** 逐行 LCS 差异：返回 [{type:'same'|'add'|'del', text}] */
  function diffLines(aText, bText) {
    var a = String(aText == null ? '' : aText).replace(/\r\n/g, '\n').split('\n');
    var b = String(bText == null ? '' : bText).replace(/\r\n/g, '\n').split('\n');
    var n = a.length, m = b.length;
    var dp = [];
    for (var i = 0; i <= n; i++) { dp.push(new Array(m + 1).fill(0)); }
    for (i = n - 1; i >= 0; i--) {
      for (var j = m - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    var out = [], x = 0, y = 0;
    while (x < n && y < m) {
      if (a[x] === b[y]) { out.push({ type: 'same', text: a[x] }); x++; y++; }
      else if (dp[x + 1][y] >= dp[x][y + 1]) { out.push({ type: 'del', text: a[x] }); x++; }
      else { out.push({ type: 'add', text: b[y] }); y++; }
    }
    while (x < n) { out.push({ type: 'del', text: a[x++] }); }
    while (y < m) { out.push({ type: 'add', text: b[y++] }); }
    return out;
  }

  /* ---------- 三路合并（按句子做，中文里一行就是一段，按行看不出改哪儿） ---------- */

  /** 切成句子：按句末标点断，保留标点（只按句末断，避免两边切法不一致导致错位） */
  function tokenize(s) {
    var text = String(s == null ? '' : s).replace(/\r\n/g, '\n').trim();
    if (!text) return [];
    return text.match(/[^。！？!?…\n]+[。！？!?…]*|\n/g) || [text];
  }

  /**
   * 把 a 对齐到 b：返回 {map: [bIndex 或 -1], ins: {aIdx: [新增 token...]}}
   * 关键：LCS 只会给出「删一段 + 插一段」，这里把同位上的删除/插入配成"改写"，
   * 否则三路合并会把每一次改写当成"删了又加"，永远判不出谁动过哪一句。
   */
  function align(a, b) {
    var n = a.length, m = b.length;
    var dp = [];
    for (var i = 0; i <= n; i++) dp.push(new Array(m + 1).fill(0));
    for (i = n - 1; i >= 0; i--) {
      for (var j = m - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    /* 先求出锚点（相同 token 的位置对） */
    var anchors = [];
    var x = 0, y = 0;
    while (x < n && y < m) {
      if (a[x] === b[y]) { anchors.push([x, y]); x++; y++; continue; }
      if (dp[x + 1][y] >= dp[x][y + 1]) x++;
      else y++;
    }
    anchors.push([n, m]);

    var map = new Array(n).fill(-1);
    var ins = {};
    var prevA = 0, prevB = 0;
    anchors.forEach(function (pair) {
      var aEnd = pair[0], bEnd = pair[1];
      var aLen = aEnd - prevA, bLen = bEnd - prevB;
      var k = Math.min(aLen, bLen);
      if (aLen > bLen) {
        /* 我这边句子更多：说明末尾多了内容，从尾部对齐（前面对齐会错位） */
        for (var t = 0; t < k; t++) map[aEnd - k + t] = bEnd - k + t;
      } else {
        for (t = 0; t < k; t++) map[prevA + t] = prevB + t;            // 改写：同位配对
        for (t = k; t < bLen; t++) (ins[aEnd] = ins[aEnd] || []).push(b[prevB + t]); // 多出来的算插入
      }
      if (aEnd < n) map[aEnd] = bEnd;                            // 锚点本身
      prevA = aEnd + 1;
      prevB = bEnd + 1;
    });
    return { map: map, ins: ins };
  }

  function merge3Detailed(baseText, oursText, theirsText) {
    var base = tokenize(baseText), ours = tokenize(oursText), theirs = tokenize(theirsText);
    var oa = align(base, ours), ta = align(base, theirs);
    var baseSet = {};
    base.forEach(function (t) { baseSet[t] = true; });
    var oursSet = {}, theirsSet = {};
    ours.forEach(function (t) { oursSet[t] = true; });
    theirs.forEach(function (t) { theirsSet[t] = true; });

    var segs = [];
    function pushIns(idx) {
      var oIns = oa.ins[idx] || [], tIns = ta.ins[idx] || [];
      if (!oIns.length && !tIns.length) return;
      if (oIns.join('') === tIns.join('')) { if (oIns.length) segs.push({ type: 'same', text: oIns.join('') }); return; }
      if (!tIns.length) { segs.push({ type: 'ours', text: oIns.join('') }); return; }
      if (!oIns.length) { segs.push({ type: 'theirs', text: tIns.join('') }); return; }
      segs.push({ type: 'conflict', ours: oIns.join(''), theirs: tIns.join('') });
    }

    for (var i = 0; i < base.length; i++) {
      pushIns(i);
      var oIdx = oa.map[i], tIdx = ta.map[i];
      var oTok = oIdx >= 0 ? ours[oIdx] : null;
      var tTok = tIdx >= 0 ? theirs[tIdx] : null;
      var bTok = base[i];
      if (oTok === bTok && tTok === bTok) { segs.push({ type: 'same', text: bTok }); continue; }
      if (oTok != null && tTok != null && oTok === tTok) { segs.push({ type: 'same', text: oTok }); continue; }
      if (oTok === bTok) {                       // 我没动 → 用 AI 的；AI 删了就删
        if (tTok != null) segs.push({ type: 'theirs', text: tTok });
        else segs.push({ type: 'del', text: bTok });
        continue;
      }
      if (tTok === bTok) {                       // AI 没动 → 用我的；我删了就删
        if (oTok != null) segs.push({ type: 'ours', text: oTok });
        else segs.push({ type: 'del', text: bTok });
        continue;
      }
      segs.push({ type: 'conflict', ours: oTok || '', theirs: tTok || '' });
    }
    pushIns(base.length);

    var conflicts = segs.filter(function (s) { return s.type === 'conflict'; }).length;
    return { segments: segs, conflicts: conflicts };
  }

  function merge3(baseText, oursText, theirsText) {
    if (oursText === baseText) return { text: theirsText, conflicts: 0 };
    if (theirsText === baseText) return { text: oursText, conflicts: 0 };
    if (oursText === theirsText) return { text: oursText, conflicts: 0 };
    var r = merge3Detailed(baseText, oursText, theirsText);
    var out = r.segments.map(function (s) {
      if (s.type === 'conflict') return s.ours + s.theirs; // 文本版两边都留
      return s.text;
    });
    return { text: out.join(''), conflicts: r.conflicts };
  }

  return {
    uid: uid,
    planCommit: planCommit,
    diffLines: diffLines,
    diffBlocks: diffBlocks,
    tokenize: tokenize,
    merge3: merge3,
    merge3Detailed: merge3Detailed,
    diffLines: diffLines,
    diffBlocks: diffBlocks
  };
});
