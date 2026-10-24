/* StoryForge v0.1.0 — 原型交互层
   目标：功能分布可点、可看、可走通一遍。
   本轮新增：多项目（新建/切换/删除）、四类资料卡 CRUD、模型 Key 配置与真实连接测试、
   生成草稿走真 API（未配置时退回示例文本，保证界面永远走得到底）。
   真实实现见 docs/v0.1.0-功能文档.md（F1–F12）。 */

(function () {
  'use strict';

  var SEED = window.SF_DATA;
  var R = window.SFRules;
  var S = window.SFStore;
  var L = window.SFLLM;

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function fmtNum(n) { return String(n == null ? 0 : n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /* ---------------- 设置 ---------------- */

  var LS_KEY = 'sf.settings.v2';
  var PRESETS = [
    { id: 'deepseek', label: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat', priceIn: 2, priceOut: 8 },
    { id: 'openai', label: 'OpenAI', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini', priceIn: 1, priceOut: 4 },
    { id: 'moonshot', label: 'Moonshot', baseURL: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', priceIn: 12, priceOut: 12 },
    { id: 'gemini', label: 'Google Gemini', baseURL: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-flash', priceIn: 0, priceOut: 0 },
    { id: 'ollama', label: 'Ollama（本地）', baseURL: 'http://localhost:11434/v1', model: 'qwen2.5:7b', priceIn: 0, priceOut: 0, noKey: true }
  ];

  function loadSettings() {
    var base = clone(SEED.settings);
    base.apiKey = '';
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (raw) {
        var o = JSON.parse(raw);
        ['baseURL', 'model', 'timeout', 'priceIn', 'priceOut'].forEach(function (k) {
          if (o[k] != null) base[k] = o[k];
        });
        if (o.slots) base.slots = Object.assign(base.slots, o.slots);
        if (o.apiKey) base.apiKey = o.apiKey; // 浏览器直开时唯一的存处；Electron 下会立刻被 Key 文件覆盖
      }
    } catch (e) { /* 坏数据就当没配过 */ }
    return base;
  }

  function persistSettings(s) {
    try {
      if (window.sfBridge && window.sfBridge.saveKey) {
        if (s.apiKey) window.sfBridge.saveKey(s.apiKey);
        var safe = clone(s);
        safe.apiKey = '';
        localStorage.setItem(LS_KEY, JSON.stringify(safe));
      } else {
        localStorage.setItem(LS_KEY, JSON.stringify(s));
      }
    } catch (e) { /* 存不下不阻断使用 */ }
  }

  var LS_SIDE = 'sf.sidebar.v1';
  function loadSideView() {
    try { return localStorage.getItem(LS_SIDE) === 'wheel' ? 'wheel' : 'file'; } catch (e) { return 'file'; }
  }
  function saveSideView() {
    try { localStorage.setItem(LS_SIDE, state.sideView); } catch (e) { }
  }

  /* ---------------- 状态 ---------------- */

  var D = null;      // 当前项目 payload：{project, chapters[], entities[], worldRules[], foreshadows[], proposedStates[], confirmedStates[], waivers[], kv}
  var pid = null;    // 当前项目 id

  var APP_VERSION = '0.4.0';

  var state = {
    projects: [],
    chapterId: null,
    tab: 'cards',
    issues: [],
    indeterminate: [],
    ruleStatus: [],
    saveState: 'idle',
    savedAt: null,
    gen: { running: false, text: '', done: false, runId: null, usedApi: false, timer: null },
    chat: [],            // [{role:'user'|'assistant', text, applied?}]
    chatBusy: false,
    chatRun: null,       // {id, text}
    folds: { gen: false, issues: false, gate: true, ctx: true },
    settings: loadSettings(),
    typingHinted: false,
    confirmReset: false,
    editing: null,   // 当前表单的目标对象
    modalKind: null,
    lastAccept: null,     // 上一次采纳，用于撤销
    editId: null,         // 左栏里正在编辑/选中的资料卡 id（档案卡视图下高亮并展开）
    gatePage: 0,          // 待确认闸门分页（每页 5 条）
    excluded: {},         // 本次上下文里被用户排除的资产（只在本次会话生效）
    auxRun: {},           // 抽取 / 摘要这类一次性模型任务，按 runId 分流
    sideView: loadSideView(),  // 左栏视图：'file'（档案卡）| 'wheel'（滚轮）
    reelSel: {},           // 滚轮每个 tab 当前选中的下标
    merge: null,           // 三路合并的临时状态
    confirmDel: null,      // 待二次确认的段落 id
    lastReelWheel: 0,
    review: null,          // 审阅代理最近一次结果：{ chapterId, items, dropped, mock, model }
    reviewBusy: false,
    composing: false,      // 输入法正在组字
    undo: [],              // 撤销栈：[{ chapterId, text }]
    redo: [],              // 重做栈
    undoAt: 0,
    undoSnap: null,
    renderLimit: 80        // 长章节先渲染这么多段，滚到底再续

  };

  function chapters() { return (D && D.chapters) || []; }
  function cur() { return chapters().filter(function (c) { return c.id === state.chapterId; })[0]; }
  function chWords(ch) {
    return ((ch && ch.blocks) || []).reduce(function (a, b) {
      return a + (b.text || '').replace(/\s/g, '').length;
    }, 0);
  }
  function totalWords() {
    return chapters().reduce(function (a, c) { return a + chWords(c); }, 0);
  }
  function projWords() {
    return state.projects.reduce(function (a, p) { return a + (p.words || 0); }, 0);
  }
  function statusChip(s, words) {
    var map = { done: ['已完成', 'done'], draft: ['草稿', 'draft'], planned: ['待写', 'planned'] };
    var v = map[s] || map.planned;
    var tail = (words && s !== 'planned') ? ' · ' + words + ' 字' : '';
    return '<span class="chip ' + v[1] + '">' + v[0] + tail + '</span>';
  }
  function field(k, v) {
    return '<div class="field"><span>' + k + '</span><b>' + esc(v || '—') + '</b></div>';
  }

  /* ---------------- 载入 / 切换项目 ---------------- */

  /* SQLite 返回的 chapters 是以 id 为键的对象，localStorage 返回的是数组：在这里统一成数组 */
  function normalize(payload) {
    if (!payload) return null;
    var d = payload;
    var chs = d.chapters || [];
    if (!Array.isArray(chs)) {
      chs = Object.keys(chs).map(function (id) {
        return Object.assign({ id: id }, chs[id]);
      });
    }
    d.chapters = chs.map(function (c) {
      return {
        id: c.id,
        idx: +c.idx || 0,
        title: c.title || ('第 ' + c.idx + ' 章'),
        status: c.status || 'planned',
        card: Object.assign({ goal: '', conflict: '', turn: '', pov: '', cast: [], plant: '', payoff: '', targetWords: 1500 }, c.card || {}),
        /* 抽取元数据（actors/place/moveTo/scene）一定要留着：DEAD-01、LOC-01 全靠它，
           一旦在归一化里丢掉，规则会静默失灵（体检看着正常，只是什么都不报） */
        blocks: (c.blocks || []).map(function (b) {
          var meta = b.meta;
          if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch (e) { meta = null; } }
          var out = Object.assign({}, meta || {}, b);
          delete out.meta;
          out.text = out.text || '';
          out.src = out.src || 'human';
          return out;
        })
      };
    }).sort(function (a, b) { return a.idx - b.idx; });

    d.project = d.project || {};
    d.project.style = Object.assign({ pov: '', tense: '', tone: '', banned: [], dialogueRatio: [] }, d.project.style || {});
    d.entities = d.entities || [];
    d.worldRules = d.worldRules || [];
    d.foreshadows = d.foreshadows || [];
    d.proposedStates = (d.proposedStates || []).map(function (p) {
      /* low 不入库（entity_state 没有这一列），按置信度重算，保证刷新后视觉标记不丢 */
      if (p.low === undefined) p.low = (typeof p.conf === 'number' && p.conf < 0.7);
      return p;
    });
    d.confirmedStates = d.confirmedStates || d.confirmed || [];
    d.waivers = d.waivers || [];
    d.kv = d.kv || {};
    if (!d.chapters.length) {
      var keep = SEED.buildChapters(1, 'threeAct')[0];
      keep.card = SEED.blankPayload({}).chapters[0].card;
      d.chapters.push(keep);
    }
    return d;
  }

  function openProject(nextPid, opts) {
    return S.loadProject(nextPid).then(function (payload) {
      var d = normalize(payload);
      if (!d) throw new Error('项目不存在或已损坏');
      hideEmptyHome();
      pid = nextPid;
      D = d;
      var last = d.kv && d.kv.lastChapterId;
      state.chapterId = (last && d.chapters.some(function (c) { return c.id === last; }))
        ? last
        : d.chapters[0].id;
      state.gen = { running: false, text: '', done: false, runId: null, usedApi: false, timer: null };
      state.saveState = 'idle';
      state.savedAt = null;
      state.issues = [];
      state.indeterminate = [];
      state.ruleStatus = [];
      state.lastAccept = null;
      if (d.kv && d.kv.lastAccept) {
        try { state.lastAccept = JSON.parse(d.kv.lastAccept); } catch (e) { state.lastAccept = null; }
      }
      state.gatePage = 0;
      state.excluded = {};
      renderAll();
      if (opts && opts.toast) toast(opts.toast);
      return d;
    });
  }

  function refreshProjects() {
    return S.listProjects().then(function (list) {
      state.projects = list || [];
      renderTop();
      return list;
    });
  }

  /* ---------------- 顶栏 ---------------- */

  function renderTop() {
    if (!D) return;
    var p = D.project;
    $('#projName').textContent = p.name;
    $('#projMeta').textContent = [p.genre, '目标 ' + fmtNum(p.targetWords || 0) + ' 字', chapters().length + ' 章']
      .filter(Boolean).join(' · ');
    $('#totalWc').innerHTML = '本书 <b>' + fmtNum(totalWords()) + '</b> 字';
  }

  /* ---------------- 左栏 ---------------- */

  function renderLeft() {
    if (!D) return;
    $$('#tabs button').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-tab') === state.tab);
    });
    var vt = $('#btnView');
    if (vt) {
      vt.innerHTML = state.sideView === 'wheel' ? '◍' : '▤';
      vt.title = state.sideView === 'wheel' ? '当前：滚轮视图 · 点一下换成档案卡' : '当前：档案卡视图 · 点一下换成滚轮';
    }
    var body = $('#leftBody');
    body.className = 'pane-body view-' + state.sideView;
    if (state.sideView === 'wheel') {
      /* 滚轮视图别整块重建：节点一换，CSS 过渡就失效，卡片会"啪"地跳过去 */
      var reel = $('#reel');
      var sig = reelSig();
      if (reel && reel.getAttribute('data-sig') === sig) { syncReel(); return; }
      body.innerHTML = '<div class="reel" id="reel" data-sig="' + esc(sig) + '">' + reelHtml() + '</div>';
      syncReel();
      return;
    }
    if (state.tab === 'cards') {
      var html = '';
      chapters().forEach(function (c, i) {
        var on = c.id === state.chapterId;
        html += '<div class="chapter-item ' + (on ? 'on ' : '') + (c.status === 'done' ? 'done ' : '') + (c.card.locked ? 'locked' : '') + '" data-ch="' + c.id + '">' +
          '<div class="head">' +
          '<div class="no">' + c.idx + '</div>' +
          '<div class="ct"><div class="t">' + esc(c.title) + (c.card.locked ? ' <span class="lk" title="已锁定：改正文前会先问一句">锁</span>' : '') + '</div>' +
          '<div class="g">' + esc(c.card.goal || '（未填目标）') + '</div></div>' +
          '<span class="chip-wrap">' + statusChip(c.status, chWords(c)) + '</span>' +
          '<span class="item-tools">' +
          (i > 0 ? '<button class="item-act" data-act="ch-up" data-id="' + c.id + '" title="上移">↑</button>' : '') +
          (i < chapters().length - 1 ? '<button class="item-act" data-act="ch-down" data-id="' + c.id + '" title="下移">↓</button>' : '') +
          '<button class="item-act" data-act="edit-ch" data-id="' + c.id + '" title="编辑章节卡">✎</button>' +
          '</span>' +
          '</div>' +
          '<div class="inline-detail">' +
          dkv('目标', c.card.goal) + dkv('冲突', c.card.conflict) + dkv('转折', c.card.turn) +
          (c.card.plant || c.card.payoff ? dkv('伏笔', (c.card.plant ? '埋：' + c.card.plant : '') + (c.card.payoff ? '　收：' + c.card.payoff : '')) : '') +
          '<div class="inline-acts">' +
          '<button class="btn sm primary" data-act="gen">继续写</button>' +
          '<button class="btn sm" data-act="edit-ch" data-id="' + c.id + '">编辑卡</button>' +
          '<button class="btn sm" data-act="ch-history" data-id="' + c.id + '">历史 ' + (c.rev || 1) + ' 版</button>' +
          '<button class="btn sm" data-act="toggle-lock" data-id="' + c.id + '">' + (c.card.locked ? '解锁' : '锁定') + '</button>' +
          '</div></div>' +
          '</div>';
      });
      html += '<button class="btn ghost sm add-ch" data-act="new-ch">＋ 新增一章</button>';
      body.innerHTML = html;
      /* 换章后把当前章滚进可视区（平滑），否则长列表里选中项会跑到屏幕外 */
      if (state.scrollCh !== state.chapterId) {
        state.scrollCh = state.chapterId;
        var onEl = body.querySelector('.chapter-item.on');
        if (onEl && onEl.scrollIntoView) {
          try { onEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (err) { onEl.scrollIntoView(); }
        }
      }
    } else if (state.tab === 'chars') {
      body.innerHTML = (D.entities.length ? D.entities.map(function (e) {
        var on = state.editId === e.id;
        return '<div class="list-item' + (on ? ' on' : '') + '" data-act="edit-entity" data-id="' + e.id + '">' +
          '<div class="lt"><b>' + esc(e.name) + '</b><span class="chip">' + esc(e.kind) + '</span>' +
          (e.role ? '<span class="ld2">' + esc(e.role) + '</span>' : '') + '</div>' +
          (e.desire ? '<div class="ld">欲望：' + esc(e.desire) + '</div>' : '') +
          '<div class="ld-more">' +
          (e.wound ? '<div class="ld">伤口：' + esc(e.wound) + '</div>' : '') +
          (e.voice ? '<div class="ld">声音：' + esc(e.voice) + '</div>' : '') +
          (e.secret ? '<div class="ld">藏着：' + esc(e.secret) + '</div>' : '') +
          '</div></div>';
      }).join('') : emptyHint('还没有角色卡', '从「新建」开始，先填三件事：他想要什么、他怕什么、他怎么说话。'));
    } else if (state.tab === 'world') {
      body.innerHTML = (D.worldRules.length ? D.worldRules.map(function (w) {
        var on = state.editId === w.id;
        return '<div class="list-item' + (on ? ' on' : '') + '" data-act="edit-world" data-id="' + w.id + '">' +
          '<div class="lt"><b>' + esc(w.name) + '</b><span class="chip">' + esc(w.kind) + '</span></div>' +
          '<div class="ld">' + esc(w.text) + '</div></div>';
      }).join('') : emptyHint('还没有世界观条目', '只写会真正影响剧情的那几条：规则、地点、势力、能力代价。'));
    } else {
      var now = cur() ? cur().idx : 1;
      body.innerHTML = (D.foreshadows.length ? D.foreshadows.map(function (f) {
        var late = f.due ? now - f.due : 0;
        var badge = late >= 2 ? '<span class="chip" style="background:#f9e6e1;color:#b4462f">超期 ' + late + ' 章</span>'
          : f.status === 'touched' ? '<span class="chip draft">已触碰</span>'
            : f.status === 'resolved' ? '<span class="chip done">已回收</span>'
              : '<span class="chip">待回收</span>';
        var on = state.editId === f.id;
        return '<div class="list-item' + (on ? ' on' : '') + '" data-act="edit-fs" data-id="' + f.id + '">' +
          '<div class="lt"><b>' + esc(f.title) + '</b>' + badge + '</div>' +
          '<div class="ld">埋于第 ' + f.plantedChapter + ' 章 · 预期第 ' + (f.due || '—') + ' 章回收</div>' +
          '<div class="ld-more"><div class="ld">' + esc(f.note || '（没写备注）') + '</div></div></div>';
      }).join('') : emptyHint('还没有伏笔', '伏笔是任务：埋在哪、什么时候收、收不了就删掉。'));
    }
  }

  function dkv(k, v) {
    if (!v) return '';
    return '<div class="dkv"><b>' + k + '</b><span>' + esc(v) + '</span></div>';
  }

  /* 切章：落一次盘 → 换章 → 重渲染（列表点击和滚轮都走这里）
     opts.soft：滚轮视图里用，只重渲染中栏/右栏，左栏留着让动画跑完 */
  function selectChapter(id, opts) {
    if (!id || id === state.chapterId) return;
    flushSave();
    state.chapterId = id;
    state.gen = { running: false, text: '', done: false, runId: null, usedApi: false, timer: null };
    state.renderLimit = 80;          // 换章：先只渲染前 80 段
    if (pid) S.setKv(pid, 'lastChapterId', id);
    if (opts && opts.soft && state.sideView === 'wheel') {
      /* 滚轮/连按方向键时，正文重渲染（一百多段）会卡住滑动；
         先只更新状态栏，等手停下来再补正文与右栏 */
      renderStatus();
      clearTimeout(state.softTimer);
      state.softTimer = setTimeout(function () {
        state.softTimer = null;
        renderTop(); renderCenter(); renderRight(); renderStatus();
        syncReel();
        var box2 = $('#editor'); if (box2) box2.scrollTop = 0;
      }, 110);
      return;
    } else {
      renderAll();
    }
    var box = $('#editor');
    if (box) box.scrollTop = 0;
    else { var eb = $('#editorInner'); if (eb) eb.scrollTop = 0; }
  }

  /* ---------------- 滚轮视图 ---------------- */

  function reelItems() {
    if (state.tab === 'cards') {
      return chapters().map(function (c) {
        return {
          id: c.id, act: 'ch',
          title: '第 ' + c.idx + ' 章 · ' + c.title.replace(/^第.+?章\s*/, ''),
          sub: c.card.goal || '（未填目标）',
          chip: ({ done: '已完成', draft: '草稿', planned: '待写' })[c.status] || '待写'
        };
      });
    }
    if (state.tab === 'chars') {
      return D.entities.map(function (e) {
        return { id: e.id, act: 'edit-entity', title: e.name + (e.kind ? ' · ' + e.kind : ''), sub: e.role || e.desire || '', chip: '' };
      });
    }
    if (state.tab === 'world') {
      return D.worldRules.map(function (w) {
        return { id: w.id, act: 'edit-world', title: w.name, sub: w.text || '', chip: w.kind || '' };
      });
    }
    return D.foreshadows.map(function (f) {
      return {
        id: f.id, act: 'edit-fs', title: f.title,
        sub: '埋于第 ' + f.plantedChapter + ' 章 · 预期第 ' + (f.due || '—') + ' 章回收',
        chip: f.status === 'resolved' ? '已回收' : f.status === 'touched' ? '已触碰' : '待回收'
      };
    });
  }

  function reelInfo() {
    var items = reelItems();
    var sel = state.reelSel[state.tab];
    if (typeof sel !== 'number' || sel < 0 || sel >= items.length) {
      if (state.tab === 'cards') {
        var i = chapters().findIndex(function (c) { return c.id === state.chapterId; });
        sel = i >= 0 ? i : 0;
      } else sel = 0;
      state.reelSel[state.tab] = sel;
    }
    /* 换章过程中（state.reelHold）别把选中项拽回当前章，否则动画会被"弹回" */
    if (!state.reelHold && state.tab === 'cards' && items[sel] && items[sel].id !== state.chapterId) {
      var j = chapters().findIndex(function (c) { return c.id === state.chapterId; });
      if (j >= 0) { sel = j; state.reelSel[state.tab] = sel; }
    }
    return { items: items, sel: sel };
  }

  /* 章节是有序的：不绕圈（否则第 1 章上面出现第 10 章，看着像出错）；资料卡无所谓顺序，允许首尾相接 */
  function reelDist(i, sel, n) {
    if (state.tab === 'cards') return i - sel;
    var d = i - sel;
    if (d > n / 2) d -= n;
    if (d < -n / 2) d += n;
    return d;
  }

  /* 首尾留白：选中的卡在中间，但选第 1 章时上面没有卡、选最后一章时下面没有卡，
     所以整摞要往上/往下挪一点，让列表看起来是"填满的"而不是贴边 */
  function reelOffset(sel, n) {
    if (state.tab !== 'cards') return 0;
    var head = Math.max(0, 2 - sel);            // 上面还有几张没填满
    var tail = Math.max(0, sel - (n - 3));      // 下面还有几张没填满
    return (tail - head) * 112;
  }

  function reelHtml() {
    var r = reelInfo();
    var n = r.items.length;
    if (!n) return '<div class="empty-hint"><b>这一栏还是空的</b><span>先建一个，然后它就会转起来。</span></div>';
    var off = reelOffset(r.sel, n);
    var out = '';
    r.items.forEach(function (it, i) {
      var d = reelDist(i, r.sel, n);
      if (Math.abs(d) > 6) return;
      out += '<div class="reel-card' + (d === 0 ? ' on' : '') + '" data-reel="' + i + '" data-rid="' + it.id + '" data-ract="' + it.act + '" ' +
        'style="transform:translate(-50%,-50%) translateY(' + (d * 76 + off) + 'px) scale(' + (d === 0 ? 1 : Math.max(.8, 1 - Math.abs(d) * .04)) + ');' +
        'opacity:' + (d === 0 ? 1 : Math.max(.08, 1 - Math.abs(d) * .2)) + ';z-index:' + (10 - Math.abs(d)) + '">' +
        (it.chip ? '<span class="rc">' + esc(it.chip) + '</span>' : '') +
        '<div class="rt">' + esc(it.title) + '</div>' +
        (it.sub ? '<div class="rs">' + esc(it.sub) + '</div>' : '') +
        '</div>';
    });
    out += '<div class="reel-hint">滚轮 / ↑↓ 换一张，点中间那张打开</div>';
    return out;
  }

  /* 滚轮视图的"内容指纹"：章节/资料卡有增删改才重建节点，纯换选中只跑动画 */
  function reelSig() {
    return state.tab + '|' + reelItems().map(function (it) {
      return it.id + '\u0001' + it.title + '\u0001' + (it.sub || '') + '\u0001' + (it.chip || '');
    }).join('\u0002');
  }

  function syncReel() {
    var reel = $('#reel');
    if (!reel) return;
    var r = reelInfo();
    var off = reelOffset(r.sel, r.items.length);
    [].forEach.call(reel.querySelectorAll('.reel-card'), function (el) {
      var i = +el.getAttribute('data-reel');
      var d = reelDist(i, r.sel, r.items.length);
      el.classList.toggle('on', d === 0);
      el.style.transform = 'translate(-50%,-50%) translateY(' + (d * 76 + off) + 'px) scale(' + (d === 0 ? 1 : Math.max(.8, 1 - Math.abs(d) * .04)) + ')';
      el.style.opacity = d === 0 ? 1 : Math.max(.08, 1 - Math.abs(d) * .2);
      el.style.zIndex = 10 - Math.abs(d);
    });
  }

  function reelStep(dir) {
    var r = reelInfo();
    if (!r.items.length) return;
    var next = (r.sel + dir + r.items.length) % r.items.length;
    state.reelSel[state.tab] = next;
    /* 先把卡片挪到新位置（CSS 过渡负责滑动），再换章节内容；不重建左栏，动画才不被打断 */
    state.reelHold = true;
    try {
      syncReel();
      if (state.tab === 'cards') {
        var c = r.items[next];
        if (c && c.id !== state.chapterId) selectChapter(c.id, { soft: true });
      }
    } finally {
      state.reelHold = false;
    }
    syncReel();
  }

  function reelPick(i) {
    var r = reelInfo();
    if (i === r.sel) {
      var it = r.items[i];
      if (!it) return;
      if (state.tab === 'cards') { $('#editorInner').setAttribute('tabindex', '-1'); $('#editorInner').focus(); }
      else {
        var acts = { 'edit-entity': openEntityForm, 'edit-world': openWorldForm, 'edit-fs': openFsForm };
        var fn = acts[it.act];
        if (fn) {
          var list = state.tab === 'chars' ? D.entities : state.tab === 'world' ? D.worldRules : D.foreshadows;
          fn(list.filter(function (x) { return x.id === it.id; })[0] || null);
        }
      }
      return;
    }
    state.reelSel[state.tab] = i;
    if (state.tab === 'cards' && r.items[i].id !== state.chapterId) {
      selectChapter(r.items[i].id);
    }
    renderLeft();
  }

  function emptyHint(title, body) {
    return '<div class="empty-hint"><b>' + esc(title) + '</b><span>' + esc(body) + '</span></div>';
  }

  /* ---------------- 中栏 ---------------- */

  function renderCenter() {
    if (!D) return;
    var c = cur();
    if (!c) return;
    var title = c.title.replace(/^第.+?章\s*/, '');
    var lockChip = c.card.locked ? '<span class="chip lock" title="本章已锁定，正文不可直接编辑">锁定</span>' : '';
    $('#chapterHead').innerHTML = '<div class="ch-main"><h2>第 ' + c.idx + ' 章 · ' + esc(title) + '</h2>' +
      statusChip(c.status) + lockChip + '<span class="goal">' + esc(c.card.goal || '') + '</span></div>' +
      '<div><button class="btn sm" data-act="ch-history" data-id="' + c.id + '">历史</button> ' +
      '<button class="btn sm" data-act="toggle-lock" data-id="' + c.id + '">' +
      (c.card.locked ? '解锁' : '锁定') + '</button> ' +
      '<button class="btn sm" data-act="edit-ch" data-id="' + c.id + '">编辑章节卡</button></div>';

    var inner = $('#editorInner');
    if (!c.blocks.length) {
      inner.innerHTML = '<div class="empty-state">这一章还没有内容。<br>左栏是章节卡，右栏可以按卡生成一份可改的草稿。<br>' +
        '<button class="btn primary" data-act="gen">按卡生成草稿</button>' +
        '<button class="btn sm" data-act="blk-add" data-id="__empty" style="margin-left:8px">自己写一段</button></div>';
    } else {
      var locked = !!c.card.locked;
      /* 长章节先渲染前 renderLimit 段：一章上百段时首屏更快，也不至于一改字就重排整章。
         滚到底部自动续上，编辑器里的内容逻辑跟"全渲染"完全一样。 */
      var limit = Math.min(c.blocks.length, state.renderLimit || 80);
      inner.innerHTML = c.blocks.slice(0, limit).map(function (b, i) {
        var isImg = b.kind === 'img' || !!b.img;
        var body = isImg
          ? '<figure class="blk-fig" data-id="' + b.id + '"><img src="' + imgSrc(b) + '" loading="lazy" alt="">' +
            '<figcaption class="fig-cap" contenteditable="plaintext-only" data-id="' + b.id + '"' +
            (b.caption ? '' : ' data-empty="1"') + '>' + esc(b.caption || '') + '</figcaption></figure>'
          : '<p class="blk" ' + (locked ? '' : 'contenteditable="plaintext-only" ') + 'spellcheck="false" data-id="' + b.id + '" data-src="' + (b.src || 'human') + '">' +
            esc(b.text) + '<i class="src" title="来源：' + (b.src === 'ai' ? 'AI 建议' : '人工') + '"></i></p>';
        return '<div class="blk-wrap' + (b.src === 'ai' ? ' from-ai' : '') + (isImg ? ' is-img' : '') + '" data-id="' + b.id + '">' +
          body +
          (locked ? '' :
            '<div class="blk-tools">' +
            '<button title="在这一段下面插一段" data-act="blk-add" data-id="' + b.id + '">＋</button>' +
            '<button title="删掉这一段" data-act="blk-del" data-id="' + b.id + '">×</button>' +
            (isImg
              ? '<button title="换一张图" data-act="blk-img" data-id="' + b.id + '">图</button>'
              : '<button title="在这一段下面插一张图" data-act="blk-img" data-id="' + b.id + '">插</button>') +
            '<button title="用 AI 改写这一段（会走三路合并）" data-act="blk-rewrite" data-id="' + b.id + '">改</button>' +
            '<button title="这一段的修改历史" data-act="blk-hist" data-id="' + b.id + '">⧉</button>' +
            '</div>') +
          '</div>';
      }).join('') + (locked ? '<div class="locked-note">本章已锁定（防手滑）。要改就先点右上角「解锁」。</div>' : '') +
        (c.blocks.length > limit
          ? '<div class="more-blks" data-act="load-more">还有 ' + (c.blocks.length - limit) + ' 段 · 点这里继续（往下滚也行）</div>'
          : '');
    }
    renderStatus();
  }

  function loadMoreBlocks() {
    var c = cur();
    if (!c) return;
    if ((state.renderLimit || 80) >= c.blocks.length) return;
    var before = $('#editor').scrollHeight;
    state.renderLimit = (state.renderLimit || 80) + 120;
    renderCenter();
    var el = $('#editor');
    if (el) el.scrollTop = el.scrollTop + (el.scrollHeight - before);
  }

  function saveLabel() {
    if (state.saveState === 'saving') return '保存中…';
    if (state.saveState === 'error') return '保存失败，数据还在内存里';
    if (state.saveState === 'saved') {
      var t = state.savedAt ? new Date(state.savedAt) : null;
      var hhmm = t ? ('0' + t.getHours()).slice(-2) + ':' + ('0' + t.getMinutes()).slice(-2) : '';
      return '已保存 ' + hhmm + (S.backend === 'sqlite' ? ' · SQLite' : ' · 本地');
    }
    return '尚未保存';
  }

  function renderStatus() {
    var c = cur();
    if (!c) return;
    var n = c.blocks.length, w = chWords(c);
    var hit = state.issues.filter(function (i) { return i.chapter === c.idx; }).length;
    $('#statusBar').innerHTML =
      '第 ' + c.idx + ' 章 <span class="dotsep">·</span> ' + (c.status === 'done' ? '已完成' : c.status === 'draft' ? '草稿' : '待写') +
      ' <span class="dotsep">·</span> ' + fmtNum(w) + ' 字 <span class="dotsep">·</span> ' + n + ' 段' +
      ' <span class="dotsep">·</span> 本章命中 ' + hit + ' 条 <span class="dotsep">·</span> ' + saveLabel();
  }

  /* ---------------- 右栏 ---------------- */

  /* ---------------- 对话（右侧栏） ---------------- */
  function chatLogHtml() {
    if (!state.chat.length) {
      return '<div class="chat-empty">在这里说你要改什么，比如<br>「把第 2 段压到两句」「这段对话太客气了，改成互相刺」。</div>';
    }
    return state.chat.map(function (m, i) {
      var edits = chatEditsOf(m.text);
      var acts = '';
      if (m.role === 'assistant' && edits.length) {
        acts = '<div class="chat-apply"><button class="btn primary sm" data-act="chat-apply" data-i="' + i + '">应用 ' +
          edits.length + ' 处修改</button></div>';
      }
      return '<div class="chat-msg ' + (m.role === 'user' ? 'me' : 'ai') + '">' +
        '<div class="chat-body">' + chatTextHtml(m.text) + '</div>' + acts + '</div>';
    }).join('');
  }

  function chatTextHtml(t) {
    var raw = String(t || '');
    /* 把 sf-edit 代码块折叠成一行提示，其余按纯文本显示 */
    raw = raw.replace(/```sf-edit[\s\S]*?```/g, '〔正文改动，见下方按钮〕');
    return esc(raw).replace(/\n/g, '<br>');
  }

  /* 从回复里取出 ```sf-edit [ {blockId, text} | {op:'insert', after, text} ] ``` */
  function chatEditsOf(text) {
    var m = /```sf-edit\s*([\s\S]*?)```/.exec(String(text || ''));
    if (!m) return [];
    var raw = m[1].trim();
    try {
      var arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      return arr.filter(function (e) {
        return e && typeof e === 'object' && (typeof e.text === 'string');
      });
    } catch (e) {
      return [];
    }
  }

  function chatContextBlock(c) {
    var card = c.card || {};
    var lines = [];
    lines.push('【项目】' + (D.project.name || '') + ' · ' + (D.project.genre || ''));
    if (D.project.logline) lines.push('【一句话】' + D.project.logline);
    if (D.project.sellPoint) lines.push('【卖点】' + D.project.sellPoint);
    var style = SEED.stylePromptLine ? SEED.stylePromptLine(D.project.style) : '';
    if (style) lines.push('【文风】' + style);
    lines.push('【本章】第 ' + c.idx + ' 章 ' + (c.title || '').replace(/^第\s*\d+\s*章\s*/, ''));
    if (card.goal) lines.push('目标：' + card.goal);
    if (card.conflict) lines.push('冲突：' + card.conflict);
    if (card.turn) lines.push('转折：' + card.turn);
    lines.push('');
    lines.push('【正文段落】（改正文时 blockId 只能取下面这些）');
    (c.blocks || []).forEach(function (b) {
      if (b.kind === 'img') return;
      lines.push('[' + b.id + '] ' + String(b.text || '').replace(/\n/g, ' '));
    });
    return lines.join('\n');
  }

  function chatSystemPrompt() {
    return [
      '你是这本小说的写作搭档。用户会告诉你哪里不满意，你要么直接回答，要么直接给出改好的正文。',
      '需要改正文时，除了简短说明，还必须单独给一个 ```sf-edit 代码块，里面是 JSON 数组：',
      '[{"blockId":"b3-1","text":"改好的整段正文"},{"op":"insert","after":"b3-1","text":"新增的一段"}]',
      '规则：blockId 必须是用户消息里【正文段落】出现过的；text 是整段替换后的完整文字，不是片段；',
      '一次最多改 4 段；不确定要不要改就别输出 sf-edit，先用一句话说明你的方案。',
      '不要输出别的东西进代码块，不要用 markdown 表格。'
    ].join('\n');
  }

  function sendChat() {
    var box = $('#chatIn');
    var text = box ? box.value.trim() : '';
    if (!text) return;
    var c = cur();
    if (!c) return;
    if (!L.configured(state.settings)) {
      toast('先在设置里填好 API Key / 或选 Gemini');
      return;
    }
    if (box) box.value = '';
    state.chat.push({ role: 'user', text: text });
    state.chat.push({ role: 'assistant', text: '' });
    state.chatBusy = true;
    state.chatRun = { id: null, text: '' };

    var history = state.chat.slice(0, -1).slice(-8).map(function (m) {
      return { role: m.role, content: m.text };
    });
    var messages = [
      { role: 'system', content: chatSystemPrompt() },
      { role: 'user', content: chatContextBlock(c) + '\n\n【我的要求】' + text }
    ].concat(history.slice(0, -1));

    renderRight();
    var run = L.chat({
      settings: state.settings,
      messages: messages,
      model: (state.settings.slots && state.settings.slots.draft) || state.settings.model,
      maxTokens: 2400,
      temperature: 0.7
    });
    state.chatRun.id = run.id;
    state.chatRun.cancel = run.cancel;
  }

  function handleChatEvent(msg) {
    var last = state.chat[state.chat.length - 1];
    if (!last || last.role !== 'assistant') return;
    if (msg.type === 'delta') {
      last.text += msg.text || '';
      var log = $('#chatLog');
      if (log) { log.innerHTML = chatLogHtml(); log.scrollTop = log.scrollHeight; }
      return;
    }
    if (msg.type === 'done' || msg.type === 'error') {
      state.chatBusy = false;
      state.chatRun = null;
      if (msg.type === 'error') {
        last.text = last.text || ('（失败：' + (msg.message || '未知错误') + '）');
        toast('对话失败：' + (msg.message || '未知错误'));
      }
      renderRight();
    }
  }

  function applyChatEdits(i) {
    var m = state.chat[i];
    var edits = chatEditsOf(m && m.text);
    if (!edits.length) return;
    var c = cur();
    if (!c) return;
    var byId = {};
    (c.blocks || []).forEach(function (b) { byId[b.id] = b; });
    var done = 0, inserted = 0, missing = 0;
    edits.forEach(function (e) {
      if (e.op === 'insert' && e.after) {
        var at = -1;
        (c.blocks || []).forEach(function (b, k) { if (b.id === e.after) at = k; });
        if (at >= 0) {
          c.blocks.splice(at + 1, 0, { id: SEED.uid('b'), text: String(e.text || ''), src: 'ai' });
          inserted += 1;
        } else { missing += 1; }
        return;
      }
      var b = byId[e.blockId];
      if (!b || b.kind === 'img') { missing += 1; return; }
      b.text = String(e.text || '');
      b.src = 'ai';
      done += 1;
    });
    if (!done && !inserted) { toast('这一版改动对不上正文（段落可能已经变过），让它重新给一版'); return; }
    m.applied = true;
    commitCur(c, { source: 'ai', rationale: '按对话改正文' });
    toast('已应用：改 ' + done + ' 段、插 ' + inserted + ' 段' + (missing ? '，' + missing + ' 处对不上已跳过' : ''));
    renderAll();
  }

  function renderRight() {
    if (!D) return;
    var c = cur();
    if (!c) return;
    var st = R.run(D, c.id);
    state.issues = st.issues;
    state.indeterminate = st.indeterminate;
    state.ruleStatus = st.ruleStatus;

    var assets = SEED.contextAssetsOf(D, c.idx);
    var tokens = assets.reduce(function (a, b) { return a + b.tokens; }, 0);
    var unchecked = D.proposedStates.filter(function (p) { return !p.checked; }).length;
    var hit = st.issues.length;
    var configured = L.configured(state.settings);
    var slotModel = (state.settings.slots && state.settings.slots.draft) || state.settings.model || '—';
    var est = estimateCost(tokens);

    var html = '';

    /* 对话：让 AI 直接帮你改正文 */
    html += block('chat', '对话', state.chatBusy ? '正在回复…' : (state.chat.length ? state.chat.length + ' 条' : '让它帮你改'), false,
      '<div class="chat-log" id="chatLog">' + chatLogHtml() + '</div>' +
      '<textarea class="chat-in" id="chatIn" rows="2" placeholder="例如：第 3 段换个写法，更冷一点，别用比喻"></textarea>' +
      '<div class="chat-acts">' +
      (state.chatBusy
        ? '<button class="btn sm" data-act="chat-stop">停止</button>'
        : '<button class="btn primary sm" data-act="chat-send">发送</button>') +
      '<button class="btn sm" data-act="chat-clear">清空</button>' +
      (configured ? '<span class="chat-hint">改正文会先在对话里给出改动，你点「应用」才写进去</span>'
        : '<button class="btn sm" data-act="settings">先配 Key</button>') +
      '</div>');

    /* 生成 */
    html += block('gen', '生成草稿',
      '按本章卡 · ' + (state.gen.running ? '生成中…' : state.gen.done ? '待采纳' : state.gen.text ? '已停止' : '未开始'), false,
      kv('模型槽位 draft', slotModel) +
      kv('接口', L.available ? '主进程代理（Electron）' : '浏览器直连') +
      kv('Key 状态', configured ? '已配置' : '未配置 · 将用示例文本') +
      kv('将注入', assets.length + ' 项 · ' + fmtNum(tokens) + ' tokens') +
      kv('预估费用', est) +
      kv('输出上限', '2,000 tokens') +
      '<div class="gen-acts" style="margin-top:9px">' +
      (state.gen.running
        ? '<button class="btn sm" data-act="stop">停止</button>'
        : '<button class="btn primary sm" data-act="gen">' + (state.gen.text ? '重新生成' : '生成本章') + '</button>' +
        '<button class="btn sm" data-act="expand">扩写选中</button>' +
        (configured ? '' : '<button class="btn sm" data-act="settings">先配 Key</button>')) +
      '</div>' +
      '<div class="gen-out' + (state.gen.running ? ' gen-cursor' : '') + '" id="genOut"' +
      (state.gen.done && !state.gen.running ? ' contenteditable="true" spellcheck="false" data-edit="1"' : '') + '>' +
      esc(state.gen.text) + '</div>' +
      (state.gen.done && !state.gen.running
        ? '<div class="gen-hint">可以直接在这段里改，改完再采纳。</div>' +
        '<div class="gen-acts"><button class="btn primary sm" data-act="accept">采纳</button>' +
        '<button class="btn sm" data-act="reject">拒绝</button></div>'
        : '') +
      (state.lastAccept && !state.gen.done && !state.gen.running
        ? '<div class="gen-acts"><button class="btn sm" data-act="undo-accept">撤销上次采纳（' +
        state.lastAccept.ids.length + ' 段）</button></div>'
        : ''));

    /* 体检 */
    html += block('issues', '体检', hit + ' 条 · 本地规则', false,
      '<div class="rules-chips">' + st.ruleStatus.map(function (r) {
        return '<span class="rchip ' + r.status + '" title="' + r.id + '">' + r.name + (r.status === 'skip' ? '（跳过）' : '') + '</span>';
      }).join('') + '</div>' +
      '<div style="display:flex;gap:6px;margin-bottom:9px">' +
      '<button class="btn sm" data-act="check">重新体检</button>' +
      '<button class="btn sm" data-act="hint-review">审查范围</button></div>' +
      (st.indeterminate.length
        ? '<div class="indeterminate"><b>' + st.indeterminate.length + ' 项无法判定</b><br>' +
        st.indeterminate.map(function (x) { return '· ' + esc(x); }).join('<br>') + '</div>'
        : '') +
      (hit ? st.issues.map(function (it, i) { return issueHtml(it, i); }).join('')
        : '<div class="indeterminate">本章没有查到确定性问题。文案类问题见风格卡。</div>'));

    /* 模型审阅：跟规则分栏。规则栏承诺准确率，这一栏只作参考。 */
    var rv = state.review;
    var rvSame = rv && rv.chapterId === c.id;
    html += block('review', '模型审阅',
      rvSame
        ? rv.items.length + ' 条 · ' + (rv.mock ? '示例（未配 Key）' : '模型 · ' + esc(rv.model))
        : (state.reviewBusy ? '审阅中…' : '未跑 · 参考栏'),
      false,
      '<div class="thint">走「审阅」槽位的模型，和写作分开跑。它说的话不保证对，只当第二双眼睛；' +
      '能算的（谁死了还说话、地点跳没跳）在上一栏的规则里，那栏才承诺准确率。</div>' +
      (rvSame && rv.items.length
        ? rv.items.map(function (it, i) {
          return '<div class="rv-item">' +
            '<div class="rv-head"><span class="rv-kind">' + esc((window.SFReview.KINDS[it.kind] || '其他')) + '</span>' +
            '<span class="sev-text ' + esc(it.severity) + '">' + esc(sevLabel(it.severity)) + '</span>' +
            '<span class="rv-conf">' + Math.round((it.confidence || 0) * 100) + '%</span></div>' +
            '<div class="rv-claim">' + esc(it.claim) + '</div>' +
            (it.quote ? '<div class="rv-quote">「' + esc(it.quote) + '」</div>' : '') +
            (it.suggestion ? '<div class="rv-sug">建议：' + esc(it.suggestion) + '</div>' : '') +
            '<div class="rv-acts"><button class="btn sm" data-act="locate" data-block="' + esc(it.blockId || '') + '">定位</button>' +
            '<button class="btn sm" data-act="review-drop" data-i="' + i + '">不认同</button></div>' +
            '</div>';
        }).join('')
        : (rvSame
          ? '<div class="indeterminate">这次审阅没提意见。（也可能是模型没按格式回答，被校验挡掉了 ' +
            (rv.dropped ? rv.dropped.length : 0) + ' 条）</div>'
          : '<div class="indeterminate">还没跑。点下面的按钮，让审阅代理读这一章，只挑"读者会绊住的地方"：' +
            '谁知道了不该知道的事、几段对白都在讲设定、伏笔回收得太急。</div>')) +
      '<div style="display:flex;gap:6px;margin-top:9px">' +
      '<button class="btn sm" data-act="review-run">' + (state.reviewBusy ? '审阅中…' : (rvSame ? '重新审阅' : '跑本章审阅')) + '</button>' +
      (rvSame && rv.dropped && rv.dropped.length
        ? '<span class="thint" style="margin:0">挡掉 ' + rv.dropped.length + ' 条（引文对不上正文）</span>' : '') +
      '</div>');

    /* 本章转变：章节卡上写了「这一章谁变了」，这里把承诺和正文对一遍；
       另外把"这一章该走到哪条线"也列出来（弧线是可选的，没有就不列） */
    var changes = (c.card && c.card.changes) || [];
    var arcRows = '';
    (D.entities || []).forEach(function (e) {
      arcThreadsOf(e).forEach(function (a, ai) {
        var due = (a.beats || []).filter(function (b) { return b.chapter === c.idx; })[0];
        var early = (a.forbidden || []).length && a.reachChapter && c.idx < a.reachChapter;
        if (!due && !early) return;
        arcRows += '<div class="arc-row"><div class="arc-t"><b>' + esc(e.name) + '</b> · ' +
          esc(a.label || ('第 ' + (ai + 1) + ' 条线')) + '</div>' +
          (due ? '<div class="arc-v">这一章该走到：<b>' + esc(due.text || '') + '</b></div>' : '') +
          (early ? '<div class="arc-s miss">还没到写「' + esc(a.forbidden.join('、')) + '」的时候（第 ' +
            a.reachChapter + ' 章之后才允许）</div>' : '') +
          '</div>';
      });
    });
    html += block('arc', '本章转变',
      changes.length ? changes.length + ' 处 · ' + (changes.every(function (x) { return changeStatus(c, x).ok; }) ? '都有着落' : '有没兑现的')
        : (arcRows ? '弧线节点 · 可选' : '没写 · 可选'), false,
      (changes.length ? changes.map(function (x) {
        var s = changeStatus(c, x);
        return '<div class="arc-row"><div class="arc-t"><b>' + esc(x.entity) + '</b>' +
          (x.field ? ' · ' + esc(x.field) : '') + '</div>' +
          '<div class="arc-v">' + esc(x.from || '？') + ' → <b>' + esc(x.to || '？') + '</b></div>' +
          '<div class="arc-s ' + (s.ok ? 'ok' : 'miss') + '">' + esc(s.why) + '</div></div>';
      }).join('')
        : (arcRows || '<div class="indeterminate">章节卡上还没写"这一章谁变了"。写了之后，这里会对照正文看这场转变有没有真的发生。</div>')) +
      '<div style="display:flex;gap:6px;margin-top:9px">' +
      '<button class="btn sm" data-act="edit-ch">编辑章节卡</button>' +
      '<button class="btn sm" data-act="timeline">人物弧线</button></div>');

    /* 待确认：每页 5 条，防确认疲劳 */
    var GATE_PAGE = 5;
    var list = D.proposedStates || [];
    var pages = Math.max(1, Math.ceil(list.length / GATE_PAGE));
    if (state.gatePage > pages - 1) state.gatePage = pages - 1;
    if (state.gatePage < 0) state.gatePage = 0;
    var page = list.slice(state.gatePage * GATE_PAGE, state.gatePage * GATE_PAGE + GATE_PAGE);
    var gateHead = !list.length ? '还没有待确认'
      : (unchecked ? unchecked + ' 项待确认' + (pages > 1 ? ' · 第 ' + (state.gatePage + 1) + '/' + pages + ' 页' : '') : '全部已确认');
    html += block('gate', '待确认状态', gateHead, true,
      (list.length ? page.map(function (p) {
        return '<div class="gate-item"><div class="gt">' +
          '<input type="checkbox" data-gate="' + p.id + '" ' + (p.checked ? 'checked' : '') + '>' +
          '<div class="gname"><b>' + esc(p.entity) + '</b> · ' + esc(p.field) + '：' +
          esc(p.from) + ' → ' + esc(p.to) +
          '<span class="conf ' + (p.conf < 0.6 ? 'low' : '') + '">' + (+p.conf).toFixed(2) + '</span>' +
          '<div class="gq" data-block="' + p.block + '" title="点击定位原文">「' + esc(p.quote) + '」</div></div>' +
          '</div></div>';
      }).join('') +
        (pages > 1 ? '<div class="gate-pager"><button class="btn sm" data-act="gate-prev"' + (state.gatePage <= 0 ? ' disabled' : '') + '>上一页</button>' +
          '<span>第 ' + (state.gatePage + 1) + ' / ' + pages + ' 页</span>' +
          '<button class="btn sm" data-act="gate-next"' + (state.gatePage >= pages - 1 ? ' disabled' : '') + '>下一页</button></div>' : '') +
        '<div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">' +
        '<button class="btn sm primary" data-act="confirm-all">全部确认（' + unchecked + '）</button>' +
        '<button class="btn sm" data-act="extract-llm" title="配了 Key 就用模型抽取，没配就退回本地规则">从本章更新状态</button>' +
        '<button class="btn sm" data-act="summarize">生成本章摘要</button>' +
        '<button class="btn sm" data-act="recheck-from">从本章重算</button></div>' +
        '<div class="thint">确认了才会进下一章的上下文。低置信度默认不勾。</div>'
        : '<div class="indeterminate">这个项目还没有待确认的状态。写完一章点「从本章更新状态」，它会只读正文、把候选状态列在这里，等你逐条确认。</div>' +
        '<div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">' +
        '<button class="btn sm primary" data-act="extract-llm">从本章更新状态</button>' +
        '<button class="btn sm" data-act="summarize">生成本章摘要</button></div>'));

    /* 上下文 */
    var dropped = assets.filter(function (a) { return state.excluded[a.name]; });
    var shown = assets.filter(function (a) { return !state.excluded[a.name]; });
    var droppedTokens = dropped.reduce(function (a, b) { return a + b.tokens; }, 0);
    html += block('ctx', '本次上下文', shown.length + ' 项 · ' + fmtNum(tokens - droppedTokens) + ' / ' + fmtNum(SEED.contextBudget), true,
      '<div class="bar"><i style="width:' + Math.min(100, Math.round((tokens - droppedTokens) / SEED.contextBudget * 100)) + '%"></i></div>' +
      shown.map(function (a) {
        return '<div class="ctx-row"><span class="n">' + esc(a.name) + '</span>' +
          '<span class="t">' + esc(a.type) + ' · ' + fmtNum(a.tokens) + 't</span>' +
          '<button class="ctx-x" data-act="ctx-drop" data-name="' + esc(a.name) + '" title="这次不带它">×</button></div>';
      }).join('') +
      (dropped.length
        ? '<div class="ctx-row dropped"><span class="n">本次排除 ' + dropped.length + ' 项（' + fmtNum(droppedTokens) + 't）</span>' +
        '<span class="t"><button class="ctx-x back" data-act="ctx-restore">恢复</button></span></div>'
        : '') +
      (unchecked ? '<div class="ctx-row"><span class="n" style="color:var(--muted)">已排除 ' + unchecked + ' 项未确认状态</span><span class="t">—</span></div>' : ''));

    $('#rightPane').innerHTML = html;
  }

  function estimateCost(tokens) {
    var s = state.settings;
    var inCost = (tokens / 1e6) * (+s.priceIn || 0);
    var outCost = (2000 / 1e6) * (+s.priceOut || 0);
    var total = inCost + outCost;
    return total <= 0 ? '¥ 0.00（本地模型）' : '¥ ' + total.toFixed(3);
  }

  function kv(k, v) {
    return '<div class="kv"><span>' + esc(k) + '</span><b class="mono">' + esc(v) + '</b></div>';
  }
  function block(key, title, meta, collapsed, body) {
    var isC = state.folds[key] != null ? state.folds[key] : collapsed;
    return '<div class="rblock ' + (isC ? 'collapsed' : '') + '" data-fold="' + key + '">' +
      '<div class="rhead" data-fold="' + key + '">' + esc(title) +
      '<span class="count">' + esc(meta) + '</span><span class="caret">▼</span></div>' +
      '<div class="rbody">' + body + '</div></div>';
  }
  function sevLabel(s) {
    return { blocker: '硬伤', major: '大概率是错', minor: '提示' }[s] || '提示';
  }

  /* 审阅代理：和写作分开跑。没配 Key 时用包里的示例审阅（只按字数/词表算），
     已配 Key 时走 review 槽位，返回的每一条都要过"引文必须是原文子串"的校验。 */
  function runReview() {
    var c = cur();
    var RV = window.SFReview;
    if (!RV) { toast('审阅模块没加载'); return; }
    if (!c || !c.blocks.length) { toast('这一章还没有正文，没东西可审'); return; }

    var chapterId = c.id;
    var slot = (state.settings.slots && state.settings.slots.review) || state.settings.model || '—';

    function land(items, dropped, mock) {
      state.reviewBusy = false;
      state.review = {
        chapterId: chapterId,
        items: items.map(function (x, i) { return Object.assign({ id: 'rv' + i }, x); }),
        dropped: dropped || [],
        mock: !!mock,
        model: slot
      };
      renderRight();
    }

    function mock(reason) {
      var r = RV.validate(c, RV.mockReview(c));
      land(r.kept, r.dropped, true);
      toast(reason || ('示例审阅：' + r.kept.length + ' 条（没配 Key，只按字数和词表算，当不了数）'));
    }

    if (!L.configured(state.settings)) { mock(); return; }

    state.reviewBusy = true;
    renderRight();
    var prev = chapters().filter(function (x) { return x.idx === c.idx - 1; })[0];
    auxCall('审阅', [
      { role: 'system', content: RV.systemPrompt({ chapter: c }) },
      { role: 'user', content: RV.userPrompt({ chapter: c, prevSummary: prev && prev.summary }) }
    ], 'review', function (text) {
      var r = RV.validate(c, RV.parse(text));
      land(r.kept, r.dropped, false);
      toast(r.kept.length ? '审阅：' + r.kept.length + ' 条参考意见' : '审阅：这一章没提出意见');
    }, function () {
      mock('审阅请求失败，先用示例审阅顶上');
    });
  }

  function issueHtml(it, i) {
    var label = { blocker: '硬伤', major: '大概率是错', minor: '提示' }[it.severity];
    var ev = (it.evidence && it.evidence[0]) || null;
    return '<div class="issue ' + it.severity + '" data-issue="' + i + '">' +
      '<div class="top"><span class="sev ' + it.severity + '">' + label + '</span>' +
      '<span class="rid">' + it.ruleId + '</span>' +
      '<span class="where">第 ' + it.chapter + ' 章</span></div>' +
      '<div class="claim">' + esc(it.claim) + '</div>' +
      (ev ? '<div class="quote" data-block="' + ev.blockId + '">「' + esc(ev.quote) + '」</div>' : '') +
      (it.suggestion ? '<div class="quote">建议：' + esc(it.suggestion) + '</div>' : '') +
      '<div class="acts"><button class="btn sm" data-act="jump" data-block="' + (ev ? ev.blockId : '') + '">定位</button>' +
      '<button class="btn sm" data-act="ignore" data-idx="' + i + '">忽略</button></div></div>';
  }

  function renderAll() {
    renderTop(); renderLeft(); renderRight(); renderCenter();
  }

  /* ---------------- 定位 / 提示 ---------------- */

  function findBlock(blockId) {
    var hit = null;
    chapters().forEach(function (c) {
      (c.blocks || []).forEach(function (b) { if (b.id === blockId) hit = b; });
    });
    return hit;
  }

  function locate(blockId) {
    if (!blockId) return;
    var target = null;
    chapters().forEach(function (c) {
      if (c.blocks.some(function (b) { return b.id === blockId; })) target = c;
    });
    if (!target) return toast('这段已被修改，证据失效');
    if (target.id !== state.chapterId) {
      state.chapterId = target.id;
      renderAll();
      setTimeout(function () { highlight(blockId); }, 40);
    } else {
      highlight(blockId);
    }
  }
  function highlight(blockId) {
    var el = $('#editorInner .blk[data-id="' + blockId + '"]');
    if (!el) return;
    var issue = state.issues.filter(function (i) { return i.evidence && i.evidence[0] && i.evidence[0].blockId === blockId; })[0];
    el.classList.add(issue && issue.severity === 'blocker' ? 'hl-red' : 'hl');
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setTimeout(function () { el.classList.remove('hl', 'hl-red'); }, 2400);
  }

  var toastTimer = null;
  function toast(msg) {
    var t = $('#toast');
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('on'); }, 2200);
  }

  /* ---------------- 持久化 ---------------- */

  var saveTimer = null;
  var SAVED_DELAY = 650; // 打字停顿再落库，避免每个字符一次事务
  var dirty = false;     // 有没有未落库的改动：只是换章/翻滚轮不该触发一次整章提交

  /* 图注编辑：写好就落库（不需要防抖太狠） */
  document.addEventListener('input', function (e) {
    var fc = e.target && e.target.closest && e.target.closest('.fig-cap');
    if (!fc) return;
    var c = cur();
    if (!c) return;
    var id2 = fc.getAttribute('data-id');
    for (var i = 0; i < c.blocks.length; i += 1) {
      if (c.blocks[i].id === id2) {
        c.blocks[i].caption = fc.textContent.trim();
        if (!c.blocks[i].caption) fc.setAttribute('data-empty', '1');
        else fc.removeAttribute('data-empty');
        break;
      }
    }
    scheduleSave();
  });

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    dirty = true;
    state.saveState = 'saving';
    renderStatus();
    saveTimer = setTimeout(function () { saveTimer = null; flushSave(); }, SAVED_DELAY);
  }
  function flushSave() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (!dirty) return;                    // 没改过就别提交（翻章、切滚轮会走到这里）
    dirty = false;
    var c = cur();
    if (c && pid) commitCur(c);
  }

  /* 把编辑器里的段落交给仓储层做版本化提交：改字=派生新 block，插入/删除=补/标记。
     提交完把新 id 写回 DOM，避免打断正在打字的光标。 */
  function commitCur(c, opts) {
    if (!c || !pid) return Promise.resolve(null);
    var blocks = c.blocks.map(function (b) {
      return { id: b.id, text: b.text, src: b.src || 'human' };
    }).filter(function (b, i, arr) {
      /* 空段不落库；但允许整章只有一个空段（用户刚开始写） */
      return String(b.text || '').trim() !== '' || arr.length === 1;
    });
    return S.commitChapter(pid, c.id, blocks, opts || { source: 'human' }).then(function (r) {
      if (!r || !r.changed) {
        if (r && r.rev) c.rev = r.rev;
        return r;
      }
      c.rev = r.rev;
      c.blocks = r.blocks.map(function (b) { return b; });
      /* 换 id 的段：把 DOM 上的 data-id 原地改掉，光标不动、不重渲染 */
      Object.keys(r.renames || {}).forEach(function (oldId) {
        var newId = r.renames[oldId];
        var wrap = document.querySelector('.blk-wrap[data-id="' + oldId + '"]');
        if (wrap) {
          wrap.setAttribute('data-id', newId);
          var p = wrap.querySelector('.blk');
          if (p) p.setAttribute('data-id', newId);
        }
      });
      S.saveChapter(pid, { id: c.id, idx: c.idx, title: c.title, status: c.status, card: c.card, rev: c.rev });
      return r;
    });
  }

  function saveCurNow() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    var c = cur();
    if (c && pid) return commitCur(c);
    return Promise.resolve();
  }
  function gateMap() {
    var m = {};
    D.proposedStates.forEach(function (p) { m[p.id] = !!p.checked; });
    return m;
  }

  /* ---------------- 生成：真 API，未配置则退回示例 ---------------- */

  var SAMPLE = {
    c3: '沈砚没有开灯。雨声从窗缝里挤进来，把阁楼填满，像是有人在楼下慢慢翻书。\n\n' +
      '账本摊在案上，第一页只有一行字：城西，张顺，七月初九。第二页是另一个名字，第三页也是。' +
      '他一直翻到最后一页，才发现最下面那行字是新写的，墨还没干透——沈砚，三日后。\n\n' +
      '他把笔放下了。这一次他没有蘸墨。'
  };

  function buildGenMessages(c) {
    var p = D.project;
    var sys = '你是中文小说写作助手。按给定的章节卡写一章中文小说草稿：只输出正文，不要标题、不要解释、不要分点。' +
      '目标 ' + (c.card.targetWords || 1500) + ' 字左右，段落之间空一行。';
    if (p.style && p.style.pov) sys += '叙述视角：' + p.style.pov + '。';
    if (p.style && p.style.tense) sys += '时态：' + p.style.tense + '。';
    var styleLine = SEED.stylePromptLine(p.style);
    if (styleLine) sys += '文风要求：' + styleLine + '。';
    if (p.style && p.style.sample) {
      sys += '\n下面这段是作者提供的样本，只模仿它的语气和句子节奏，不要复述它的人物和情节：\n' +
        String(p.style.sample).slice(0, 1200);
    }

    var lines = [];
    lines.push('【项目】' + [p.name, p.genre, p.logline, p.sellPoint].filter(Boolean).join('｜'));
    if (p.desire) lines.push('【主角想要】' + p.desire);
    var cl = SEED.conflictNames(p);
    if (cl.length) lines.push('【阻力清单】' + cl.join('、') + (p.conflictLead ? '；最要命的是：' + p.conflictLead : ''));

    var cast = (c.card.cast || []).map(function (name) {
      return D.entities.filter(function (e) { return e.name === name; })[0];
    }).filter(Boolean);
    if (cast.length) {
      lines.push('【本章出场】');
      cast.forEach(function (e) {
        lines.push('- ' + e.name + '（' + e.kind + '）：' +
          [e.role, e.desire && ('想要' + e.desire), e.wound && ('怕' + e.wound), e.secret && ('藏着' + e.secret)]
            .filter(Boolean).join('；'));
      });

      /* 人物此刻：只给"这一章的他"，不给全书的他 —— 否则模型会按最终形态写。
         弧线 + 当前状态 + 禁忌区，三段缺一不可。 */
      lines.push('【人物此刻（不是全书最终形态）】');
      cast.forEach(function (e) {
        var now = (D.confirmedStates || []).filter(function (s) { return s.entity === e.name; })
          .sort(function (a, b) { return a.chapter - b.chapter; });
        var latest = {};
        now.forEach(function (s) { if (s.chapter <= c.idx) latest[s.field] = s; });
        var bits = Object.keys(latest).map(function (k) {
          return k + '=' + latest[k].value + '（第 ' + latest[k].chapter + ' 章起）';
        });
        lines.push('- ' + e.name + '：' + (bits.length ? bits.join('；') : '还没有可确认的状态'));
        arcThreadsOf(e).forEach(function (arc, ai) {
          if (!(arc.from || arc.to || (arc.beats || []).length)) return;
          var beats = (arc.beats || []).filter(function (b) { return b.chapter <= c.idx; });
          var future = (arc.beats || []).filter(function (b) { return b.chapter > c.idx; });
          lines.push('  · ' + (arc.label ? '「' + arc.label + '」' : '第 ' + (ai + 1) + ' 条线') +
            '：从「' + (arc.from || '?') + '」走向「' + (arc.to || '?') + '」' +
            (beats.length ? '；已经走过：' + beats.map(function (b) { return '第' + b.chapter + '章' + (b.text || ''); }).join('，') : ''));
          if (future.length) {
            lines.push('  · 还没到：' + future.map(function (b) { return '第' + b.chapter + '章（' + (b.text || '') + '）'; }).join('，') +
              '——这一章不要提前写成那样');
          }
          if ((arc.forbidden || []).length) {
            lines.push('  · 禁忌：这一章不要出现 ' + arc.forbidden.join('、') +
              (arc.reachChapter ? '（到第 ' + arc.reachChapter + ' 章之后才允许）' : ''));
          }
        });
      });
    }

    /* 本章转变：作者自己写的"这一章谁变了"，是这一章最该写出来的东西 */
    var changes = (c.card && c.card.changes) || [];
    if (changes.length) {
      lines.push('【本章要发生的转变】');
      changes.forEach(function (x) {
        lines.push('- ' + x.entity + (x.field ? '·' + x.field : '') + '：' + (x.from || '？') + ' → ' + (x.to || '？') +
          '（必须写出来，不能只靠旁白交代）');
      });
    }
    if (D.worldRules.length) {
      lines.push('【设定】');
      D.worldRules.slice(0, 6).forEach(function (w) { lines.push('- ' + w.name + '：' + w.text); });
    }
    var prev = chapters().filter(function (x) { return x.idx < c.idx; }).slice(-3);
    if (prev.length) {
      lines.push('【前情】');
      prev.forEach(function (x) {
        var tail = x.blocks.length ? x.blocks[x.blocks.length - 1].text.slice(0, 120) : '（未写）';
        lines.push('- 第 ' + x.idx + ' 章 ' + x.title + '：' +
          (x.summary ? x.summary : (x.card.goal || '') + '｜结尾：' + tail));
      });
    }
    var due = D.foreshadows.filter(function (f) {
      return f.status !== 'resolved' && f.status !== 'abandoned' && f.due && f.due <= c.idx;
    });
    if (due.length) lines.push('【本章应收的伏笔】' + due.map(function (f) { return f.title; }).join('、'));

    lines.push('');
    lines.push('【本章卡 · 第 ' + c.idx + ' 章 ' + c.title + '】');
    lines.push('目标：' + (c.card.goal || '—'));
    lines.push('冲突：' + (c.card.conflict || '—'));
    lines.push('转折：' + (c.card.turn || '—'));
    if (c.card.pov) lines.push('视角：' + c.card.pov);
    if (c.card.plant) lines.push('需埋伏笔：' + c.card.plant);
    if (c.card.payoff) lines.push('需回收伏笔：' + c.card.payoff);
    lines.push('');
    lines.push('只输出这一章的正文。');

    return [
      { role: 'system', content: sys },
      { role: 'user', content: lines.join('\n') }
    ];
  }

  function startGen() {
    if (state.gen.running || !cur()) return;
    var c = cur();
    var s = state.settings;
    state.gen = { running: true, text: '', done: false, runId: null, usedApi: false, timer: null };
    renderRight();

    if (!L.configured(s)) {
      mockGen(c);
      return;
    }

    state.gen.usedApi = true;
    try {
      var run = L.chat({
        settings: s,
        model: (s.slots && s.slots.draft) || s.model,
        messages: buildGenMessages(c),
        maxTokens: 2000,
        temperature: 0.9
      });
      state.gen.runId = run.id;
    } catch (e) {
      state.gen.running = false;
      state.gen.done = false;
      state.gen.text = '';
      renderRight();
      toast('发起失败：' + (e && e.message || e));
    }
  }

  function onLlmEvent(msg) {
    if (state.chatRun && state.chatRun.id && msg.runId === state.chatRun.id) {
      handleChatEvent(msg);
      return;
    }
    if (!msg) return;
    /* 抽取 / 摘要这类一次性任务：只收文本，不碰生成面板 */
    var aux = state.auxRun && state.auxRun[msg.runId];
    if (aux) {
      if (msg.type === 'delta') { aux.text += msg.text || ''; return; }
      if (msg.type === 'done' || msg.type === 'error') {
        delete state.auxRun[msg.runId];
        auxRunning = Math.max(0, auxRunning - 1);
        if (msg.type === 'error') {
          toast(aux.label + '失败：' + (msg.message || '未知错误'));
          if (aux.fallback) aux.fallback();
          pumpAux();
          return;
        }
        aux.onDone((aux.text || '').trim());
        pumpAux();
      }
      return;
    }
    if (!state.gen.runId || msg.runId !== state.gen.runId) return;
    if (msg.type === 'delta') {
      state.gen.text += msg.text || '';
      var out = $('#genOut');
      if (out) { out.textContent = state.gen.text; out.scrollTop = out.scrollHeight; }
      var headCount = $('.rblock[data-fold="gen"] .count');
      if (headCount) headCount.textContent = '按本章卡 · 生成中 ' + state.gen.text.length + ' 字';
      return;
    }
    if (msg.type === 'done') {
      state.gen.running = false;
      state.gen.done = !!state.gen.text;
      state.gen.runId = null;
      renderRight();
      toast(state.gen.text ? '生成完成，已作为建议稿待采纳' : '模型没有返回内容');
      return;
    }
    if (msg.type === 'error') {
      state.gen.running = false;
      state.gen.done = !!state.gen.text;
      state.gen.runId = null;
      state.gen.text = state.gen.text || (msg.partial || '');
      renderRight();
      toast('生成失败：' + (msg.message || '未知错误'));
    }
  }

  /* 没配 Key 时的示例草稿：用章节卡字段拼几段像正文的话，
     目的是让「生成 → 待采纳 → 写进正文 → 体检」这条链路能走通，不是假装模型在工作。 */
  function mockGen(c) {
    var card = c.card || {};
    var pov = card.pov || '他';
    var cast = (card.cast || []).filter(Boolean);
    var other = cast.filter(function (x) { return x !== pov; })[0];
    var tone = (D.project.style && D.project.style.tone) || '';
    var paras = [
      pov + '推门的时候，雨正从屋檐上连成一条线。' + (tone ? '空气里有股' + tone + '的味道。' : '') +
        (other ? other + '已经在里面了，背对着他。' : '屋里没有人，只有灯还亮着。'),
      card.conflict
        ? card.conflict + '。这件事他绕不过去，可一旦开口，就再也退不回现在这个位置。'
        : '他知道自己该说点什么，话到嘴边又咽了回去。',
      card.turn
        ? card.turn + '。'
        : '有些东西在他没注意的时候，已经换了位置。',
      (card.payoff || card.plant)
        ? '他在心里把「' + (card.payoff || card.plant) + '」念了一遍，然后把灯关了。'
        : '他把灯关了。'
    ];
    var text = SAMPLE[c.id] || paras.join('\n\n');
    var i = 0;
    state.gen.timer = setInterval(function () {
      i += Math.max(1, Math.round(Math.random() * 3));
      state.gen.text = text.slice(0, i);
      var out = $('#genOut');
      if (out) { out.textContent = state.gen.text; out.scrollTop = out.scrollHeight; }
      var headCount = $('.rblock[data-fold="gen"] .count');
      if (headCount) headCount.textContent = '按本章卡 · 生成中 ' + i + ' 字';
      if (i >= text.length) {
        clearInterval(state.gen.timer);
        state.gen.running = false;
        state.gen.done = true;
        renderRight();
        toast('生成完成（示例文本 · 未配 Key），已作为建议稿待采纳');
      }
    }, 45);
  }

  function stopGen() {
    if (state.gen.runId && L.cancel) L.cancel(state.gen.runId);
    if (state.gen.timer) clearInterval(state.gen.timer);
    state.gen.running = false;
    state.gen.done = !!state.gen.text;
    renderRight();
    toast('已停止，收到 ' + state.gen.text.length + ' 字已存为建议稿');
  }

  function acceptGen() {
    var c = cur();
    if (!c) return;
    /* 采纳的是「右栏里现在这段文字」——用户可以直接改，改完再采纳 */
    var box = $('#genOut');
    var text = (box && box.getAttribute('data-edit')) ? (box.innerText || '') : state.gen.text;
    text = (text || '').replace(/\u00a0/g, ' ').trim();
    if (!text) { toast('这段是空的，没东西可采纳'); return; }
    var paras = text.split(/\n{2,}/).map(function (t) { return t.trim(); }).filter(Boolean);
    if (!paras.length) { toast('这段是空的，没东西可采纳'); return; }

    /* 先给出「采纳后会变成什么样」的逐段 diff，点「应用」才落库 */
    var planned = c.blocks.map(function (b) { return { id: b.id, text: b.text, src: b.src }; })
      .concat(paras.map(function (t) { return { id: '__new_' + SEED.uid('g'), text: t, src: 'ai' }; }));
    var diff = (window.SFBlocks && window.SFBlocks.diffBlocks)
      ? window.SFBlocks.diffBlocks(c.blocks, planned) : [];

    var rows = diff.map(function (d) {
      if (d.type === 'same') return '<div class="dline same">' + esc(String(d.text || '').slice(0, 90)) + '</div>';
      if (d.type === 'add') return '<div class="dline add">＋ ' + esc(String(d.text || '').slice(0, 400)) + '</div>';
      if (d.type === 'del') return '<div class="dline del">－ ' + esc(String(d.text || '').slice(0, 200)) + '</div>';
      return '<div class="dline chg">～ ' + esc(String(d.before || '').slice(0, 80)) + '<br>　 ' + esc(String(d.after || '').slice(0, 300)) + '</div>';
    }).join('');

    openModalTitled(
      '<div class="diff-box">' + rows + '</div>' +
      '<div class="form-acts"><button class="btn" data-act="close-modal">取消</button>' +
      '<button class="btn primary" data-act="apply-gen">应用 ' + paras.length + ' 段</button></div>',
      '采纳这份草稿',
      '下面标 ＋ 的是要加进正文的段落。应用后是一次可回滚的版本提交，不会动你已有的段落。',
      true);
  }

  /* 真正落库：把新段落追加进 blocks，再做一次版本化提交 */
  function applyGen() {
    var c = cur();
    if (!c) return;
    var box = $('#genOut');
    var text = (box && box.getAttribute('data-edit')) ? (box.innerText || '') : state.gen.text;
    text = (text || '').replace(/\u00a0/g, ' ').trim();
    var paras = text.split(/\n{2,}/).map(function (t) { return t.trim(); }).filter(Boolean);
    closeModal();
    if (!paras.length) return;
    var prevStatus = c.status;
    var ids = paras.map(function (t) {
      var id = SEED.uid('b');
      c.blocks.push({ id: id, text: t, src: 'ai' });
      return id;
    });
    if (c.status === 'planned') c.status = 'draft';
    var last = { chapterId: c.id, ids: ids, prevStatus: prevStatus, rev: c.rev || 1, at: Date.now() };
    state.gen = { running: false, text: '', done: false, runId: null, usedApi: false, timer: null };
    commitCur(c, { source: 'ai', rationale: '采纳生成的草稿' }).then(function (r) {
      last.ids = ids.map(function (id) { return (r && r.renames && r.renames[id]) || id; });
      last.afterRev = (r && r.rev) || null;
      state.lastAccept = last;
      S.setKv(pid, 'lastAccept', JSON.stringify(last));
      renderAll();
      toast('已写入 ' + paras.length + ' 段 · 第 ' + ((r && r.rev) || '?') + ' 版');
    });
  }

  /* 撤销 = 回滚到采纳之前那一版（不是"删掉刚插入的 block"） */
  function undoAccept() {
    var last = state.lastAccept;
    if (!last) { toast('没有可撤销的采纳'); return; }
    var c = chapters().filter(function (x) { return x.id === last.chapterId; })[0];
    if (!c) { state.lastAccept = null; renderAll(); return; }
    var target = last.rev || 1;
    S.rollbackChapter(pid, c.id, target).then(function (r) {
      if (!r) { toast('找不到第 ' + target + ' 版'); return; }
      c.rev = target;
      c.blocks = r.blocks;
      if (last.prevStatus) c.status = last.prevStatus;
      state.lastAccept = null;
      S.setKv(pid, 'lastAccept', '');
      renderAll();
      toast('已回滚到第 ' + target + ' 版');
    });
  }

  /* ---------------- 正文段落：插入 / 删除 / 历史 ---------------- */

  function imgSrc(b) {
    var p = b.img || '';
    if (!p) return '';
    if (/^(data:|https?:|file:)/i.test(p)) return p.replace(/"/g, '%22');
    return 'file:///' + String(p).replace(/\\/g, '/').replace(/#/g, '%23');
  }

  /* 选一张图，插到 id 这一段后面；桌面版把图存进工作区，只记路径 */
  function pickImage(id) {
    var inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*';
    inp.onchange = function () {
      var f = inp.files && inp.files[0];
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () {
        var dataUrl = String(reader.result || '');
        var put = function (src) {
          var c = cur();
          if (!c) return;
          var nb = { id: 'b_' + Date.now().toString(36) + Math.floor(Math.random() * 900 + 100), kind: 'img', text: '', src: 'human', img: src };
          var i = -1;
          for (var k = 0; k < c.blocks.length; k += 1) if (c.blocks[k].id === id) { i = k; break; }
          if (i >= 0 && c.blocks[i].kind === 'img') c.blocks[i] = nb;
          else if (i < 0) c.blocks.push(nb);
          else c.blocks.splice(i + 1, 0, nb);
          renderCenter();
          scheduleSave();
          toast('已插入一张图');
        };
        if (window.sfBridge && window.sfBridge.library) {
          window.sfBridge.library.invoke('asset-save', { name: f.name, dataUrl: dataUrl })
            .then(function (r) { put((r && r.path) || dataUrl); })
            .catch(function () { put(dataUrl); });
        } else {
          put(dataUrl);
        }
      };
      reader.readAsDataURL(f);
    };
    inp.click();
  }

  function addBlockAfter(id) {
    var c = cur();
    if (!c) return;
    var at = c.blocks.length;
    if (id && id !== '__empty') {
      for (var i = 0; i < c.blocks.length; i++) {
        if (c.blocks[i].id === id) { at = i + 1; break; }
      }
    } else if (id === '__empty') {
      at = 0;
    }
    var nb = { id: SEED.uid('b'), text: '', src: 'human' };
    c.blocks.splice(at, 0, nb);
    if (c.status === 'planned') c.status = 'draft';
    renderCenter();
    var el = document.querySelector('.blk[data-id="' + nb.id + '"]');
    if (el) {
      el.focus();
      var r = document.createRange();
      r.selectNodeContents(el);
      r.collapse(true);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      toast('在这里写你想写的；空段落不会被保存');
    }
  }

  function armDelete(id, on) {
    var b = document.querySelector('.blk-wrap[data-id="' + id + '"] [data-act="blk-del"]');
    if (!b) return;
    if (on) b.classList.add('armed'); else b.classList.remove('armed');
  }

  /* ---------------- Enter 拆块 ---------------- */

  /* 光标在段落文本里的偏移量（contenteditable 里没法直接拿 offset，得拼一个前置 range） */
  function caretOffsetIn(el) {
    var sel = window.getSelection();
    var all = (el.innerText || '').length;
    if (!sel || !sel.rangeCount) return all;
    var r = sel.getRangeAt(0);
    if (!el.contains(r.startContainer)) return all;
    var pre = document.createRange();
    pre.selectNodeContents(el);
    try { pre.setEnd(r.startContainer, r.startOffset); } catch (e) { return all; }
    return pre.toString().length;
  }

  /* 在光标处把一段拆成两段：前段留原位，后段是新 block（空后段也保留，方便接着写） */
  function splitBlockAt(id, off) {
    var c = cur();
    if (!c) return;
    var i = -1;
    for (var k = 0; k < c.blocks.length; k++) if (c.blocks[k].id === id) i = k;
    if (i < 0) return;
    var b = c.blocks[i];
    var text = b.text || '';
    if (off == null || off < 0 || off > text.length) off = text.length;
    var before = text.slice(0, off).replace(/\s+$/, '');
    var after = text.slice(off).replace(/^\s+/, '');
    b.text = before;
    var nb = { id: SEED.uid('b'), text: after, src: 'human' };
    c.blocks.splice(i + 1, 0, nb);
    if (c.status === 'planned') c.status = 'draft';
    var box = $('#editor');
    var sc = box ? box.scrollTop : 0;
    renderCenter();
    if (box) box.scrollTop = sc;
    var el = document.querySelector('.blk[data-id="' + nb.id + '"]');
    if (el) {
      el.focus();
      var r2 = document.createRange();
      r2.selectNodeContents(el);
      r2.collapse(true);
      var s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r2);
    }
    scheduleSave();
  }

  /* ---------------- AI 改写一段：走三路合并 ---------------- */

  function mockRewrite(text) {
    /* 没配 Key 时的示例改写：只做几处保守替换，让"我的 / AI / 都要"三种选择能真的看见差别 */
    var t = (text || '')
      .replace(/仿佛/g, '像是')
      .replace(/不禁/g, '')
      .replace(/忽然/g, '突然')
      .replace(/似乎/g, '大概');
    if (t.length < 24) t += '他没有马上走。';
    else if (!/[。！？]$/.test(t)) t += '。';
    return t;
  }

  function startRewrite(id) {
    var c = cur();
    if (!c) return;
    var b = findBlock(id);
    if (!b) return;
    if (!(b.text || '').trim()) { toast('这一段还是空的，先写点东西'); return; }
    if (!L.configured(state.settings)) {
      openMerge(id, b.text, mockRewrite(b.text));
      return;
    }
    var card = c.card || {};
    var st = D.project && D.project.style;
    var sys = '你是中文小说编辑。只输出改写后的这一段正文，不分段、不加解释、不加标题、不用列表。' +
      '保留原意与人称；把解释性的形容词压掉，动作写实一点。' +
      (st && st.tone ? '情绪基调：' + st.tone + '。' : '') +
      (st && st.banned && st.banned.length ? '不要用这些词：' + st.banned.join('、') + '。' : '');
    var user = '原文：\n' + b.text + '\n\n本章目标：' + (card.goal || '—') + '\n本章冲突：' + (card.conflict || '—');
    toast('正在改写这一段…');
    auxCall('改写', [{ role: 'system', content: sys }, { role: 'user', content: user }], 'draft', function (text) {
      var t = (text || '').trim();
      if (!t) { toast('模型没有返回内容，正文未改动'); return; }
      openMerge(id, b.text, t);
    });
  }

  /* 打开三路合并面板：base=改写前的原文，ours=现在的正文，theirs=AI 的版本 */
  function openMerge(blockId, base, theirs) {
    var b = findBlock(blockId);
    if (!b) { toast('这一段已经不在了（可能刚被合并或回滚）'); return; }
    var ours = b.text || '';
    var segs = (window.SFBlocks && window.SFBlocks.merge3Detailed)
      ? window.SFBlocks.merge3Detailed(base, ours, theirs).segments
      : [{ type: 'theirs', text: theirs }];
    var picks = {};
    segs.forEach(function (s, i) {
      if (s.type === 'conflict') picks[i] = 'ours';   // 冲突默认保留我的，最坏情况是不采纳，不会丢字
    });
    state.merge = { blockId: blockId, base: base, ours: ours, theirs: theirs, segs: segs, picks: picks };
    renderMerge();
  }

  function mergeSegsHtml() {
    var m = state.merge;
    if (!m) return '';
    return m.segs.map(function (s, i) {
      if (s.type === 'same') return '<div class="mline">' + esc(s.text) + '</div>';
      if (s.type === 'ours') return '<div class="mline ok">我改的：' + esc(s.text) + '</div>';
      if (s.type === 'theirs') return '<div class="mline ok">AI 改的：' + esc(s.text) + '</div>';
      if (s.type === 'del') return '<div class="mline gone"><s>' + esc(s.text) + '</s></div>';
      var pick = m.picks[i] || 'ours';
      return '<div class="mline conf"><b>这句两边都动了，选一个：</b>' +
        '<div class="opt"><b>我的</b>' + esc(s.ours || '（删掉）') + '</div>' +
        '<div class="opt"><b>AI</b>' + esc(s.theirs || '（删掉）') + '</div>' +
        '<div class="pick">' +
        '<button class="btn sm' + (pick === 'ours' ? ' on' : '') + '" data-act="merge-pick" data-i="' + i + '" data-opt="ours">保留我的</button>' +
        '<button class="btn sm' + (pick === 'theirs' ? ' on' : '') + '" data-act="merge-pick" data-i="' + i + '" data-opt="theirs">用 AI 的</button>' +
        '<button class="btn sm' + (pick === 'both' ? ' on' : '') + '" data-act="merge-pick" data-i="' + i + '" data-opt="both">两句都留</button>' +
        '</div></div>';
    }).join('');
  }

  function mergeResultText() {
    var m = state.merge;
    if (!m) return '';
    var out = [];
    m.segs.forEach(function (s, i) {
      if (s.type === 'same' || s.type === 'ours' || s.type === 'theirs') { out.push(s.text); return; }
      if (s.type === 'del') return;
      var pick = m.picks[i] || 'ours';
      if (pick === 'ours') { if (s.ours) out.push(s.ours); }
      else if (pick === 'theirs') { if (s.theirs) out.push(s.theirs); }
      else { if (s.ours) out.push(s.ours); if (s.theirs) out.push(s.theirs); }
    });
    return out.join('');
  }

  function renderMerge() {
    var m = state.merge;
    if (!m) return;
    var conflicts = m.segs.filter(function (s) { return s.type === 'conflict'; }).length;
    var changed = m.segs.filter(function (s) { return s.type !== 'same'; }).length;
    openModalTitled(
      '<div class="merge-box">' + mergeSegsHtml() + '</div>' +
      '<div class="hint" style="margin-top:8px">' +
      (conflicts
        ? '有 <b>' + conflicts + '</b> 处两边都改过，逐条选过再应用。'
        : '没有冲突：' + (changed ? '按 AI 的版本替换这一段。' : '两边一样，应用也不会有变化。')) +
      '　应用后是一次可回滚的版本提交。</div>' +
      '<div class="form-acts"><button class="btn" data-act="close-modal">取消</button>' +
      '<button class="btn primary" data-act="merge-apply">应用到这一段</button></div>',
      '合并改动 · 三路',
      '左边是我改写前的原文，中间是这一版 AI 的改写，右边（下面）是你现在的正文。只改这一段的字，不动别的段。',
      true);
  }

  function pickMerge(i, opt) {
    if (!state.merge) return;
    state.merge.picks[i] = opt;
    renderMerge();
  }

  function applyMerge() {
    var m = state.merge;
    if (!m) return;
    var c = cur();
    if (!c) return;
    var b = findBlock(m.blockId);
    if (!b) { closeModal(); toast('这一段已经不在了'); return; }
    var text = mergeResultText().replace(/[ \t]+$/gm, '').trim();
    closeModal();
    state.merge = null;
    if (!text || text === b.text) { toast('合并结果和现在一样，正文未改动'); return; }
    b.text = text;
    b.src = 'ai';
    commitCur(c, { source: 'ai', rationale: '三路合并 AI 改写' }).then(function (r) {
      renderCenter();
      toast('已合并 · 第 ' + ((r && r.rev) || '?') + ' 版（可在章节历史里回滚）');
    });
  }

  function delBlock(id) {
    var c = cur();
    if (!c) return;
    var idx = -1;
    for (var i = 0; i < c.blocks.length; i++) if (c.blocks[i].id === id) idx = i;
    if (idx < 0) return;
    var removed = c.blocks[idx];
    if ((removed.text || '').trim() && state.confirmDel !== id) {
      state.confirmDel = id;
      armDelete(id, true);
      toast('再点一次就删这一段（删了也能从历史里回滚）');
      setTimeout(function () {
        if (state.confirmDel === id) {
          state.confirmDel = null;
          armDelete(id, false);
        }
      }, 6000);
      return;
    }
    state.confirmDel = null;
    c.blocks.splice(idx, 1);
    renderCenter();
    commitCur(c, { source: 'human', rationale: '删除一段' }).then(function () { renderStatus(); });
  }

  function openBlockHistory(id) {
    var c = cur();
    var b = c.blocks.filter(function (x) { return x.id === id; })[0];
    Promise.resolve(S.blockLineage(pid, id)).then(function (list) {
      var body = (list && list.length)
        ? list.map(function (v) {
          return '<div class="hist-item' + (v.current ? ' cur' : '') + '">' +
            '<div class="hist-meta">' + (v.rev ? '第 ' + v.rev + ' 版 · ' : '') +
            (v.at ? new Date(v.at).toLocaleString('zh-CN') : '') + (v.current ? ' · 当前' : '') + '</div>' +
            '<div class="hist-text">' + esc(v.text || '（空）') + '</div></div>';
        }).join('')
        : '<div class="indeterminate">这一段还没改过。' +
          (b ? '当前内容：' + esc((b.text || '').slice(0, 80)) : '') + '</div>';
      openModalTitled(body +
        '<div class="form-acts"><button class="btn" data-act="close-modal">关闭</button></div>',
        '这一段的修改历史',
        '每次改字都是一个新 block，旧版本不会被覆盖。', true);
    });
  }

  function openChapterHistory() {
    var c = cur();
    if (!c) return;
    Promise.all([S.listRevisions(pid, c.id), S.listPatches(pid, c.id)]).then(function (res) {
      var revs = res[0] || [], patches = res[1] || [];
      var revHtml = revs.map(function (r) {
        return '<div class="hist-item' + (r.rev === (c.rev || 1) ? ' cur' : '') + '">' +
          '<div class="hist-meta">第 ' + r.rev + ' 版 · ' + r.blocks + ' 段 · ' + fmtNum(r.words) + ' 字 · ' +
          (r.at ? new Date(r.at).toLocaleString('zh-CN') : '') + '</div>' +
          (r.rev === (c.rev || 1) ? '<div class="hist-meta">当前这一版</div>'
            : '<div class="hist-acts"><button class="btn sm" data-act="rollback" data-rev="' + r.rev + '">回滚到这一版</button></div>') +
          '</div>';
      }).join('');
      var patchHtml = patches.length ? patches.map(function (p) {
        return '<div class="hist-item"><div class="hist-meta">' +
          (p.source === 'ai' ? 'AI' : '人工') + ' · ' + (p.op || '') +
          (p.baseRev ? ' · 第 ' + p.baseRev + '→' + p.appliedRev + ' 版' : '') +
          (p.at ? ' · ' + new Date(p.at).toLocaleString('zh-CN') : '') + '</div>' +
          '<div class="hist-text">' + esc(String(p.after || p.before || '').slice(0, 160)) + '</div></div>';
      }).join('') : '<div class="indeterminate">还没有补丁记录。</div>';
      openModalTitled(
        '<div class="hist-sub">版本</div><div class="hist-list">' + revHtml + '</div>' +
        '<div class="hist-sub">最近的补丁</div><div class="hist-list">' + patchHtml + '</div>' +
        '<div class="form-acts"><button class="btn" data-act="close-modal">关闭</button></div>',
        '本章版本历史',
        '回滚只改「这一章当前用第几版」，不删任何段落。', true);
    });
  }

  function rollbackTo(rev) {
    var c = cur();
    if (!c) return;
    S.rollbackChapter(pid, c.id, rev).then(function (r) {
      if (!r) { toast('回滚失败'); return; }
      c.rev = rev;
      c.blocks = r.blocks;
      closeModal();
      renderAll();
      toast('已回滚到第 ' + rev + ' 版');
    });
  }

  /* ---------------- 状态抽取（本地规则版，v0.1 不连模型） ----------------
     只读正文，只产出候选；写进 proposedStates，等用户逐条确认。
     规则故意保守：宁可漏，不可乱，每条都带 block + 整句证据。 */
  function sentencesOf(text) {
    return (text || '').split(/(?<=[。！？…」』])|\n+/).map(function (s) { return s.trim(); }).filter(Boolean);
  }

  function extractStatesLocal() {
    var c = cur();
    if (!c || !c.blocks.length) { toast('这一章还没有正文，没东西可抽'); return; }
    var names = (D.entities || []).map(function (e) { return e.name; }).filter(Boolean);
    if (!names.length) { toast('先去「角色」建几张角色卡，抽取需要认得名字'); return; }
    var places = (D.worldRules || []).filter(function (w) { return w.kind === '地点'; }).map(function (w) { return w.name; });
    var placesFromEntities = (D.entities || []).filter(function (e) { return e.kind === '地点'; }).map(function (e) { return e.name; });
    places = places.concat(placesFromEntities);
    var found = [];
    var seen = {};

    function push(o) {
      var key = o.entity + '|' + o.field + '|' + o.to;
      if (seen[key]) return;
      seen[key] = 1;
      o.id = SEED.uid('ps');
      o.chapter = c.idx;
      o.checked = false;
      found.push(o);
    }

    c.blocks.forEach(function (b) {
      var blockNames = names.filter(function (nm) { return (b.text || '').indexOf(nm) >= 0; });
      sentencesOf(b.text).forEach(function (sen) {
        /* 死亡：名字紧跟着"死"才算；带"有人说/听说"这类传闻词的一律不碰 */
        if (/(死了|去世|没了|没的|不在了|断气|下葬|遗体)/.test(sen)) {
          var deadPat = new RegExp('(' + names.join('|') + ')[^，。！？]{0,4}(死了|去世|没了|没的|不在了|断气)');
          var dm = sen.match(deadPat);
          if (dm) {
            push({ entity: dm[1], field: '生死', from: '活', to: '已故', block: b.id, quote: sen, conf: 0.62 });
          } else if (!/(有人说|听说|据说|好像|似乎|传言|疑似|传闻)/.test(sen) && blockNames.length === 1) {
            push({ entity: blockNames[0], field: '生死', from: '活', to: '已故', block: b.id, quote: sen, conf: 0.5 });
          }
        }
        names.forEach(function (nm) {
          if (sen.indexOf(nm) < 0) return;
          /* 移动 */
          var mv = sen.match(/(?:去|到|回到|走进|离开|进城)([^，。！？]{2,8})/);
          if (mv && places.some(function (p) { return mv[1].indexOf(p) >= 0 || p.indexOf(mv[1]) >= 0; })) {
            var hitPlace = places.filter(function (p) { return mv[1].indexOf(p) >= 0 || p.indexOf(mv[1]) >= 0; })[0];
            push({ entity: nm, field: '位置', from: '—', to: hitPlace, block: b.id, quote: sen, conf: 0.55 });
          }
          /* 得知信息 */
          if (/(知道|得知|听说|发现|明白|意识到)/.test(sen)) {
            push({ entity: nm, field: '已知信息', from: '—', to: sen.slice(0, 18), block: b.id, quote: sen, conf: 0.5 });
          }
        });
      });
    });

    if (!found.length) {
      toast('这一章没抽到新的状态。规则偏保守，漏掉是正常的');
      return;
    }
    var exist = {};
    (D.proposedStates || []).forEach(function (p) { exist[p.entity + '|' + p.field + '|' + p.to] = 1; });
    var fresh = found.filter(function (p) { return !exist[p.entity + '|' + p.field + '|' + p.to]; });
    if (!fresh.length) { toast('抽到的 ' + found.length + ' 条都已经在待确认里了'); return; }
    D.proposedStates = (D.proposedStates || []).concat(fresh);
    state.gatePage = 0;
    S.saveStates(pid, D.proposedStates).then(function () {
      renderAll();
      toast('抽到 ' + fresh.length + ' 条候选状态，逐条确认后才会进上下文');
    }).catch(function (e) { toast('保存失败：' + (e && e.message || e)); });
  }

  /* 从本章重算：只重跑规则引擎（不碰正文、不碰已确认状态） */
  function recheckFrom() {
    var c = cur();
    if (!c) return;
    var st = R.run(D, state.chapterId);
    state.issues = st.issues;
    state.indeterminate = st.indeterminate;
    state.ruleStatus = st.ruleStatus;
    renderAll();
    var n = st.issues.filter(function (i) { return i.chapter >= c.idx; }).length;
    toast('从第 ' + c.idx + ' 章重算：之后共 ' + n + ' 条');
  }

  /* ---------------- 一次性模型任务（抽取 / 摘要） ----------------
     与写正文共用同一条事件流，用 auxRun 按 runId 分流：
     配了 Key 走模型，没配（或报错）回退本地规则，保证按钮永远有反馈。 */

  /* 一次性任务（抽取 / 摘要）走这里：最多 2 个并发，多了排队。
     并发上限不是洁癖：一边抽取一边生成摘要时，三个请求同时打会让便宜模型直接 429。 */
  var auxQ = [], auxRunning = 0;

  function auxCall(label, messages, slot, onDone, fallback) {
    auxQ.push({ label: label, messages: messages, slot: slot, onDone: onDone, fallback: fallback });
    pumpAux();
  }

  function pumpAux() {
    while (auxRunning < 2 && auxQ.length) {
      var j = auxQ.shift();
      if (!L.configured(state.settings)) { if (j.fallback) j.fallback(); continue; }
      var run;
      try {
        run = L.chat({
          settings: state.settings,
          model: (state.settings.slots && state.settings.slots[j.slot]) || state.settings.model,
          messages: j.messages,
          maxTokens: 1200,
          temperature: 0.2
        });
      } catch (e) {
        if (j.fallback) j.fallback();
        continue;
      }
      auxRunning += 1;
      state.auxRun[run.id] = { text: '', label: j.label, onDone: j.onDone, fallback: j.fallback };
      toast(j.label + '中…');
    }
  }

  /* 抽取：模型只许返回 JSON，每条必须带 block_id + quote；
     入库前逐条校验（block 在不在、quote 是不是原文子串），过不了的丢弃。

     分窗：一章 4000 字以内一次调用；更长的按 1800 字左右切窗顺序跑，
     因为便宜模型在长上下文里更容易"编 quote"，分窗 + 校验比一次塞进去更准。
     重试：模型返回的不是 JSON 时，带"只输出 JSON"的提醒再要一次；两次都不行就用本地规则。 */
  function runExtract() {
    var c = cur();
    if (!c || !c.blocks.length) { toast('这一章还没有正文，没东西可抽'); return; }
    if (!(D.entities || []).length) { toast('先去「角色」建几张角色卡，抽取需要认得名字'); return; }
    var chunks = splitChunks(c.blocks, EXTRACT_CHUNK_CHARS);
    state.extractRun = { chapterId: c.id, chunks: chunks.length, done: 0, kept: [], dropped: 0, bad: 0 };
    chunks.forEach(function (chunk) { extractChunk(c, chunk, 0); });
  }

  var SFE = window.SFExtract;
  var EXTRACT_CHUNK_CHARS = (SFE && SFE.CHUNK_CHARS) || 1800;
  var LOW_CONF = (SFE && SFE.LOW_CONF) || 0.7;

  function splitChunks(blocks, limit) {
    return SFE.splitChunks(blocks, limit);
  }

  function extractChunk(c, blocks, attempt) {
    var names = D.entities.map(function (e) { return e.name; }).filter(Boolean);
    auxCall(attempt > 0 ? "抽取状态（重试）" : "抽取状态",
      [
        { role: "system", content: SFE.systemPrompt(names) },
        { role: "user", content: SFE.userPrompt(c, blocks, attempt) }
      ],
      "extract",
      function (text) {
        var arr = SFE.parseList(text);
        if (!arr) {
          if (attempt < 1) { extractChunk(c, blocks, attempt + 1); return; }
          state.extractRun.bad += 1;
          finishExtract(c);
          return;
        }
        ingestChunk(c, blocks, arr);
        finishExtract(c);
      },
      function () {
        /* 没配 Key / 请求失败：整章退回本地规则，不重复退 */
        state.extractRun = null;
        extractStatesLocal();
      });
  }

  function ingestChunk(c, chunk, arr) {
    var v = SFE.validate(chunk, arr, c);
    state.extractRun.dropped += v.dropped.length;
    v.kept.forEach(function (p) {
      p.id = SEED.uid("ps");
      state.extractRun.kept.push(p);
    });
  }

  function finishExtract(c) {
    var run = state.extractRun;
    if (!run) return;
    run.done += 1;
    if (run.done < run.chunks) return;
    state.extractRun = null;

    var exist = {};
    (D.proposedStates || []).forEach(function (p) { exist[p.entity + '|' + p.field + '|' + p.to] = 1; });
    var fresh = run.kept.filter(function (p) { return !exist[p.entity + '|' + p.field + '|' + p.to]; });
    if (!fresh.length) {
      toast('模型给了 ' + run.kept.length + ' 条，证据校验/去重后没剩下新的' +
        (run.dropped ? '（丢弃 ' + run.dropped + ' 条）' : '') + '，改用本地规则');
      extractStatesLocal();
      return;
    }
    /* 高置信在前，低置信垫底（默认不勾，要人自己点） */
    fresh.sort(function (a, b) { return (b.low ? 0 : 1) - (a.low ? 0 : 1) || b.conf - a.conf; });
    D.proposedStates = (D.proposedStates || []).concat(fresh);
    state.gatePage = 0;
    var low = fresh.filter(function (p) { return p.low; }).length;
    S.saveStates(pid, D.proposedStates).then(function () {
      renderAll();
      toast('抽到 ' + fresh.length + ' 条候选' + (low ? '（其中 ' + low + ' 条置信低，默认不勾）' : '') +
        (run.dropped ? '，丢弃 ' + run.dropped + ' 条证据不足的' : '') +
        (run.bad ? '，' + run.bad + ' 个片段没返回 JSON' : ''));
    });
  }

  /* 摘要：生成一章 80–150 字摘要，写进 chapter.summary，供后续章节的「前情」用 */
  function summarizeCur() {
    var c = cur();
    if (!c || !c.blocks.length) { toast('这一章还没有正文，没东西可摘要'); return; }
    var sys = '你是小说编辑助手。把这一章压缩成 80–150 字的中文摘要，只写发生了什么、谁改变了什么，不要评价、不要分点、不要小标题。';
    var user = '【第 ' + c.idx + ' 章 ' + c.title + '】\n' + c.blocks.map(function (b) { return b.text; }).join('\n\n');
    auxCall('生成摘要', [{ role: 'system', content: sys }, { role: 'user', content: user }], 'summary',
      function (text) {
        var sum = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 400);
        if (!sum) { toast('模型没返回摘要'); return; }
        c.summary = sum;
        c.summaryRev = c.rev || 1;
        S.saveSummary(pid, c.id, sum).then(function () { renderAll(); toast('摘要已保存（第 ' + (c.rev || 1) + ' 版）'); });
      },
      function () { toast('还没配 Key：摘要需要模型，先在设置里填 Key'); });
  }

  /* ---------------- 弹窗基础 ---------------- */

  function openModal(html, cls) {
    var card = $('#modalCard');
    card.className = 'modal-card' + (cls ? ' ' + cls : '');
    card.innerHTML = html;
    $('#modal').classList.add('open');
  }

  /* 带标题/说明的弹窗：openModalTitled(html, 标题, 副标题, 宽) */
  function openModalTitled(body, title, sub, wide) {
    openModal(
      '<h3>' + esc(title) + '</h3>' +
      (sub ? '<p class="hint">' + esc(sub) + '</p>' : '') + body,
      wide ? 'wide' : null
    );
  }
  function closeModal() {
    state.shelfRepaint = null;
    $('#modal').classList.remove('open');
    state.editing = null;
    state.modalKind = null;
  }
  function fRow(label, input) {
    return '<div class="form-row"><label>' + label + '</label>' + input + '</div>';
  }
  function fGrid(a, b) { return '<div class="form-grid">' + a + b + '</div>'; }
  function input(id, val, ph, type) {
    return '<input id="' + id + '" type="' + (type || 'text') + '" value="' + esc(val == null ? '' : val) + '" placeholder="' + esc(ph || '') + '">';
  }
  function textarea(id, val, ph, rows) {
    return '<textarea id="' + id + '" rows="' + (rows || 3) + '" placeholder="' + esc(ph || '') + '">' + esc(val == null ? '' : val) + '</textarea>';
  }
  function select(id, options, val) {
    return '<select id="' + id + '">' + options.map(function (o) {
      var v = o.value != null ? o.value : o;
      var t = o.label != null ? o.label : o;
      return '<option value="' + esc(v) + '"' + (String(v) === String(val == null ? '' : val) ? ' selected' : '') + '>' + esc(t) + '</option>';
    }).join('') + '</select>';
  }

  /* ---------------- 文风卡 ---------------- */

  var STYLE_POV = ['第三人称限知', '第三人称全知', '第一人称', '第一人称与第三人称混用'];
  var STYLE_TENSE = ['过去时', '现在时'];
  var STYLE_DIST = ['极近', '近', '中', '远'];
  var STYLE_SENT = ['短促', '中', '长句', '长短交错'];
  var STYLE_DIAL = ['极少', '少', '中', '多'];
  var STYLE_META = ['克制', '中', '浓'];

  function styleOf() { return (D && D.project && D.project.style) || {}; }

  function fpText(fp) {
    if (!fp) return '还没有分析样本。粘贴几段你喜欢的文字，点「分析样本」。';
    return '样本指纹：平均句长 ' + fp.avgLen + ' 字 · 句长波动 ' + fp.sdLen +
      ' · 对话段占比 ' + Math.round(fp.dialogueRatio * 100) + '% · 比喻 ' + fp.metaphorPer1k + '/千字' +
      ' · 短句占比 ' + Math.round(fp.shortRatio * 100) + '%';
  }

  function openStyle() {
    state.modalKind = 'style';
    var st = styleOf();
    var packs = SEED.stylePacks.map(function (p) {
      return '<button type="button" class="ck' + (st.pack === p.key ? ' on' : '') + '" data-pack="' + p.key + '" title="' + esc(p.desc) + '">' +
        esc(p.label) + '<em>' + esc(p.desc) + '</em></button>';
    }).join('');

    openModal('<h3>文风卡</h3>' +
      '<div class="sub">文风不是一句提示词：它由「包 + 字段 + 样本」三层决定，写正文时会拼进 system prompt，审查时也用同一份来判断漂移。</div>' +
      '<div class="form-row"><label>风格包<span class="lab-hint">选一个起点，下面的字段会被填上，之后随便改</span></label>' +
      '<div class="ck-wrap"><div class="ck-list">' + packs + '</div></div></div>' +
      fGrid(fRow('人称', select('sPov', [''] .concat(STYLE_POV), st.pov)),
        fRow('时态', select('sTense', [''] .concat(STYLE_TENSE), st.tense))) +
      fGrid(fRow('叙述距离', select('sDist', [''] .concat(STYLE_DIST), st.distance)),
        fRow('句子', select('sSent', [''] .concat(STYLE_SENT), st.sentence))) +
      fGrid(fRow('对话比例', select('sDial', [''] .concat(STYLE_DIAL), st.dialogue)),
        fRow('比喻密度', select('sMeta', [''] .concat(STYLE_META), st.metaphor))) +
      fRow('情绪基调', input('sTone', st.tone, '冷静、克制、雨气')) +
      fRow('禁用词（用、分隔）', input('sBanned', (st.banned || []).join('、'), '仿佛、不禁、一丝')) +
      '<div class="form-row"><label>投喂样本<span class="lab-hint">3–5 段你希望「像这样写」的文字。只模仿语气与句子节奏，不会照抄内容</span></label>' +
      textarea('sSample', st.sample, '粘贴一段参考文字…', 6) +
      '<div class="fp-box" id="sFp">' + esc(fpText(st.fp)) + '</div>' +
      '<div class="fp-acts"><button class="btn sm" data-act="style-analyze">分析样本</button>' +
      '<span class="hint-inline">本地统计不需要 Key；配了 Key 还能让模型把这几个字段填得更好</span></div></div>' +
      '<div class="form-acts"><button class="btn" data-act="close-modal">取消</button>' +
      '<button class="btn primary" data-act="style-save">保存文风</button></div>', 'wide');
  }

  function applyPack(key) {
    var p = SEED.stylePacks.filter(function (x) { return x.key === key; })[0];
    if (!p) return;
    $('#sPov').value = p.pov;
    $('#sTense').value = p.tense;
    $('#sDist').value = p.distance;
    $('#sSent').value = p.sentence;
    $('#sDial').value = p.dialogue;
    $('#sMeta').value = p.metaphor;
    $('#sTone').value = p.tone;
    $('#sBanned').value = (p.banned || []).join('、');
    Array.prototype.forEach.call(document.querySelectorAll('[data-pack]'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-pack') === key);
    });
  }

  function collectStyle() {
    var fp = SEED.styleFingerprint($('#sSample').value);
    var prev = styleOf().fp;
    var onPack = document.querySelector('[data-pack].on');
    var pack = onPack ? onPack.getAttribute('data-pack') : '';
    return {
      pack: pack || '',
      pov: $('#sPov').value,
      tense: $('#sTense').value,
      distance: $('#sDist').value,
      sentence: $('#sSent').value,
      dialogue: $('#sDial').value,
      metaphor: $('#sMeta').value,
      tone: $('#sTone').value.trim(),
      banned: $('#sBanned').value.split(/[、,，]/).map(function (s) { return s.trim(); }).filter(Boolean),
      sample: $('#sSample').value.trim(),
      fp: fp || prev || null
    };
  }

  function styleAnalyze() {
    var sample = $('#sSample').value.trim();
    if (!sample) { toast('先把样本粘进来'); $('#sSample').focus(); return; }
    var fp = SEED.styleFingerprint(sample);
    var box = $('#sFp');
    if (box) box.textContent = fpText(fp);
    if (!L.configured(state.settings)) {
      toast('本地指纹已算好。配 Key 后还能让模型直接填字段');
      return;
    }
    var btn = document.querySelector('[data-act="style-analyze"]');
    if (btn) { btn.disabled = true; btn.textContent = '分析中…'; }
    var sys = '你是中文小说的文风分析器。读用户给的样本文本，输出严格的 JSON，不要解释、不要代码块。' +
      '字段：{"pov":"第三人称限知|第三人称全知|第一人称","tense":"过去时|现在时","distance":"极近|近|中|远",' +
      '"sentence":"短促|中|长句|长短交错","dialogue":"极少|少|中|多","metaphor":"克制|中|浓",' +
      '"tone":"不超过 12 字的情绪基调","banned":["这段文字里几乎不出现的常见 AI 腔词，3-5 个"]}';
    var run = L.chat({
      settings: state.settings, model: state.settings.slots && state.settings.slots.summary || state.settings.model,
      messages: [{ role: 'system', content: sys }, { role: 'user', content: sample.slice(0, 3000) }],
      maxTokens: 400, temperature: 0.2
    });
    var buf = '';
    var off = L.onEvent(function (ev) {
      if (!run || ev.runId !== run.id) return;
      if (ev.type === 'delta') buf += ev.text;
      if (ev.type === 'done') {
        off();
        if (btn) { btn.disabled = false; btn.textContent = '分析样本'; }
        var json = (buf.match(/\{[\s\S]*\}/) || [])[0];
        try {
          var o = JSON.parse(json);
          if (o.pov) $('#sPov').value = o.pov;
          if (o.tense) $('#sTense').value = o.tense;
          if (o.distance) $('#sDist').value = o.distance;
          if (o.sentence) $('#sSent').value = o.sentence;
          if (o.dialogue) $('#sDial').value = o.dialogue;
          if (o.metaphor) $('#sMeta').value = o.metaphor;
          if (o.tone) $('#sTone').value = o.tone;
          if (o.banned && o.banned.length) $('#sBanned').value = o.banned.join('、');
          toast('模型填好了字段，检查一遍再保存');
        } catch (err) {
          toast('模型返回的不是 JSON，已保留本地指纹');
        }
      }
      if (ev.type === 'error') {
        off();
        if (btn) { btn.disabled = false; btn.textContent = '分析样本'; }
        toast('分析失败：' + (ev.message || ''));
      }
    });
  }

  function saveStyle() {
    var style = collectStyle();
    D.project.style = style;
    S.saveProjectMeta(pid, { style: style }).then(function () {
      closeModal();
      renderAll();
      toast('文风已保存：' + SEED.styleName(style));
    }).catch(function (e) { toast('保存失败：' + (e && e.message || e)); });
  }

  /* ---------------- 项目列表 ---------------- */

  /* ---------------- 书架 ----------------
     项目就是书：书脊竖着摆，书名竖排；选中的那本从架子上抽出来一点。
     滚轮 / ←→ 换一本，再点一下（或回车）才真正打开——避免滚过去就切项目。 */
  var SHELF_TONES = [
    '#efe7d6', '#e9e2d2', '#f2ece0', '#e4dccb', '#ece4d5', '#e7ddca'
  ];

  function shelfList() { return state.projects || []; }

  function shelfIndex() {
    var i = state.shelfSel;
    if (typeof i !== 'number' || i < 0 || i >= shelfList().length) {
      i = shelfList().findIndex(function (p) { return p.id === pid; });
      if (i < 0) i = 0;
      state.shelfSel = i;
    }
    return i;
  }

  function coverOf(p) {
    var c = String((p && p.cover) || '');
    if (!c) return '';
    if (/^https?:/i.test(c) || /^data:/i.test(c)) return c;
    return 'file:///' + c.replace(/\\/g, '/').replace(/#/g, '%23').replace(/^\/+/, '');
  }

  function bookHtml(p, i, sel) {
    var on = i === sel ? ' on' : '';
    var tone = SHELF_TONES[i % SHELF_TONES.length];
    var cv = coverOf(p);
    return '<div class="book' + on + '" data-act="shelf-book" data-id="' + p.id + '" data-i="' + i + '"' +
      ' style="--tone:' + tone + '" title="' + esc(p.name) + '｜' + fmtNum(p.words || 0) + ' 字 · ' +
      (p.chapterCount || 0) + ' 章' + (p.isDemo ? ' · 示例' : '') + '">' +
      '<div class="bk-spine"><span class="bk-name">' + esc(p.name) + '</span></div>' +
      '<div class="bk-cover' + (cv ? ' has-cv' : '') + '"' + (cv ? ' style="background-image:url(&quot;' + cv.replace(/"/g, '%22') + '&quot;)"' : '') + '>' + (cv ? '' : '<i class="bk-ph"></i>') +
      (p.isDemo ? '<span class="bk-badge">示例</span>' : '') + '</div>' +
      '</div>';
  }

  function currentProjectRow() {
    var list = shelfList();
    return list[shelfIndex()] || null;
  }

  function pickProjectCover() {
    var p = currentProjectRow();
    if (!p) return;
    var inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*';
    inp.onchange = function () {
      var f = inp.files && inp.files[0];
      if (!f) return;
      var fr = new FileReader();
      fr.onload = function () {
        var img = new Image();
        img.onload = function () {
          var w = 320, h = Math.round((img.height / img.width) * w);
          var cv = document.createElement('canvas');
          cv.width = w; cv.height = h;
          cv.getContext('2d').drawImage(img, 0, 0, w, h);
          var dataUrl = cv.toDataURL('image/jpeg', 0.82);
          S.saveProjectMeta(p.id, { cover: dataUrl }).then(function () {
            toast('封面已存进这本书');
            return S.init();
          }).then(function (r) {
            state.projects = r.projects;
            openProjects();
          }).catch(function (e) { toast('存封面失败：' + (e && e.message || e)); });
        };
        img.src = fr.result;
      };
      fr.readAsDataURL(f);
    };
    inp.click();
  }

  function openProjects() {
    state.modalKind = 'projects';
    var list = shelfList();
    var sel = shelfIndex();

    function body() {
      var books = list.map(function (p, i) { return bookHtml(p, i, sel); }).join('');
      var cur = list[sel];
      return '<h3>书架</h3>' +
        '<div class="sub">每本书是一个独立项目：章节、正文、资料卡、伏笔、忽略记录都在书里。' +
        '滚轮或 ← → 挑一本，再点它（或按回车）打开。</div>' +
        '<div class="shelf-wrap" id="shelfWrap">' +
        '<div class="shelf" id="shelf">' + books +
        '<div class="book add" data-act="new-project" title="新建项目">' +
        '<div class="bk-top"></div><div class="bk-name">＋ 新书</div><div class="bk-meta">新建项目</div></div>' +
        '</div><div class="shelf-board"></div></div>' +
        (cur ? '<div class="shelf-info">' +
          '<div class="si-name">' + esc(cur.name) + (cur.id === pid ? '<span class="chip">正在写</span>' : '') + '</div>' +
          '<div class="si-meta">' + fmtNum(cur.words || 0) + ' 字 · ' + (cur.chapterCount || 0) + ' 章' +
          (cur.genre ? ' · ' + esc(cur.genre) : '') +
          (cur.logline ? ' · ' + esc(String(cur.logline).slice(0, 40)) : '') + '</div>' +
          '<div class="si-acts">' +
          '<button class="btn primary sm" data-act="shelf-open" data-id="' + cur.id + '">打开这本书</button>' +
        '<button class="btn ghost sm" data-act="shelf-cover">换封面</button>' +
          '<button class="btn sm danger" data-act="del-proj" data-id="' + cur.id + '">删除</button>' +
          '</div></div>' : '') +
        '<div class="form-acts"><button class="btn" data-act="close-modal">关闭</button>' +
        '<button class="btn primary" data-act="new-project">＋ 新建项目</button></div>';
    }

    function paint() {
      state.modalKind = 'projects';
      openModal(body(), 'wide');
      var card = $('#modalCard');
      if (card) card.className = 'modal-card wide shelf-card';
      bindShelf();
    }

    /* 换书时不要重画整块弹窗：原来每次都 openModal(innerHTML=...)，
       整块 DOM 重建 → 书的抽出动画失效、滚轮一动就"卡一下"。
       现在只切 .on、改信息条、把选中的那本滚进视野。 */
    function paintSelection() {
      var shelfEl = $('#shelf');
      if (!shelfEl) return;
      var i = shelfIndex();
      var books = shelfEl.querySelectorAll('.book[data-i]');
      for (var k = 0; k < books.length; k++) {
        books[k].classList.toggle('on', +books[k].getAttribute('data-i') === i);
      }
      var cur = list[i];
      var info = $('.shelf-info');
      if (info && cur) {
        var nameEl = info.querySelector('.si-name');
        var metaEl = info.querySelector('.si-meta');
        var openBtn = info.querySelector('[data-act="shelf-open"]');
        var delBtn = info.querySelector('[data-act="del-proj"]');
        if (nameEl) {
          nameEl.innerHTML = esc(cur.name) +
            (cur.id === pid ? '<span class="chip">正在写</span>' : '');
        }
        if (metaEl) {
          metaEl.textContent = fmtNum(cur.words || 0) + ' 字 · ' + (cur.chapterCount || 0) + ' 章' +
            (cur.genre ? ' · ' + cur.genre : '') +
            (cur.logline ? ' · ' + String(cur.logline).slice(0, 40) : '');
        }
        if (openBtn) openBtn.setAttribute('data-id', cur.id);
        if (delBtn) delBtn.setAttribute('data-id', cur.id);
      }
      var on = shelfEl.querySelector('.book.on');
      if (on && on.scrollIntoView) {
        try { on.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' }); } catch (e) { }
      }
    }

    function move(d) {
      var n = list.length;
      if (!n) return;
      var i = (shelfIndex() + d + n) % n;
      state.shelfSel = i;
      paintSelection();
    }

    function bindShelf() {
      var wrap = $('#shelfWrap');
      if (!wrap) return;
      var at = 0;
      wrap.addEventListener('wheel', function (e) {
        e.preventDefault();
        var now = Date.now();
        if (now - at < 90) return;
        at = now;
        move(e.deltaY > 0 ? 1 : -1);
      }, { passive: false });
    }

    paint();
    state.shelfRepaint = paintSelection;

    /* 键盘：← → 换一本，回车打开选中的那本 */
    state.shelfKeys = function (e) {
      if (state.modalKind !== 'projects') return false;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { move(1); return true; }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { move(-1); return true; }
      if (e.key === 'Enter') {
        var cur = list[shelfIndex()];
        if (cur) openFromShelf(cur.id);
        return true;
      }
      return false;
    };
  }

  function openFromShelf(id) {
    closeModal();
    if (id === pid) { toast('已经在写这本书了'); return; }
    openProject(id).then(function () { toast('换了一本：' + ($('#projName') || {}).textContent); });
  }

  /* ---------------- 新建项目向导 ---------------- */

  function conflictChipsHtml(selected) {
    var sel = selected || [];
    return SEED.conflictGroups.map(function (g) {
      var items = SEED.conflictKinds.filter(function (c) { return c.group === g; });
      return '<div class="ck-group"><span class="ck-gt">' + esc(g) + '</span><div class="ck-list">' +
        items.map(function (c) {
          return '<button type="button" class="ck' + (sel.indexOf(c.key) >= 0 ? ' on' : '') +
            '" data-ck="' + c.key + '" title="' + esc(c.desc + '，例如：' + c.eg) + '">' +
            esc(c.label) + '<em>' + esc(c.eg.split(' / ')[0]) + '</em></button>';
        }).join('') + '</div></div>';
    }).join('');
  }

  function checkedConflicts(root) {
    return Array.prototype.map.call((root || document).querySelectorAll('.ck.on'), function (b) { return b.getAttribute('data-ck'); });
  }

  function openWizard() {
    state.modalKind = 'wizard';
    var tpls = Object.keys(SEED.templates).map(function (k) {
      var t = SEED.templates[k];
      return '<option value="' + k + '">' + esc(t.label) + ' — ' + esc(t.hint) + '</option>';
    }).join('') + '<option value="custom">自定义节拍 — 自己写每章要发生什么</option>';

    openModal('<h3>新建项目</h3>' +
      '<div class="sub">先回答三件事：写什么、谁在挣扎、读者为什么看下去。模板只决定章节卡的骨架，之后每张都能改。</div>' +
      fRow('作品名', input('nName', '', '例如：补字人')) +
      fGrid(fRow('类型', input('nGenre', '悬疑', '悬疑 / 都市 / 奇幻 / 科幻…')),
        fRow('结构模板', '<select id="nTpl">' + tpls + '</select>')) +
      fRow('一句话想法', textarea('nLogline', '', '一个修书匠发现补上的字会改人的命。', 2)) +
      fRow('卖点', input('nSell', '', '一句话告诉读者这书和别人有什么不一样')) +
      fRow('主角想要', input('nDesire', '', '补回师父的名字')) +
      '<div class="form-row"><label>主角会遇到哪些阻力？<span class="lab-hint">短篇也通常不止一种。可多选，也可以一个不选</span></label>' +
      '<div class="ck-wrap" id="nConflicts">' + conflictChipsHtml([]) + '</div></div>' +
      fRow('最要命的那个是什么', input('nConflictLead', '', '写得越具体越好：补完最后一个字，可能就轮到自己')) +
      '<div class="form-row" id="nBeatsWrap" hidden><label>自定义节拍<span class="lab-hint">每行一章，格式：标题 | 这一章要做什么</span></label>' +
      textarea('nBeats', '', '第 1 章 开场 | 主角的日常被打断\n第 2 章 升级 | 对方加码', 6) + '</div>' +
      fGrid(fRow('章数', input('nCount', '10', '', 'number')), fRow('目标总字数', input('nWords', '', '默认 章数×1500', 'number'))) +
      '<div class="hint">v0.1.0 只承诺短篇 / 前 10 章。章数超过 20 的项目，向导照样能建，但一致性审查不在这一版的承诺范围内。</div>' +
      '<div class="form-acts"><button class="btn" data-act="close-modal">取消</button>' +
      '<button class="btn" data-act="wizard-ai" title="把上面那句话扩成骨架，你再改">让 AI 先搭骨架</button>' +
      '<button class="btn" data-act="wizard-sample">用示例填一遍</button>' +
      '<button class="btn primary" data-act="wizard-create">创建项目</button></div>', 'wide');

    var wrap = $('#nBeatsWrap');
    var ta = $('#nBeats');
    function syncBeats() {
      var isCustom = $('#nTpl').value === 'custom';
      wrap.hidden = !isCustom;
      if (isCustom && !ta.value.trim()) {
        var t = SEED.templates.threeAct;
        ta.value = t.beats.map(function (b, i) { return '第 ' + (i + 1) + ' 章 ' + b[0] + ' | ' + b[1]; }).join('\n');
      }
    }
    $('#nTpl').addEventListener('change', syncBeats);
    syncBeats();
  }

  function parseBeats(text) {
    return (text || '').split('\n').map(function (line) {
      var s = line.trim();
      if (!s) return null;
      var parts = s.split('|');
      var head = (parts[0] || '').trim();
      var goal = (parts[1] || '').trim();
      return [head, goal || head];
    }).filter(Boolean);
  }

  /* 一句话 → 骨架：把 logline 扩成"卖点 / 主角想要 / 最主要的阻力 / 十章节拍"，
     全部填进向导表单让用户改——不是直接建项目。没配 Key 就退回模板节拍，
     照样能往下走，只是骨架是通用套路。 */
  function wizardOutline() {
    var logline = $('#nLogline').value.trim();
    if (!logline) { toast('先把那句话写进去：一句话就行'); $('#nLogline').focus(); return; }

    var keys = SEED.conflictKinds.map(function (k) { return k.key; });

    function applyLocal() {
      var t = SEED.templates[$('#nTpl').value] || SEED.templates.threeAct;
      $('#nTpl').value = 'custom';
      var ta = $('#nBeats');
      ta.value = t.beats.slice(0, 10).map(function (b, i) {
        return '第 ' + (i + 1) + ' 章 ' + b[0] + ' | ' + b[1];
      }).join('\n');
      $('#nBeatsWrap').hidden = false;
      toast('没配 Key：先用这套模板节拍搭骨架，你可以逐行改');
    }

    if (!L.configured(state.settings)) { applyLocal(); return; }

    function land(text) {
      var obj = null;
      try {
        var s = String(text || '');
        var a = s.indexOf('{'), b = s.lastIndexOf('}');
        if (a >= 0 && b > a) obj = JSON.parse(s.slice(a, b + 1));
      } catch (e) { obj = null; }
      if (!obj || typeof obj !== 'object') { toast('模型没按格式回答，先用模板骨架'); applyLocal(); return; }

      if (obj.name && !$('#nName').value.trim()) $('#nName').value = String(obj.name).slice(0, 40);
      if (obj.genre) $('#nGenre').value = String(obj.genre).slice(0, 20);
      if (obj.sellPoint) $('#nSell').value = String(obj.sellPoint).slice(0, 80);
      if (obj.desire) $('#nDesire').value = String(obj.desire).slice(0, 80);
      if (obj.conflictLead || obj.conflict) $('#nConflictLead').value = String(obj.conflictLead || obj.conflict).slice(0, 120);

      if (Array.isArray(obj.conflicts)) {
        var want = obj.conflicts.filter(function (k) { return keys.indexOf(k) >= 0; });
        var box = $('#nConflicts');
        Array.prototype.forEach.call(box.querySelectorAll('.ck'), function (btn) {
          btn.classList.toggle('on', want.indexOf(btn.getAttribute('data-ck')) >= 0);
        });
      }

      if (Array.isArray(obj.beats) && obj.beats.length) {
        var lines = obj.beats.slice(0, 40).map(function (x, i) {
          if (typeof x === 'string') return '第 ' + (i + 1) + ' 章 ' + x;
          return '第 ' + (i + 1) + ' 章 ' + String(x.title || '').trim() + ' | ' + String(x.goal || x.title || '').trim();
        });
        $('#nTpl').value = 'custom';
        $('#nBeats').value = lines.join('\n');
        $('#nBeatsWrap').hidden = false;
        $('#nCount').value = String(lines.length);
      }
      toast('骨架填好了：章节卡、卖点、阻力都能改，改完再点创建');
    }

    toast('让模型把这句话扩成骨架…');
    auxCall('扩写大纲', [
      {
        role: 'system',
        content: [
          '你是中文短篇小说的策划，负责把作者的一句话扩成"能开工的骨架"，不是替他写正文。',
          '只输出一个 JSON 对象，不要解释、不要 markdown：',
          '{"name":"书名","genre":"类型","sellPoint":"一句话卖点","desire":"主角想要什么",',
          ' "conflictLead":"最要命的那一个阻力（具体，带代价）","conflicts":["key1","key2"],',
          ' "beats":[{"title":"这一章的标题","goal":"这一章要发生什么"}]}',
          '要求：beats 8–12 条，每条是一个"事件"而不是"情绪"；',
          'conflicts 从这些 key 里选 2–4 个：' + keys.join(', ') + '；',
          '整条故事线要能收口，不要留没用的支线。'
        ].join('\n')
      },
      { role: 'user', content: '我的一句话想法：' + logline }
    ], 'draft', land, function () { applyLocal(); });
  }

  function wizardCreate() {
    var name = $('#nName').value.trim();
    if (!name) { toast('先给作品起个名字'); $('#nName').focus(); return; }
    var count = Math.max(1, Math.min(200, +$('#nCount').value || 10));
    var targetWords = +$('#nWords').value || count * 1500;
    var isCustom = $('#nTpl').value === 'custom';
    var beats = isCustom ? parseBeats($('#nBeats').value) : null;
    if (isCustom && !beats.length) { toast('自定义节拍至少要写一行'); $('#nBeats').focus(); return; }
    var payload = SEED.blankPayload({
      name: name,
      genre: $('#nGenre').value.trim(),
      logline: $('#nLogline').value.trim(),
      sellPoint: $('#nSell').value.trim(),
      desire: $('#nDesire').value.trim(),
      conflict: $('#nConflictLead').value.trim(),
      conflictLead: $('#nConflictLead').value.trim(),
      conflicts: checkedConflicts($('#nConflicts')),
      chapterCount: count,
      targetWords: targetWords,
      template: isCustom ? 'threeAct' : $('#nTpl').value,
      beats: beats
    });
    closeModal();
    S.createProject(payload).then(function (newPid) {
      return refreshProjects().then(function () { return openProject(newPid); });
    }).then(function () {
      toast('项目已创建 · ' + payload.chapters.length + ' 张章节卡已生成');
    }).catch(function (e) { toast('创建失败：' + (e && e.message || e)); });
  }

  function fillWizardSample() {
    $('#nName').value = '雨停之前';
    $('#nGenre').value = '都市悬疑';
    $('#nLogline').value = '一个快递员每天送同一个地址，收件人从不出现。';
    $('#nSell').value = '每一单都指向同一个失踪案';
    $('#nDesire').value = '想知道那个地址里住着谁';
    $('#nConflictLead').value = '问到第七单，收件人变成了他自己的名字';
    $('#nCount').value = '10';
    $('#nWords').value = '15000';
    var box = $('#nConflicts');
    Array.prototype.forEach.call(box.querySelectorAll('.ck'), function (b) {
      var k = b.getAttribute('data-ck');
      b.classList.toggle('on', k === 'info' || k === 'time' || k === 'self');
    });
  }


  /* ---------------- 章节卡 ---------------- */

  function nextChapterIdx() {
    return chapters().reduce(function (a, c) { return Math.max(a, c.idx); }, 0) + 1;
  }

  /* 「这一章谁变了」的解析：一行 = 角色｜字段｜从→到（分隔符宽松点，用户可能用 | 或 ，） */
  function parseChanges(text) {
    return String(text || '').split('\n').map(function (line) {
      line = line.trim();
      if (!line) return null;
      var parts = line.split(/[｜|]/).map(function (x) { return x.trim(); });
      if (parts.length < 2) return null;
      var to = '', from = '';
      var rest = parts.slice(2).join(' ');
      var arrow = rest.split(/→|->|=>/);
      if (arrow.length >= 2) { from = arrow[0].trim(); to = arrow.slice(1).join(' ').trim(); }
      else to = rest.trim();
      if (!parts[0]) return null;
      return { entity: parts[0], field: parts[1] || '', from: from, to: to };
    }).filter(Boolean);
  }

  /* 一条「本章转变」到底有没有着落：有当章状态更新 → 落定；有他出场的段落 → 至少有机会；
     两样都没有 → 明说没兑现（不猜） */
  function changeStatus(ch, x) {
    var st = (D.confirmedStates || []).filter(function (s) {
      return s && s.entity === x.entity && s.chapter === ch.idx && (!x.field || s.field === x.field);
    });
    if (st.length) return { ok: true, why: '第 ' + ch.idx + ' 章有状态更新作证' };
    var scene = (ch.blocks || []).filter(function (b) {
      return b.actors && b.actors.indexOf(x.entity) >= 0;
    });
    if (scene.length) return { ok: true, why: '本章有他出场的 ' + scene.length + ' 段（还没抽成状态）' };
    return { ok: false, why: '本章没有他的段落，也没抽出状态 —— 这场转变还没写' };
  }

  /* 人物弧线：把每条线「从什么到什么」和每章的状态点摆在一起看 */
  function openTimeline() {
    var ents = (D.entities || []).filter(function (e) { return arcThreadsOf(e).length; });
    var chs = chapters();
    var head = '<h3>人物弧线</h3><div class="sub">一个人可以同时有几条线：左边是一开始，右边是最后，中间的点是每章被确认过的状态。' +
      '弧线是可选的，没写的角色不会出现在这里。</div>';
    if (!ents.length) {
      closeModalThen(function () {
        openModalTitled('<div class="indeterminate">还没有角色写了弧线。打开任意一张角色卡，勾上「给他写弧线」即可 —— 不勾也能正常写，只是这几条检查不会跑。</div>' +
          '<div class="form-acts"><button class="btn" data-act="close-modal">关闭</button></div>', '人物弧线');
      });
      return;
    }
    var body = ents.map(function (e) {
      var dots = chs.map(function (ch) {
        var st = (D.confirmedStates || []).filter(function (s) {
          return s && s.entity === e.name && s.chapter === ch.idx;
        });
        var cls = st.length ? 'on' : (ch.blocks.length ? 'idle' : 'empty');
        return '<span class="tl-dot ' + cls + '" title="第 ' + ch.idx + ' 章' +
          (st.length ? '：' + st.map(function (s) { return s.field + '=' + s.value; }).join('；') : '（没有状态）') + '"></span>';
      }).join('');

      var lines = arcThreadsOf(e).map(function (a, ai) {
        var beats = (a.beats || []).map(function (b) {
          var ch = chs.filter(function (x) { return x.idx === b.chapter; })[0];
          return '<div class="tl-beat"><span class="tl-ch">第 ' + b.chapter + ' 章</span>' +
            '<span class="tl-txt">' + esc(b.text || '') + '</span>' +
            '<span class="tl-st">' + (ch && ch.blocks.length ? (ch.status === 'done' ? '已完稿' : '有草稿') : '还没写') + '</span></div>';
        }).join('');
        return '<div class="tl-line">' +
          '<div class="tl-kind">' + esc(a.label || ('第 ' + (ai + 1) + ' 条线')) + '</div>' +
          '<div class="tl-ends"><div class="tl-from"><em>一开始</em>' + esc(a.from || '（没写）') + '</div>' +
          '<div class="tl-arrow">→</div>' +
          '<div class="tl-to"><em>最后</em>' + esc(a.to || '（没写）') + '</div></div>' +
          (beats ? '<div class="tl-beats">' + beats + '</div>' : '') +
          ((a.forbidden || []).length
            ? '<div class="tl-forb">不允许提前出现：' + a.forbidden.map(esc).join('、') +
            (a.reachChapter ? '（第 ' + a.reachChapter + ' 章之后才行）' : '') + '</div>'
            : '') +
          '</div>';
      }).join('');

      return '<div class="tl-card">' +
        '<div class="tl-head"><b>' + esc(e.name) + '</b>' +
        (e.kind ? '<span class="tl-role">' + esc(e.kind) + '</span>' : '') +
        '<span class="tl-count">' + arcThreadsOf(e).length + ' 条线</span></div>' +
        lines +
        '<div class="tl-dots">' + dots + '</div>' +
        '</div>';
    }).join('');
    openModalTitled(body + '<div class="form-acts"><button class="btn" data-act="close-modal">关闭</button></div>',
      '人物弧线', '', true);
  }

  function closeModalThen(fn) { closeModal(); setTimeout(fn, 0); }

  function openChapterForm(chapterOrNull) {
    state.modalKind = 'chapter';
    var isNew = !chapterOrNull;
    var c = chapterOrNull || {
      id: SEED.uid('c'), idx: nextChapterIdx(), title: '第 ' + nextChapterIdx() + ' 章',
      status: 'planned',
      card: { goal: '', conflict: '', turn: '', pov: '', cast: [], plant: '', payoff: '', targetWords: 1500 },
      blocks: []
    };
    state.editing = c;
    openModal('<h3>' + (isNew ? '新建章节卡' : '编辑章节卡') + '</h3>' +
      '<div class="sub">章节卡是写给自己的施工图：这一章要发生什么、卡在哪、最后怎么拐弯。</div>' +
      fGrid(fRow('章号', input('cIdx', c.idx, '', 'number')), fRow('标题', input('cTitle', c.title.replace(/^第.+?章\s*/, ''), '这一章的名字'))) +
      fRow('目标（本章要做到）', textarea('cGoal', c.card.goal, '沈砚确认账本是师父留下的', 2)) +
      fRow('冲突（卡在哪）', textarea('cConflict', c.card.conflict, '他不能回头看', 2)) +
      fRow('转折（怎么拐弯）', textarea('cTurn', c.card.turn, '老周从来不叫他「小沈」', 2)) +
      fGrid(fRow('视角', input('cPov', c.card.pov, '沈砚')), fRow('出场角色（用、分隔）', input('cCast', (c.card.cast || []).join('、'), '沈砚、老周'))) +
      fGrid(fRow('埋设伏笔', input('cPlant', c.card.plant, '缺笔的字')), fRow('回收伏笔', input('cPayoff', c.card.payoff, ''))) +
      fRow('目标字数', input('cWords', c.card.targetWords || 1500, '', 'number')) +
      fRow('这一章谁变了（可选，每行一个：「角色｜字段｜从→到」）',
        textarea('cChanges', (c.card.changes || []).map(function (x) {
          return x.entity + '｜' + (x.field || '') + '｜' + (x.from || '') + '→' + (x.to || '');
        }).join('\n'), '沈砚｜信念｜师父是自己跳的→屋里还有第三个人', 2)) +
      '<label class="check-line"><input type="checkbox" id="cLocked"' + (c.card.locked ? ' checked' : '') + '> 锁定本章（正文不可直接编辑，防手滑）</label>' +
      '<div class="form-acts">' +
      (isNew ? '' : '<button class="btn danger" data-act="del-chapter">删除本章</button>') +
      '<button class="btn" data-act="close-modal">取消</button>' +
      '<button class="btn primary" data-act="save-chapter-card">保存</button></div>');
  }

  function saveChapterCard() {
    var c = state.editing;
    if (!c) return;
    var title = $('#cTitle').value.trim() || ('第 ' + (+$('#cIdx').value || c.idx) + ' 章');
    c.idx = +$('#cIdx').value || c.idx;
    c.title = /^第.+?章/.test(title) ? title : ('第 ' + c.idx + ' 章 ' + title);
    c.card.goal = $('#cGoal').value.trim();
    c.card.conflict = $('#cConflict').value.trim();
    c.card.turn = $('#cTurn').value.trim();
    c.card.pov = $('#cPov').value.trim();
    c.card.cast = $('#cCast').value.split(/[、,，]/).map(function (s) { return s.trim(); }).filter(Boolean);
    c.card.plant = $('#cPlant').value.trim();
    c.card.payoff = $('#cPayoff').value.trim();
    c.card.targetWords = +$('#cWords').value || 1500;
    c.card.changes = parseChanges($('#cChanges').value);
    c.card.locked = !!($('#cLocked') && $('#cLocked').checked);

    var exists = chapters().some(function (x) { return x.id === c.id; });
    if (!exists) D.chapters.push(c);
    D.chapters.sort(function (a, b) { return a.idx - b.idx; });
    state.chapterId = c.id;
    closeModal();
    S.saveChapter(pid, c).then(function () {
      return refreshProjects();
    }).then(function () {
      renderAll();
      toast('章节卡已保存');
    }).catch(function (e) { toast('保存失败：' + (e && e.message || e)); });
  }

  /* 上移 / 下移 / 锁定：都在章节卡层面改，落库走 saveChapter */
  function persistOrder(list, msg) {
    list.forEach(function (x, i) {
      x.idx = i + 1;
      var bare = x.title.replace(/^第.+?章\s*/, '');
      x.title = '第 ' + (i + 1) + ' 章' + (bare ? ' ' + bare : '');
    });
    D.chapters = list;
    Promise.all(list.map(function (x) { return S.saveChapter(pid, x); })).then(function () {
      return refreshProjects();
    }).then(function () {
      renderAll();
      if (msg) toast(msg);
    }).catch(function (e) { toast('保存失败：' + (e && e.message || e)); });
  }

  function moveChapter(id, dir) {
    var list = chapters().slice();
    var i = list.map(function (c) { return c.id; }).indexOf(id);
    var j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    var t = list[i]; list[i] = list[j]; list[j] = t;
    persistOrder(list, '第 ' + (j + 1) + ' 章换到了第 ' + (i + 1) + ' 位');
  }

  function toggleLock(id) {
    var c = chapters().filter(function (x) { return x.id === id; })[0];
    if (!c) return;
    c.card = c.card || {};
    c.card.locked = !c.card.locked;
    S.saveChapter(pid, c).then(function () {
      renderAll();
      toast(c.card.locked ? '已锁定：改正文前会先问一句' : '已解锁');
    });
  }

  function deleteChapter() {
    var c = state.editing;
    if (!c) return;
    if (chapters().length <= 1) { toast('至少留一章'); return; }
    D.chapters = chapters().filter(function (x) { return x.id !== c.id; });
    D.chapters.forEach(function (x, i) { x.idx = i + 1; });
    state.chapterId = D.chapters[0].id;
    closeModal();
    // 章节表没有 delete IPC，用"重排 + 保存"近似：剩下的章节逐个落库，被删的那章留在库里但不进项目
    Promise.all(D.chapters.map(function (x) { return S.saveChapter(pid, x); })).then(function () {
      return refreshProjects();
    }).then(function () {
      renderAll();
      toast('已删除（原型：库里仍保留该章记录，正式版走 deleteChapter）');
    });
  }

  /* ---------------- 资料卡：角色 / 世界观 / 伏笔 ---------------- */

  function openEntityForm(entity) {
    state.modalKind = 'entity';
    var isNew = !entity;
    var e = entity || { id: SEED.uid('e'), kind: '配角', name: '', role: '', desire: '', wound: '', voice: '', secret: '', note: '' };
    state.editing = e;
    var kinds = ['主角', '配角', '反派', '物品', '地点', '势力'];
    var threads = arcThreadsOf(e);
    var on = threads.length > 0;
    openModal('<h3>' + (isNew ? '新建角色卡' : '编辑角色卡') + '</h3>' +
      '<div class="sub">先填三个：他想要什么、他怕什么、他怎么说话。剩下的可以等他出场再补。</div>' +
      fGrid(fRow('类型', '<select id="eKind">' + kinds.map(function (k) {
        return '<option ' + (k === e.kind ? 'selected' : '') + '>' + k + '</option>';
      }).join('') + '</select>'), fRow('名字', input('eName', e.name, '沈砚'))) +
      fRow('一句话定位', input('eRole', e.role, '修书匠，主角')) +
      fRow('欲望（想要什么）', textarea('eDesire', e.desire, '补回师父的名字', 2)) +
      fRow('伤口（怕什么）', textarea('eWound', e.wound, '他补的字曾经害死过人', 2)) +
      fRow('说话方式', input('eVoice', e.voice, '话少，爱用反问')) +
      fRow('藏着的事', input('eSecret', e.secret, '他其实是那个字的主人')) +
      fRow('备注', input('eNote', e.note, '')) +
      '<div class="arc-box">' +
      '<label class="arc-on"><input type="checkbox" id="aOn"' + (on ? ' checked' : '') + '> ' +
      '给他写弧线 <em>可选，不写也能用。一个人可以同时有几条线，每条线自己说清"从什么到什么"</em></label>' +
      '<div id="arcFields"' + (on ? '' : ' hidden') + '>' +
      '<div id="arcList">' + threads.map(arcThreadHtml).join('') + '</div>' +
      '<button type="button" class="btn ghost sm" data-act="arc-add">＋ 再加一条线</button>' +
      '</div></div>' +
      '<div class="form-acts">' +
      (isNew ? '' : '<button class="btn danger" data-act="del-entity">删除</button>') +
      '<button class="btn" data-act="close-modal">取消</button>' +
      '<button class="btn primary" data-act="save-entity">保存</button></div>');
  }

  /* 从弹窗里读回所有弧线；一条都没填内容的线直接丢掉（别让空线把规则骗成"有弧线"） */
  function collectArcs() {
    var out = [];
    var box = document.getElementById('arcList');
    if (!box) return out;
    [].forEach.call(box.querySelectorAll('.arc-thread'), function (el) {
      var n = el.getAttribute('data-thread');
      var g = function (id) { var x = document.getElementById(id); return x ? x.value : ''; };
      var beats = String(g('tBeats' + n) || '').split('\n').map(function (line) {
        var m = line.match(/^\s*第?\s*(\d+)\s*章?\s*(.*)$/);
        if (!m) return null;
        return { chapter: parseInt(m[1], 10), text: (m[2] || '').trim() };
      }).filter(function (b) { return b && b.chapter > 0; });
      var forb = String(g('tForb' + n) || '').split(/[,，、;；]/).map(function (x) { return x.trim(); })
        .filter(function (x) { return x.length >= 2; });
      var reach = parseInt(g('tReach' + n), 10);
      var labelEl = el.querySelector('[data-f="label"]');
      var a = {
        label: (labelEl ? labelEl.value : '').trim(),
        from: g('tFrom' + n).trim(),
        to: g('tTo' + n).trim(),
        beats: beats,
        forbidden: forb,
        reachChapter: reach > 0 ? reach : 0
      };
      if (!a.from && !a.to && !beats.length && !forb.length) return;
      out.push(a);
    });
    return out;
  }
  var ARC_SEQ = 0;
  /* 弧线：一个人可以有好几条并行的线，每条线自己说清"从什么到什么"，没有"类型"这种东西 */
  function arcThreadsOf(e) {
    if (Array.isArray(e.arcs) && e.arcs.length) return e.arcs;
    if (e.arc && (e.arc.from || e.arc.to || (e.arc.beats || []).length)) return [e.arc];
    return [];
  }

  function arcThreadHtml(a, i) {
    a = a || {};
    ARC_SEQ += 1;
    var k = '#t' + ARC_SEQ;
    var beats = (a.beats || []).map(function (b) { return '第' + b.chapter + '章 ' + (b.text || ''); }).join('\n');
    return '<div class="arc-thread" data-thread="' + ARC_SEQ + '">' +
      '<div class="arc-t-head"><input class="arc-t-name" data-f="label" placeholder="这条线叫什么（可不填，例如「对师父的看法」）" value="' +
      esc(a.label || '') + '">' +
      '<button type="button" class="arc-t-del" data-act="arc-del" title="删掉这条线">×</button></div>' +
      '<div class="arc-t-body">' +
      fRow('一开始', textarea('tFrom' + ARC_SEQ, a.from || '', '他是自己跳下去的', 1)) +
      fRow('最后', textarea('tTo' + ARC_SEQ, a.to || '', '屋里还有第三个人', 1)) +
      fRow('转折点（每行一个，写成「第3章 第一次动摇」）',
        textarea('tBeats' + ARC_SEQ, beats, '第6章 河堤上问出口', 2)) +
      '<div class="form-grid">' +
      fRow('不允许提前出现的（逗号分隔）', input('tForb' + ARC_SEQ, (a.forbidden || []).join('，'), '第三个人')) +
      fRow('到第几章之后才允许', '<input id="tReach' + ARC_SEQ + '" type="number" min="1" max="999" value="' +
        (a.reachChapter || '') + '">') +
      '</div></div></div>';
  }

  function saveEntity() {
    var e = state.editing;
    if (!e) return;
    e.kind = $('#eKind').value;
    e.name = $('#eName').value.trim();
    if (!e.name) { toast('先填名字'); $('#eName').focus(); return; }
    e.role = $('#eRole').value.trim();
    e.desire = $('#eDesire').value.trim();
    e.wound = $('#eWound').value.trim();
    e.voice = $('#eVoice').value.trim();
    e.secret = $('#eSecret').value.trim();
    e.note = $('#eNote').value.trim();
    /* 弧线是可选的：不勾就把弧线删干净，别留一个空壳把规则骗成"有弧线" */
    if (!$('#aOn').checked) {
      delete e.arc;
      delete e.arcs;
    } else {
      e.arcs = collectArcs();
      delete e.arc;
    }
    var i = D.entities.map(function (x) { return x.id; }).indexOf(e.id);
    if (i >= 0) D.entities[i] = e; else D.entities.push(e);
    closeModal();
    S.saveEntities(pid, D.entities).then(function () {
      state.tab = 'chars';
      renderAll();
      toast('角色卡已保存');
    }).catch(function (err) { toast('保存失败：' + (err && err.message || err)); });
  }

  function deleteEntity() {
    var e = state.editing;
    if (!e) return;
    D.entities = D.entities.filter(function (x) { return x.id !== e.id; });
    closeModal();
    S.saveEntities(pid, D.entities).then(function () { renderAll(); toast('已删除'); });
  }

  function openWorldForm(world) {
    state.modalKind = 'world';
    var isNew = !world;
    var w = world || { id: SEED.uid('w'), kind: '规则', name: '', text: '' };
    state.editing = w;
    var kinds = ['规则', '地点', '势力', '物品', '能力体系', '时代'];
    openModal('<h3>' + (isNew ? '新建世界观条目' : '编辑世界观条目') + '</h3>' +
      '<div class="sub">只写会真正影响剧情的那几条。写不动的条目，先空着比编满强。</div>' +
      fGrid(fRow('类型', '<select id="wKind">' + kinds.map(function (k) {
        return '<option ' + (k === w.kind ? 'selected' : '') + '>' + k + '</option>';
      }).join('') + '</select>'), fRow('名称', input('wName', w.name, '补字'))) +
      fRow('内容', textarea('wText', w.text, '手稿缺的字可以补；补完之后的名字，七日内会死。', 5)) +
      '<div class="form-acts">' +
      (isNew ? '' : '<button class="btn danger" data-act="del-world">删除</button>') +
      '<button class="btn" data-act="close-modal">取消</button>' +
      '<button class="btn primary" data-act="save-world">保存</button></div>');
  }

  function saveWorld() {
    var w = state.editing;
    if (!w) return;
    w.kind = $('#wKind').value;
    w.name = $('#wName').value.trim();
    if (!w.name) { toast('先填名称'); $('#wName').focus(); return; }
    w.text = $('#wText').value.trim();
    var i = D.worldRules.map(function (x) { return x.id; }).indexOf(w.id);
    if (i >= 0) D.worldRules[i] = w; else D.worldRules.push(w);
    closeModal();
    S.saveWorldRules(pid, D.worldRules).then(function () {
      state.tab = 'world';
      renderAll();
      toast('世界观已保存');
    }).catch(function (err) { toast('保存失败：' + (err && err.message || err)); });
  }

  function deleteWorld() {
    var w = state.editing;
    if (!w) return;
    D.worldRules = D.worldRules.filter(function (x) { return x.id !== w.id; });
    closeModal();
    S.saveWorldRules(pid, D.worldRules).then(function () { renderAll(); toast('已删除'); });
  }

  function openFsForm(fs) {
    state.modalKind = 'fs';
    var isNew = !fs;
    var f = fs || {
      id: SEED.uid('f'), title: '', plantedChapter: cur() ? cur().idx : 1, plantedBlock: null,
      quote: '', due: (cur() ? cur().idx : 1) + 3, status: 'planted', related: [], note: ''
    };
    state.editing = f;
    var sts = [['planted', '待回收'], ['touched', '已触碰'], ['resolved', '已回收'], ['abandoned', '放弃']];
    openModal('<h3>' + (isNew ? '新建伏笔' : '编辑伏笔') + '</h3>' +
      '<div class="sub">伏笔当任务管：埋在哪一章、打算哪一章收、收不了就明确放弃。</div>' +
      fRow('伏笔内容', input('fTitle', f.title, '缺笔的字')) +
      fGrid(fRow('埋设章', input('fPlanted', f.plantedChapter, '', 'number')),
        fRow('预期回收章', input('fDue', f.due, '', 'number'))) +
      fRow('状态', '<select id="fStatus">' + sts.map(function (s) {
        return '<option value="' + s[0] + '" ' + (s[0] === f.status ? 'selected' : '') + '>' + s[1] + '</option>';
      }).join('') + '</select>') +
      fRow('备注', input('fNote', f.note, '回收方式 / 关联角色')) +
      '<div class="form-acts">' +
      (isNew ? '' : '<button class="btn danger" data-act="del-fs">删除</button>') +
      '<button class="btn" data-act="close-modal">取消</button>' +
      '<button class="btn primary" data-act="save-fs">保存</button></div>');
  }

  function saveFs() {
    var f = state.editing;
    if (!f) return;
    f.title = $('#fTitle').value.trim();
    if (!f.title) { toast('先填伏笔内容'); $('#fTitle').focus(); return; }
    f.plantedChapter = +$('#fPlanted').value || 1;
    f.due = +$('#fDue').value || null;
    f.status = $('#fStatus').value;
    f.note = $('#fNote').value.trim();
    var i = D.foreshadows.map(function (x) { return x.id; }).indexOf(f.id);
    if (i >= 0) D.foreshadows[i] = f; else D.foreshadows.push(f);
    closeModal();
    S.saveForeshadows(pid, D.foreshadows).then(function () {
      state.tab = 'fs';
      renderAll();
      toast('伏笔已保存');
    }).catch(function (err) { toast('保存失败：' + (err && err.message || err)); });
  }

  function deleteFs() {
    var f = state.editing;
    if (!f) return;
    D.foreshadows = D.foreshadows.filter(function (x) { return x.id !== f.id; });
    closeModal();
    S.saveForeshadows(pid, D.foreshadows).then(function () { renderAll(); toast('已删除'); });
  }

  /* ---------------- 外观（背景色 / 玻璃态 / 色卡滚轮） ---------------- */

  function openTheme() {
    var T = window.SFTheme;
    if (!T) return toast('外观模块没加载成功，看控制台');
    state.modalKind = 'theme';
    var dark = T.isDark(T.state.bg);
    openModal(
      '<h3>外观</h3>' +
      '<div class="hint-inline">滚轮上的每张色卡就是一套背景。选中的那张会从圆环里拉起来一块。' +
      '深色背景会自动把文字换成浅色。</div>' +
      T.wheelHtml() +
      '<div class="theme-row">' +
      '<span class="theme-cap">面板</span>' +
      '<div class="theme-seg">' +
      '<button data-preset="solid">纸面</button><button data-preset="glass">玻璃</button>' +
      '</div>' +
      '<span class="sep"></span>' +
      '<span class="theme-cap">自定义</span>' +
      '<input type="color" id="sfCustom" value="' + T.state.bg + '">' +
      '<input type="text" id="sfHex" value="' + T.state.bg + '" spellcheck="false">' +
      '</div>' +
      '<div class="theme-note">背景色只影响界面，不进正文、不进导出包，也不随项目切换。' +
      '当前是<b>' + (dark ? '深色' : '浅色') + '</b>底（自动判定，文字配色跟着换）。' +
      '玻璃态需要一点层次才好看，所以会自动给底色加一层柔光。</div>' +
      '<div class="form-acts"><button class="btn primary" data-act="close-modal">完成</button></div>',
      'theme-sheet');

    var card = $('#modalCard');
    T.bindWheel(card);

    var col = card.querySelector('#sfCustom');
    if (col) col.addEventListener('input', function () { themeCustom(col.value); });
    var hx = card.querySelector('#sfHex');
    if (hx) {
      hx.addEventListener('change', function () {
        if (!themeCustom(hx.value)) { toast('色值要写成 #RRGGBB'); hx.value = T.state.bg; }
      });
    }
  }

  /* 手输 / 取色器：不落进色板，滚轮变成"无选中"状态 */
  function themeCustom(hex) {
    var T = window.SFTheme;
    var v = String(hex || '').trim();
    if (v[0] !== '#') v = '#' + v;
    if (!/^#[0-9a-fA-F]{6}$/.test(v)) return false;
    T.set({ bg: v.toLowerCase(), sel: -1 });
    var card = $('#modalCard');
    if (card) { T.layout(card); T.syncControls(card); }
    return true;
  }

  /* ---------------- 设置 ---------------- */

  /* 精简模式：右侧栏整块收起，页面上所有"AI 建议"入口一起藏起来。
     左侧资料与正文不动——用户要的是少打扰，不是少功能。 */
  function applyLite() {
    var on = !!(state.settings && state.settings.lite);
    document.body.classList.toggle('lite', on);
    var rp = $('#rightPane');
    if (rp) rp.setAttribute('aria-hidden', on ? 'true' : 'false');
  }

  function openSettings() {
    state.modalKind = 'settings';
    var s = state.settings;
    var chips = PRESETS.map(function (p) {
      return '<button class="btn sm preset" data-act="preset" data-id="' + p.id + '">' + esc(p.label) + '</button>';
    }).join('');
    var masked = s.apiKey ? (s.apiKey.slice(0, 5) + '…' + s.apiKey.slice(-4)) : '';

    openModal('<h3>模型与 API</h3>' +
      '<div class="sub">Key 只存本机：Electron 下写入系统凭据区（safeStorage），浏览器里退化为 localStorage。' +
      '它不随项目导出，也不进日志。</div>' +
      '<div class="preset-row">' + chips + '</div>' +
      fRow('Base URL', input('fBase', s.baseURL, 'https://api.deepseek.com/v1')) +
      '<div class="form-row"><label>API Key</label>' +
      '<div class="key-row"><input id="fKey" type="password" placeholder="AIza… 或 sk-…" value="">' +
      '<button class="btn sm" data-act="toggle-key">显示</button></div>' +
      '<div class="hint" id="keyHint">' + (s.apiKey ? '已保存：' + esc(masked) + '（留空即保持不变）' : '还没有配置 Key。不配也能用：生成会走示例文本。') + '</div></div>' +
      '<div class="form-grid">' +
      fRow('草稿模型', input('fSlotDraft', (s.slots && s.slots.draft) || s.model, 'deepseek-chat')) +
      fRow('摘要模型', input('fSlotSummary', (s.slots && s.slots.summary) || s.model, 'deepseek-chat')) +
      '</div>' +
      '<div class="form-grid">' +
      fRow('抽取模型', input('fSlotExtract', (s.slots && s.slots.extract) || s.model, 'deepseek-chat')) +
      fRow('审阅模型', input('fSlotReview', (s.slots && s.slots.review) || s.model, 'deepseek-chat')) +
      '</div>' +
      '<div class="hint">审阅是"另一个作者帮你看稿"：它和写作用的模型分开配，读同一章、只出意见。' +
      '想让它唱反调，就换一个型号（比如写作写 deepseek-chat、审阅用别的）。</div>' +
      '<div class="form-grid">' +
      fRow('超时（秒）', input('fTimeout', s.timeout, '120', 'number')) +
      fRow('输入单价（元/百万 token）', input('fIn', s.priceIn, '2', 'number')) +
      '</div>' +
      '<div class="form-grid">' +
      fRow('输出单价（元/百万 token）', input('fOut', s.priceOut, '8', 'number')) +
      '</div>' +
      '<div class="hint">兼容 OpenAI 的 /chat/completions 与 SSE 流式；Google Gemini 选预设后按 generativelanguage 协议走（Key 用 AI Studio 的 API Key）。本地模型（Ollama / LM Studio）把 Base URL 填成 http://localhost:11434/v1，Key 留空即可。</div>' +
      '<div class="test-out" id="testOut"></div>' +
      '<div class="form-row"><label>精简模式</label>' +
      '<label class="switch-row"><input type="checkbox" id="fLite"' + (s.lite ? ' checked' : '') + '>' +
      '<span>少一堆东西：隐藏右侧栏（生成、体检、待确认、上下文），只留左侧资料与正文。' +
      '适合只想写字、不想被建议打扰的时候。随时可以关掉。</span></label></div>' +
      '<div class="form-row"><label>关于</label>' +
      '<div class="about-box">' +
      '<div class="ab-name">StoryForge <span class="ab-ver">v' + APP_VERSION + '</span></div>' +
      '<div class="ab-desc">本地优先的 AI 小说创作工作台。把一句想法拆成章节卡，按卡生成可编辑的草稿，' +
      '再用规则与审阅守住设定，全程数据留在你自己的电脑上。</div>' +
      '<ul class="ab-list">' +
      '<li><b>写</b>：章节卡 → 按卡生成 → 逐段采纳（可改后采纳），每次采纳都是一次可回滚的版本</li>' +
      '<li><b>管</b>：角色 / 世界观 / 伏笔三类资料卡，人物弧线可写多条线（可选）</li>' +
      '<li><b>查</b>：13 条本地规则（逝者行动、地点跳变、伏笔超期、AI 味、认知越界、解释密集、弧线四查…）' +
      '＋ 独立的审阅模型（参考栏，不进体检条数）</li>' +
      '<li><b>读</b>：书库能放 txt / md / epub / pdf（EPUB 连封面与章节插图一起排），' +
      '带目录、进度、夜间；不认识的文件交给系统程序打开</li>' +
      '<li><b>找</b>：古登堡计划可以直接搜、直接下到书架；中文站（wenku8 等）**登录一次**就行——' +
      '窗口里登完，应用复用那个会话去搜、抓目录、抓正文（不存你的账号密码）；' +
      '「在窗口里打开站点」——你登录、它只把当前页的书目读回来，能按书号抓目录/正文/整本</li>' +
      '<li><b>存</b>：Electron 下写 SQLite（启动/删除前自动备份），数据与备份目录都能改、能迁移；' +
      '浏览器下退化为 localStorage</li>' +
      '<li><b>走</b>：Markdown / TXT / .sfpkg 项目包，随时能带走，不含 API Key</li>' +
      '</ul>' +
      '<div class="ab-foot">开源（AGPL-3.0）· 本地优先 · 自带 Key，或接本地模型</div>' +
      '</div></div>' +
      '<div class="form-row" style="margin-top:12px"><label>本地数据</label>' +
      '<div id="dataBox" style="font-size:12px;color:var(--muted);line-height:1.8">读取中…</div></div>' +
      '<div class="form-row"><label>备份</label>' +
      '<div id="backupBox" style="font-size:12px;color:var(--muted);line-height:1.8">读取中…</div>' +
      '<div class="btn-row" style="margin-top:6px">' +
      '<button class="btn sm" data-act="backup-now">立即备份</button>' +
      '<button class="btn sm" data-act="open-backups">打开备份目录</button>' +
      '</div></div>' +
      '<div class="form-row"><label>存放位置</label>' +
      '<div id="pathBox" class="path-box">读取中…</div>' +
      '<div class="btn-row" style="margin-top:6px">' +
      '<button class="btn sm" data-act="path-move-data">更改数据目录…</button>' +
      '<button class="btn sm" data-act="path-move-backups">更改备份目录…</button>' +
      '<button class="btn sm" data-act="path-reset">恢复默认</button>' +
      '</div>' +
      '<div class="hint-inline">搬家只复制，不删旧目录；改完要重启应用才完全生效。</div></div>' +
      '<div class="form-acts"><button class="btn" data-act="close-modal">关闭</button>' +
      '<button class="btn danger" data-act="clear-key">清除 Key</button>' +
      '<button class="btn danger" data-act="reset-data">清空全部数据</button>' +
      '<button class="btn" data-act="test-llm">连接测试</button>' +
      '<button class="btn primary" data-act="save-settings">保存</button></div>', 'wide');
    refreshDataBox();
    refreshBackupBox();
    refreshPathBox();
    // Electron：把系统凭据区里的 Key 读回来，仅用于判断"是否已配置"，不显示全文
    if (window.sfBridge && window.sfBridge.loadKey) {
      window.sfBridge.loadKey().then(function (k) {
        if (!k) return;
        state.settings.apiKey = k;
        var hint = $('#keyHint');
        if (hint) hint.textContent = '已保存：' + (k.slice(0, 5) + '…' + k.slice(-4)) + '（留空即保持不变）';
      }).catch(function () { });
    }
  }

  function collectSettings() {
    var s = clone(state.settings);
    s.baseURL = $('#fBase').value.trim().replace(/\/+$/, '');
    var key = $('#fKey').value.trim();
    if (key) s.apiKey = key;
    s.slots = {
      draft: $('#fSlotDraft').value.trim() || s.model,
      summary: $('#fSlotSummary').value.trim() || s.model,
      extract: $('#fSlotExtract').value.trim() || s.model,
      review: (($('#fSlotReview') || {}).value || '').trim() || s.model
    };
    s.model = s.slots.draft;
    s.timeout = +$('#fTimeout').value || 120;
    s.priceIn = +$('#fIn').value || 0;
    s.priceOut = +$('#fOut').value || 0;
    s.lite = !!(($('#fLite') || {}).checked);
    return s;
  }

  function refreshDataBox() {
    var box = $('#dataBox');
    if (!box) return;
    function paint(st) {
      var where = st.backend === 'sqlite'
        ? 'SQLite 文件：' + st.file
        : '浏览器 localStorage（Electron 下自动换成 SQLite）';
      box.innerHTML = where + '<br>' +
        '已落库：' + (st.projects || 0) + ' 个项目 · ' + (st.chapters || 0) + ' 章 / ' + (st.blocks || 0) + ' 段' +
        (st.waivers ? ' · 忽略记录 ' + st.waivers + ' 条' : '') +
        (st.bytes ? ' · ' + (st.bytes / 1024).toFixed(1) + ' KB' : '') +
        (st.savedAt ? '<br>最近保存：' + new Date(st.savedAt).toLocaleString('zh-CN') : '');
    }
    var r = S.stats();
    if (r && typeof r.then === 'function') r.then(paint).catch(function () { box.textContent = '读取失败'; });
    else paint(r || {});
  }

  function refreshBackupBox() {
    var box = $('#backupBox');
    if (!box) return;
    function paint(b) {
      b = b || {};
      var files = b.files || [];
      if (!files.length) {
        box.innerHTML = '还没有备份。应用每次启动会自动存一份；删项目、清空数据前也会先存。';
        return;
      }
      box.innerHTML = '共 ' + (b.count || files.length) + ' 份 · 最近一份 ' +
        new Date((b.latest && b.latest.at) || files[0].at).toLocaleString('zh-CN') +
        '<br><span class="mono" style="word-break:break-all;font-size:11px;color:var(--muted)">' +
        esc(b.dir || '') + '</span>';    }
    var r = S.backups();
    if (r && typeof r.then === 'function') r.then(paint).catch(function () { box.textContent = '读取失败'; });
    else paint(r || {});
  }

  /* ---------------- 存放位置（数据 / 备份） ---------------- */

  function fmtBytes(n) {
    n = Number(n || 0);
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  function refreshPathBox() {
    var box = $('#pathBox');
    if (!box) return;
    function paint(p) {
      p = p || {};
      if (p.browser) {
        box.innerHTML = esc(p.dataRoot || '浏览器 localStorage') +
          '<br><span class="pb-note">' + esc(p.note || '') + '</span>';
        return;
      }
      box.innerHTML =
        '<div class="pb-row"><span class="pb-l">数据</span>' +
        '<code class="pb-p">' + esc(p.dataRoot || '') + '</code>' +
        '<span class="pb-s">' + fmtBytes(p.data && p.data.bytes) + ' · ' + ((p.data && p.data.files) || 0) + ' 个文件</span>' +
        '<button class="btn sm" data-act="path-open" data-dir="' + esc(p.dataRoot || '') + '">打开</button></div>' +
        '<div class="pb-row"><span class="pb-l">备份</span>' +
        '<code class="pb-p">' + esc(p.backupRoot || '') + '</code>' +
        '<span class="pb-s">' + fmtBytes(p.backup && p.backup.bytes) + ' · ' + ((p.backups && p.backups.length) || 0) + ' 份</span>' +
        '<button class="btn sm" data-act="path-open" data-dir="' + esc(p.backupRoot || '') + '">打开</button></div>' +
        (p.custom ? '<div class="pb-note">已改成自定义位置（配置文件：' + esc(p.configFile || '') + '）</div>' : '');
    }
    var r = S.pathsInfo();
    if (r && typeof r.then === 'function') r.then(paint).catch(function () { box.textContent = '读取失败'; });
    else paint(r || {});
  }

  function movePath(kind) {
    S.pathsPick().then(function (r) {
      var dir = (r && r.dir) || '';
      if (!dir) return;
      var go = kind === 'data' ? S.moveData(dir) : S.moveBackups(dir);
      go.then(function (res) {
        if (res && res.error) { toast('搬家失败：' + res.error); return; }
        refreshPathBox();
        refreshBackupBox();
        toast(kind === 'data'
          ? '数据已复制到新位置。旧目录还留着，确认没问题可以自己删；重启应用后生效。'
          : '备份目录已改。旧备份还留着；重启应用后生效。');
      }).catch(function (e) { toast('搬家失败：' + (e && e.message ? e.message : e)); });
    });
  }

  function testLlm() {
    var out = $('#testOut');
    var s = collectSettings();
    if (!s.baseURL) { toast('先填 Base URL'); return; }
    /* 没填 Key 就别去打网络：Ollama 这类本地服务可以不填，其它接口一定会 401 */
    if (!s.apiKey && !/localhost|127\.0\.0\.1|0\.0\.0\.0/.test(s.baseURL)) {
      if (out) { out.className = 'test-out bad'; out.textContent = '先填 API Key 再测。Key 只存在本机，用来验证连接。'; }
      $('#fKey').focus();
      return;
    }
    if (out) { out.className = 'test-out'; out.textContent = '测试中…'; }
    var t0 = Date.now();
    L.ping(s).then(function (r) {
      var ms = r.ms || (Date.now() - t0);
      if (r.ok) {
        if (out) {
          out.className = 'test-out ok';
          out.innerHTML = '连接成功 · HTTP ' + (r.status || 200) + ' · ' + ms + 'ms' +
            (r.models && r.models.length ? '<br>可用模型 ' + r.models.length + ' 个：' + esc(r.models.slice(0, 8).join(', ')) : '') +
            (r.via === 'chat' ? '<br>（/models 不可用，已用一次最小补全验证）' : '');
        }
        toast('连接成功（' + ms + 'ms）');
      } else {
        if (out) {
          out.className = 'test-out bad';
          out.textContent = '连接失败：' + (r.message || ('HTTP ' + r.status));
        }
        toast('连接失败，详见弹窗');
      }
    }).catch(function (e) {
      if (out) { out.className = 'test-out bad'; out.textContent = '连接失败：' + (e && e.message || e); }
    });
  }

  /* ---------------- 导出 ---------------- */

  function doExport() {
    if (!D) return;
    state.modalKind = 'export';
    openModal('<h3>导出</h3>' +
      '<div class="sub">导出的就是你自己写的东西。正文只出正文，不掺任何 AI 后台数据（那些在项目包里）。</div>' +
      '<div class="form-grid">' +
      fRow('范围', select('xScope', ['本书全部', '仅当前章'], '本书全部')) +
      fRow('格式', select('xFmt', ['Markdown（.md）', '纯文本（.txt）', 'EPUB（.epub，电子书）'], 'Markdown（.md）')) +
      '</div>' +
      '<label class="check-line"><input type="checkbox" id="xBom"> 加 UTF-8 BOM（Windows 记事本/TXT 打开更保险）</label>' +
      '<div class="hint">项目包（.sfpkg）是 JSON：含项目、章节、资料卡、伏笔、待确认状态与你确认过的状态。不含 API Key。</div>' +
      '<div class="form-acts"><button class="btn" data-act="close-modal">取消</button>' +
      '<button class="btn" data-act="export-pkg">导出项目包</button>' +
      '<button class="btn primary" data-act="export-run">导出正文</button></div>');
  }

  function exportRun() {
    var scope = ($('#xScope') || {}).value || '本书全部';
    var fmt = ($('#xFmt') || {}).value || 'Markdown（.md）';
    if (fmt.indexOf('EPUB') === 0) { exportEpub(); return; }
    var bom = !!($('#xBom') && $('#xBom').checked);
    var list = scope === '仅当前章' ? [cur()].filter(Boolean) : chapters();
    var text;
    if (fmt.indexOf('Markdown') === 0) {
      text = '# ' + D.project.name + '\n\n';
      if (D.project.logline) text += '> ' + D.project.logline + '\n\n';
      text += list.map(function (c) {
        if (!c.blocks.length) return '';
        return '## ' + c.title + '\n\n' + c.blocks.map(function (b) { return b.text; }).join('\n\n') + '\n';
      }).join('\n');
    } else {
      text = D.project.name + '\n\n' + list.map(function (c) {
        if (!c.blocks.length) return '';
        return c.title + '\n\n' + c.blocks.map(function (b) { return b.text; }).join('\n\n') + '\n';
      }).join('\n');
    }
    var ext = fmt.indexOf('Markdown') === 0 ? '.md' : '.txt';
    var mime = fmt.indexOf('Markdown') === 0 ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8';
    var name = D.project.name + '_' + new Date().toISOString().slice(0, 10) + ext;
    closeModal();
    download(name, mime, (bom ? '\ufeff' : '') + text);
    toast('已导出 ' + list.filter(function (c) { return c.blocks.length; }).length + ' 章' + ext);
  }

/* 导出 EPUB：章节 → XHTML，图片块暂时只出文字（项目里的图片块在下一版接） */
  /* 读一张插图的字节：桌面版从 assets 读文件，浏览器版解 dataURL */
  function readImageBytes(src) {
    if (!src) return Promise.resolve(null);
    var m = String(src).match(/^data:image\/([a-z0-9+.-]+);base64,(.+)$/i);
    if (m) {
      var bin = atob(m[2]);
      var arr = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i += 1) arr[i] = bin.charCodeAt(i);
      return Promise.resolve({ bytes: arr, mime: 'image/' + (m[1] === 'jpg' ? 'jpeg' : m[1]) });
    }
    if (window.sfBridge && window.sfBridge.library) {
      return window.sfBridge.library.invoke('asset-read', { path: src })
        .then(function (r) {
          var bin2 = atob(r.base64);
          var a2 = new Uint8Array(bin2.length);
          for (var k = 0; k < bin2.length; k += 1) a2[k] = bin2.charCodeAt(k);
          return { bytes: a2, mime: r.mime || 'image/jpeg' };
        })
        .catch(function () { return null; });
    }
    return Promise.resolve(null);
  }

  function exportEpub() {
    if (!window.SFEpub) { toast('EPUB 打包器没加载上'); return; }
    var list = chapters().filter(function (c) { return (c.blocks || []).length; });
    if (!list.length) { toast('还没有正文可以导出'); return; }
    var jobs = [];
    var chs = list.map(function (c) {
      var blocks = [];
      (c.blocks || []).forEach(function (b, i) {
        if (b.kind === 'img' || b.img) {
          blocks.push({ kind: 'img', src: b.img, caption: b.caption || '', slot: blocks.length });
          jobs.push(b);
          return;
        }
        var t = String(b.text || '').trim();
        if (t) blocks.push({ kind: 'para', text: t });
      });
      return { title: c.title, blocks: blocks };
    });
    toast('正在打包 EPUB（含插图）…');
    Promise.all(jobs.map(function (b) { return readImageBytes(b.img); })).then(function (got) {
      var idx = 0;
      chs.forEach(function (ch) {
        ch.blocks.forEach(function (bl) {
          if (bl.kind !== 'img') return;
          var g = got[idx];
          idx += 1;
          if (!g) { bl.kind = 'para'; bl.text = bl.caption ? ('［插图］' + bl.caption) : '［插图］'; return; }
          var ext = (g.mime.split('/')[1] || 'jpeg').replace('jpeg', 'jpg');
          bl.name = 'img_' + (idx) + '.' + ext;
          bl.mime = g.mime;
          bl.bytes = g.bytes;
        });
      });
      var bytes = window.SFEpub.build({
        title: D.project.name,
        author: D.project.author || '',
        chapters: chs
      });
      var name = D.project.name + '_' + new Date().toISOString().slice(0, 10) + '.epub';
      closeModal();
      downloadBytes(name, 'application/epub+zip', bytes);
      var imgs = jobs.length;
      toast('已导出 ' + chs.length + ' 章' + (imgs ? ' · 含 ' + imgs + ' 张插图' : '') + ' · ' + Math.round(bytes.length / 1024) + ' KB');
    });
  }

  /* 项目包：一份自包含 JSON，换台机器 import 回来能接着写 */
  function downloadBytes(filename, mime, bytes) {
    var blob = new Blob([bytes], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 400);
  }

  function exportPackage() {
    var payload = {
      format: 'storyforge.package',
      formatVersion: 1,
      app: 'StoryForge 0.1.0',
      exportedAt: new Date().toISOString(),
      project: D.project,
      chapters: chapters(),
      entities: D.entities,
      worldRules: D.worldRules,
      foreshadows: D.foreshadows,
      confirmedStates: D.confirmedStates,
      proposedStates: D.proposedStates,
      waivers: D.waivers,
      kv: D.kv
    };
    var name = D.project.name + '_' + new Date().toISOString().slice(0, 10) + '.sfpkg';
    closeModal();
    download(name, 'application/json;charset=utf-8', JSON.stringify(payload, null, 2));
    toast('已导出项目包（不含 API Key）');
  }

  function download(filename, mime, text) {
    var blob = new Blob([text], { type: mime });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
  }

  /* ---------------- 事件 ---------------- */

  /* 角色卡里勾「给他写弧线」才展开，避免一进来就被大表单吓到 */
  document.addEventListener('change', function (e) {
    if (e.target && e.target.id === 'aOn') {
      var box = document.getElementById('arcFields');
      if (box) box.hidden = !e.target.checked;
      if (e.target.checked && box && !box.querySelector('.arc-thread')) {
        var list = document.getElementById('arcList');
        if (list) list.insertAdjacentHTML('beforeend', arcThreadHtml({}, 0));
      }
    }
  });

  /* 弧线可以有好几条：加一条 / 删一条，都在同一个角色卡里 */
  document.addEventListener('click', function (e) {
    var add = e.target.closest('[data-act="arc-add"]');
    if (add) {
      var list = document.getElementById('arcList');
      if (list) list.insertAdjacentHTML('beforeend', arcThreadHtml({}, 0));
      return;
    }
    var del = e.target.closest('[data-act="arc-del"]');
    if (del) {
      var card = del.closest('.arc-thread');
      if (card) card.remove();
      return;
    }
  });

  document.addEventListener('click', function (e) {
    if (e.target.id === 'modal') { closeModal(); return; }

    var fold = e.target.closest('.rhead');
    if (fold) {
      var key = fold.getAttribute('data-fold');
      state.folds[key] = !(state.folds[key] != null ? state.folds[key] : false);
      fold.parentElement.classList.toggle('collapsed', state.folds[key]);
      return;
    }

    var tab = e.target.closest('#tabs button');
    if (tab) { state.tab = tab.getAttribute('data-tab'); renderLeft(); return; }

    /* 用 closest 而不是 e.target.id：按钮里有 <em>/<span>/<i> 子元素，点到子元素时 target 不是按钮 */
    if (e.target.closest('#btnProjects')) { openProjects(); return; }
    if (e.target.closest('#btnExport')) { doExport(); return; }
    if (e.target.closest('#btnSettings')) { openSettings(); return; }
    if (e.target.closest('#btnStyle')) { openStyle(); return; }
    if (e.target.closest('#btnTheme')) { openTheme(); return; }
    if (e.target.closest('#btnView')) {
      state.sideView = state.sideView === 'wheel' ? 'file' : 'wheel';
      saveSideView();
      renderLeft();
      toast(state.sideView === 'wheel' ? '左栏：滚轮视图（滚轮 / ↑↓ 换一张）' : '左栏：档案卡视图（选中的抽出来）');
      return;
    }
    var seg = e.target.closest('[data-preset]');
    if (seg) {
      var want = seg.getAttribute('data-preset');
      window.SFTheme.set({ glass: want === 'glass' });
      window.SFTheme.syncControls($('#modalCard'));
      return;
    }

    /* 多选 chips：向导的阻力清单、文风的风格包 */
    var ck = e.target.closest('[data-ck]');
    if (ck) { ck.classList.toggle('on'); return; }
    var pk = e.target.closest('[data-pack]');
    if (pk) { applyPack(pk.getAttribute('data-pack')); return; }
    if (e.target.closest('#btnAdd')) {
      if (state.tab === 'cards') openChapterForm(null);
      else if (state.tab === 'chars') openEntityForm(null);
      else if (state.tab === 'world') openWorldForm(null);
      else openFsForm(null);
      return;
    }

    var actEl = e.target.closest('[data-act]');
    if (actEl) {
      var act = actEl.getAttribute('data-act');
      var id = actEl.getAttribute('data-id');
      var name = actEl.getAttribute('data-name');

      if (act === 'close-modal') { closeModal(); return; }
      if (act === 'new-project') { openWizard(); return; }
      if (act === 'load-demo') { loadDemoProject(); return; }
      if (act === 'import-pkg') { var fi = $('#fileImport'); if (fi) fi.click(); return; }
      if (act === 'wizard-ai') { wizardOutline(); return; }
      if (act === 'wizard-create') { wizardCreate(); return; }
      if (act === 'wizard-sample') { fillWizardSample(); return; }
      if (act === 'shelf-book') {
        var bid = actEl.getAttribute('data-id');
        var bi = +actEl.getAttribute('data-i');
        if (state.shelfSel === bi) { openFromShelf(bid); return; }
        state.shelfSel = bi;
        if (typeof state.shelfRepaint === 'function') state.shelfRepaint();
        return;
      }
      if (act === 'shelf-cover') { pickProjectCover(); return; }
    if (act === 'shelf-open') { openFromShelf(actEl.getAttribute('data-id')); return; }
      if (act === 'del-proj') {
        e.stopPropagation();
        var target = state.projects.filter(function (p) { return p.id === id; })[0];
        if (!target) return;
        if (state.confirmReset !== id) {
          state.confirmReset = id;
          actEl.textContent = '再点一次删除';
          setTimeout(function () { if (actEl.isConnected) { state.confirmReset = null; actEl.textContent = '删除'; } }, 4000);
          return;
        }
        state.confirmReset = null;
        S.deleteProject(id).then(function (r) {
          var saved = r && r.backup;
          return S.init().then(function (res) { return { res: res, saved: saved }; });
        }).then(function (o) {
          var res = o.res;
          state.projects = res.projects || [];
          var next = res.activeProjectId;
          closeModal();
          var note = o.saved ? '（删之前已备份到 backups）'
            : (S.backend === 'local' ? '（已放进回收站，最多留 5 份）' : '');
          if (!next) { renderEmptyHome(); toast('最后一个项目已删除' + note); return; }
          return openProject(next, { toast: '项目已删除' + note });
        }).catch(function (err) { toast('删除失败：' + (err && err.message || err)); });
        return;
      }
      if (act === 'edit-ch') { openChapterForm(chapters().filter(function (c) { return c.id === id; })[0]); return; }
      if (act === 'timeline') { openTimeline(); return; }
      if (act === 'new-ch') { openChapterForm(null); return; }
      if (act === 'ch-up') { moveChapter(id, -1); return; }
      if (act === 'ch-down') { moveChapter(id, 1); return; }
      if (act === 'toggle-lock') { toggleLock(id); return; }
      if (act === 'save-chapter-card') { saveChapterCard(); return; }
      if (act === 'ctx-drop') {
        if (name) { state.excluded[name] = 1; renderRight(); toast('这次不带「' + name + '」'); }
        return;
      }
      if (act === 'ctx-restore') { state.excluded = {}; renderRight(); toast('已恢复全部上下文'); return; }
      if (act === 'extract') { extractStatesLocal(); return; }
      if (act === 'export-run') { exportRun(); return; }
      if (act === 'export-pkg') { exportPackage(); return; }
      if (act === 'recheck-from') { recheckFrom(); return; }
      if (act === 'gate-prev') { state.gatePage = Math.max(0, state.gatePage - 1); renderRight(); return; }
      if (act === 'gate-next') { state.gatePage = state.gatePage + 1; renderRight(); return; }
      if (act === 'del-chapter') { deleteChapter(); return; }
      if (act === 'edit-entity') { openEntityForm(D.entities.filter(function (x) { return x.id === id; })[0]); return; }
      if (act === 'save-entity') { saveEntity(); return; }
      if (act === 'del-entity') { deleteEntity(); return; }
      if (act === 'edit-world') { openWorldForm(D.worldRules.filter(function (x) { return x.id === id; })[0]); return; }
      if (act === 'save-world') { saveWorld(); return; }
      if (act === 'del-world') { deleteWorld(); return; }
      if (act === 'edit-fs') { openFsForm(D.foreshadows.filter(function (x) { return x.id === id; })[0]); return; }
      if (act === 'save-fs') { saveFs(); return; }
      if (act === 'del-fs') { deleteFs(); return; }
      if (act === 'preset') {
        var pr = PRESETS.filter(function (p) { return p.id === id; })[0];
        if (!pr) return;
        $('#fBase').value = pr.baseURL;
        ['fSlotDraft', 'fSlotSummary', 'fSlotExtract', 'fSlotReview'].forEach(function (f) { $(('#' + f)).value = pr.model; });
        $('#fIn').value = pr.priceIn;
        $('#fOut').value = pr.priceOut;
        toast('已填入 ' + pr.label + ' 的默认值');
        return;
      }
      if (act === 'toggle-key') {
        var inp = $('#fKey');
        if (inp.type === 'password') { inp.type = 'text'; actEl.textContent = '隐藏'; }
        else { inp.type = 'password'; actEl.textContent = '显示'; }
        return;
      }
      if (act === 'test-llm') { testLlm(); return; }
      if (act === 'backup-now') {
        S.backup('manual').then(function () { refreshBackupBox(); toast('已备份一份到备份目录'); })
          .catch(function (e) { toast('备份失败：' + (e && e.message || e)); });
        return;
      }
      if (act === 'open-backups') {
        S.openBackups().then(function (r) {
          if (r && r.ok === false) toast('浏览器版没有备份目录，备份在 localStorage 里');
        }).catch(function () { });
        return;
      }
      if (act === 'path-open') {
        S.pathsOpen(actEl.getAttribute('data-dir') || '').then(function (r) {
          if (r && r.ok === false) toast((r && r.note) || '打不开这个目录');
        }).catch(function (e) { toast('打不开：' + (e && e.message || e)); });
        return;
      }
      if (act === 'path-move-data') { movePath('data'); return; }
      if (act === 'path-move-backups') { movePath('backups'); return; }
      if (act === 'path-reset') {
        S.resetPaths().then(function () {
          refreshPathBox();
          toast('已恢复默认位置，重启应用后生效。');
        }).catch(function (e) { toast('恢复失败：' + (e && e.message || e)); });
        return;
      }
      if (act === 'style-analyze') { styleAnalyze(); return; }
      if (act === 'style-save') { saveStyle(); return; }
      if (act === 'save-settings') {
        state.settings = collectSettings();
        persistSettings(state.settings);
        applyLite();
        closeModal();
        renderAll();
        toast(state.settings.lite ? '已保存。精简模式已开启：右侧栏收起了。' : '已保存。Key 不出本机。');
        return;
      }
      if (act === 'clear-key') {
        state.settings.apiKey = '';
        persistSettings(state.settings);
        if (window.sfBridge && window.sfBridge.clearKey) window.sfBridge.clearKey();
        var kh = $('#keyHint');
        if (kh) kh.textContent = 'Key 已清除。生成会退回示例文本。';
        renderAll();
        toast('已清除 Key');
        return;
      }
      if (act === 'reset-data') {
        // 不用原生 confirm：Electron 下它会阻塞渲染进程，二次点击更稳
        if (!state.confirmReset) {
          state.confirmReset = true;
          actEl.textContent = '再点一次确认（4 秒内）';
          setTimeout(function () {
            state.confirmReset = false;
            if (actEl.isConnected) actEl.textContent = '清空全部数据';
          }, 4000);
          return;
        }
        state.confirmReset = false;
        S.resetAll().then(function () { return S.init(); }).then(function (res) {
          state.projects = res.projects || [];
          closeModal();
          return openProject(res.activeProjectId, { toast: '已清空，回到示例项目' });
        }).catch(function (err) { toast('清空失败：' + (err && err.message || err)); });
        return;
      }

      /* 正文相关 */
      if (act === 'chat-send') { sendChat(); return; }
    if (act === 'chat-stop') {
      if (state.chatRun && state.chatRun.cancel) { try { state.chatRun.cancel(); } catch (e) { } }
      state.chatBusy = false;
      state.chatRun = null;
      renderRight();
      return;
    }
    if (act === 'chat-clear') { state.chat = []; state.chatBusy = false; state.chatRun = null; renderRight(); return; }
    if (act === 'chat-apply') { applyChatEdits(+actEl.getAttribute('data-i')); return; }

    if (act === 'gen' || act === 'expand') { startGen(); return; }
      if (act === 'stop') { stopGen(); return; }
      if (act === 'reject') { state.gen.text = ''; state.gen.done = false; renderRight(); toast('已拒绝，正文未改动'); return; }
      if (act === 'accept') { acceptGen(); return; }
      if (act === 'apply-gen') { applyGen(); return; }
      if (act === 'undo-accept') { undoAccept(); return; }
      if (act === 'blk-add') { addBlockAfter(id); return; }
      if (act === 'blk-img') { pickImage(id); return; }
      if (act === 'load-more') { loadMoreBlocks(); return; }
      if (act === 'blk-del') { delBlock(id); return; }
      if (act === 'blk-hist') { openBlockHistory(id); return; }
      if (act === 'blk-rewrite') { startRewrite(id); return; }
      if (act === 'merge-apply') { applyMerge(); return; }
      if (act === 'merge-pick') { pickMerge(parseInt(actEl.getAttribute('data-i'), 10), actEl.getAttribute('data-opt')); return; }
      if (act === 'ch-history') { openChapterHistory(); return; }
      if (act === 'rollback') { rollbackTo(parseInt(actEl.getAttribute('data-rev'), 10)); return; }
      if (act === 'summarize') { summarizeCur(); return; }
      if (act === 'extract-llm') { runExtract(); return; }
      if (act === 'review-run') { runReview(); return; }
      if (act === 'review-drop') {
        var ri = +actEl.getAttribute('data-i');
        if (state.review && state.review.items[ri]) {
          state.review.items.splice(ri, 1);
          renderRight();
          toast('已划掉这一条（只影响这一栏，不动规则）');
        }
        return;
      }
      if (act === 'check') { renderAll(); toast('体检完成：' + state.issues.length + ' 条'); return; }
      if (act === 'jump') { locate(actEl.getAttribute('data-block')); return; }
      if (act === 'ignore') {
        var idx = +actEl.getAttribute('data-idx');
        var it = state.issues[idx];
        if (it) {
          var bid = it.evidence && it.evidence[0] ? it.evidence[0].blockId : null;
          /* 绑内容哈希：这一段的字改了，忽略就自动失效，规则会重新报出来 */
          var blk = bid ? findBlock(bid) : null;
          D.waivers.push({
            ruleId: it.ruleId, key: it.coalesce,
            blockId: bid,
            textHash: blk && R.hashText ? R.hashText(blk.text) : null,
            expired: false
          });
          S.saveWaivers(pid, D.waivers);
          renderAll();
          toast('已忽略这一条（改动这段文字后会自动重报）');
        }
        return;
      }
      if (act === 'confirm-all') {
        D.proposedStates.forEach(function (p) { p.checked = true; });
        S.saveGate(pid, gateMap());
        renderRight();
        toast('已确认 ' + D.proposedStates.length + ' 项，下一章上下文已更新');
        return;
      }
      if (act === 'later') { toast('已保留为待确认，右栏会显示角标'); return; }
      if (act === 'hint-review') { toast('规则栏只报可证实的错；软性建议在 v0.2 的参考栏'); return; }
      return;
    }

    /* 左栏条目（章节 / 资料卡） */
    var reelCard = e.target.closest('.reel-card');
    if (reelCard) {
      reelPick(+reelCard.getAttribute('data-reel'));
      return;
    }
    var chItem = e.target.closest('.chapter-item');
    if (chItem) {
      flushSave();
      state.chapterId = chItem.getAttribute('data-ch');
      state.gen = { running: false, text: '', done: false, runId: null, usedApi: false, timer: null };
      S.setKv(pid, 'lastChapterId', state.chapterId);
      renderAll();
      $('#editor').scrollTop = 0;
      return;
    }

    var blockRef = e.target.closest('[data-block]');
    if (blockRef) locate(blockRef.getAttribute('data-block'));
  });

  document.addEventListener('change', function (e) {
    if (e.target && e.target.id === 'fileImport') {
      var f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!f) return;
      var fr = new FileReader();
      fr.onload = function () {
        var obj = null;
        try { obj = JSON.parse(String(fr.result)); } catch (err) { toast('这个文件不是 JSON'); return; }
        importPackage(obj);
      };
      fr.readAsText(f);
      return;
    }
    var g = e.target.closest('[data-gate]');
    if (g) {
      var p = D.proposedStates.filter(function (x) { return x.id === g.getAttribute('data-gate'); })[0];
      if (p) p.checked = g.checked;
      S.saveGate(pid, gateMap());
      var unchecked = D.proposedStates.filter(function (x) { return !x.checked; }).length;
      var head = $('.rblock[data-fold="gate"] .count');
      if (head) head.textContent = !D.proposedStates.length ? '还没有待确认' : (unchecked ? unchecked + ' 项待确认' : '全部已确认');
    }
  });

  /* 编辑正文：不重渲染，避免光标丢失。
     输入法组字期间（compositionstart → compositionend）绝不落库、不重算规则：
     那时候 innerText 是半成品，存下来会把拼音字母混进正文里。 */
  document.addEventListener('compositionstart', function (e) {
    if (e.target.closest && e.target.closest('.blk')) state.composing = true;
  });
  document.addEventListener('compositionend', function (e) {
    var blk = e.target.closest && e.target.closest('.blk');
    if (!blk) return;
    state.composing = false;
    syncBlockFromDom(blk, { pushUndo: true });
  });

  function syncBlockFromDom(blk, opts) {
    var id = blk.getAttribute('data-id');
    var c = cur();
    if (!c) return;
    var b = c.blocks.filter(function (x) { return x.id === id; })[0];
    if (!b) return;
    if (opts && opts.pushUndo) pushUndo(c);
    b.text = blk.innerText.replace(/\n+$/, '');
    if (c.status === 'planned') c.status = 'draft';
    renderTop();
    renderStatus();
    scheduleSave();
  }

  document.addEventListener('input', function (e) {
    var blk = e.target.closest('.blk');
    if (!blk) return;
    /* 组字中：先记账，不落库 */
    if (e.isComposing || e.inputType === 'insertCompositionText' || state.composing) {
      var id = blk.getAttribute('data-id');
      var c0 = cur();
      var b0 = c0 && c0.blocks.filter(function (x) { return x.id === id; })[0];
      if (b0) b0.text = blk.innerText;
      return;
    }
    syncBlockFromDom(blk, { pushUndo: true });
  });

  /* ---------------- 撤销栈 ----------------
     浏览器的原生 undo 会被我们的 DOM 重渲染打断，所以自己记。
     每 700ms 的连续输入算一"步"：只在一步的开头存快照，撤销一次退一整步，
     而不是把每个字符都退一遍。上限 60 步，按章分开。 */
  var UNDO_STEP_MS = 700;
  var UNDO_MAX = 60;

  function snapOf(c) {
    return JSON.stringify((c.blocks || []).map(function (b) {
      return { id: b.id, text: b.text, src: b.src || 'human' };
    }));
  }

  function pushUndo(c) {
    var now = Date.now();
    if (now - (state.undoAt || 0) < UNDO_STEP_MS) return;
    var snap = snapOf(c);
    if (state.undoSnap === snap) return;
    state.undoAt = now;
    state.undoSnap = snap;
    state.undo.push({ chapterId: c.id, text: snap, at: now });
    if (state.undo.length > UNDO_MAX) state.undo.shift();
    state.redo.length = 0;
  }

  function applySnap(c, text) {
    var arr = JSON.parse(text);
    var meta = {};
    (c.blocks || []).forEach(function (b) { meta[b.id] = b; });
    c.blocks = arr.map(function (x) {
      var old = meta[x.id] || {};
      var out = Object.assign({}, old, { id: x.id, text: x.text, src: x.src || old.src || 'human' });
      delete out.meta;
      return out;
    });
    state.undoSnap = text;
    renderCenter();
    scheduleSave();
  }

  function undoEdit() {
    var c = cur();
    if (!c) return;
    var i = state.undo.length - 1;
    while (i >= 0 && state.undo[i].chapterId !== c.id) i--;
    if (i < 0) { toast('这一章没有可撤销的操作'); return; }
    var step = state.undo.splice(i, 1)[0];
    state.redo.push({ chapterId: c.id, text: snapOf(c), at: Date.now() });
    applySnap(c, step.text);
    toast('已撤销一步');
  }

  function redoEdit() {
    var c = cur();
    if (!c) return;
    var i = state.redo.length - 1;
    while (i >= 0 && state.redo[i].chapterId !== c.id) i--;
    if (i < 0) { toast('没有可重做的操作'); return; }
    var step = state.redo.splice(i, 1)[0];
    state.undo.push({ chapterId: c.id, text: snapOf(c), at: Date.now() });
    applySnap(c, step.text);
    toast('已重做一步');
  }
  document.addEventListener('paste', function (e) {
    var blk = e.target.closest('.blk');
    if (!blk) return;
    e.preventDefault();
    var text = (e.clipboardData || window.clipboardData).getData('text').replace(/\s*\n\s*/g, '');
    document.execCommand('insertText', false, text);
  });
  document.addEventListener('keydown', function (e) {
    /* 阅读器 / 书库先拿键盘：它们要拦 Esc、←→、↑↓，交给下面那条通用链会被拆段或翻滚轮 */
    if (window.SFReader && window.SFReader.keys && window.SFReader.keys(e)) return;
    if (typeof state.shelfKeys === 'function' && state.shelfKeys(e)) { e.preventDefault(); return; }
    if (window.SFLibrary && window.SFLibrary.keys && window.SFLibrary.keys(e)) return;
    if (e.key === 'Escape' && $('#modal').classList.contains('open')) { closeModal(); return; }
    /* 对话输入框：Enter 发送、Shift+Enter 换行（组字期间不拦） */
    if (e.target && e.target.id === 'chatIn' && e.key === 'Enter' && !e.shiftKey &&
      !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      sendChat();
      return;
    }
    /* 输入法组字期间的回车不能拆块，否则中文打字会一段一段断掉 */
    if (e.isComposing || e.keyCode === 229) return;
    var blkEl = e.target.closest && e.target.closest('.blk');
    var inField = e.target.closest && e.target.closest('input, textarea');
    /* 撤销 / 重做：只在正文里接管，表单里的交给浏览器 */
    if (!inField && (e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      if (e.shiftKey) redoEdit(); else undoEdit();
      return;
    }
    if (!inField && (e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) {
      e.preventDefault();
      redoEdit();
      return;
    }
    if (blkEl && e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      splitBlockAt(blkEl.getAttribute('data-id'), caretOffsetIn(blkEl));
      return;
    }
    /* 滚轮视图：↑↓ 换一张（按住不放时别以键盘重复速率连跳） */
    if (state.sideView === 'wheel' && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.target.closest('input, textarea')) {
      e.preventDefault();
      var t = Date.now();
      if (t - (state.reelKeyAt || 0) < 120) return;
      state.reelKeyAt = t;
      reelStep(e.key === 'ArrowUp' ? -1 : 1);
    }
  });

  /* 滚轮视图：鼠标滚轮换一张。
     触控板会一次吐几十个小 delta，直接"一格一格"跳会很生硬；
     所以先攒位移，超过阈值才走一张，冷却 90ms 防止连跳。 */
  document.addEventListener('wheel', function (e) {
    if (state.sideView !== 'wheel') return;
    if (!e.target.closest || !e.target.closest('#leftBody')) return;
    e.preventDefault();
    var dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 18;
    else if (e.deltaMode === 2) dy *= 400;
    state.reelAcc = (state.reelAcc || 0) + dy;
    var now = Date.now();
    if (now - (state.reelCool || 0) < 75) {            // 正在滑，先攒着（但别攒成雪球）
      state.reelAcc = Math.max(-120, Math.min(120, state.reelAcc));
      return;
    }
    if (Math.abs(state.reelAcc) < 42) return;          // 还不到一格
    var dir = state.reelAcc > 0 ? 1 : -1;
    state.reelAcc = 0;
    state.reelCool = now;
    try { reelStep(dir); }
    catch (err) { toast('滚轮切换出错：' + (err && err.message || err)); }
  }, { passive: false });

  /* ---------------- 启动 ---------------- */

  S.onStatus(function (st) {
    state.saveState = st.state;
    if (st.state === 'saved') state.savedAt = st.at;
    if (st.state === 'error' && window.console) console.error('[store]', st.error);
    if (D) renderStatus();
  });

  /* 只订阅一次：llm.js 支持多监听器，生成与文风分析共用同一条事件流，靠 runId 分流 */
  L.onEvent(onLlmEvent);

  window.addEventListener('beforeunload', function () {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; try { flushSave(); } catch (e) { } }
    S.flush();
  });

  function renderFatal(err) {
    var rp = document.getElementById('rightPane');
    if (rp) rp.textContent = 'RENDER ERROR: ' + (err && err.message) + '\n' + ((err && err.stack) || '');
  }

  /* 自检用：Electron 的 --selftest 会读这个快照，证明"界面正在用什么数据" */
  window.SFApp = {
    /* 对话面板的调试入口（自检/手工验证用，不影响正常流程） */
    chat: {
      send: function () { return sendChat(); },
      apply: function (i) { return applyChatEdits(i); },
      state: function () { return state.chat; },
      push: function (m) { state.chat.push(m); if (window.SFApp && window.SFApp.chat) renderRight(); return state.chat.length; }
    },
    snapshot: function () {
      return {
        projectId: pid,
        projectName: D ? D.project.name : null,
        projects: state.projects.length,
        chapters: chapters().length,
        chapterId: state.chapterId,
        blocks: chapters().reduce(function (a, c) { return a + c.blocks.length; }, 0),
        words: totalWords(),
        entities: D ? D.entities.length : 0,
        worldRules: D ? D.worldRules.length : 0,
        foreshadows: D ? D.foreshadows.length : 0,
        issues: state.issues.length,
        backend: S.backend,
        rev: cur() ? (cur().rev || 1) : null,
        summary: cur() ? (cur().summary || '') : ''
      };
    },
    debug: function () { return { state: state, data: D }; },
    reload: function () { return boot(); },
    /* 书库 / 阅读器是两个独立文件，DOM 小件复用它俩，不要各写一套 */
    ui: {
      esc: esc,
      toast: toast,
      openModal: openModal,
      openModalTitled: openModalTitled,
      closeModal: closeModal,
      $: $,
      $$: $$
    }
  };

  /* 编辑器滚到底就续渲染下一批段落（长章节不用一次画完） */
  function bindEditorScroll() {
    var box = $('#editor');
    if (!box || box._sfBound) return;
    box._sfBound = true;
    box.addEventListener('scroll', function () {
      if (box.scrollTop + box.clientHeight < box.scrollHeight - 200) return;
      var c = cur();
      if (!c || (state.renderLimit || 80) >= c.blocks.length) return;
      loadMoreBlocks();
    });
  }

  function boot() {
    return S.init().then(function (res) {
      state.projects = res.projects || [];
      var first = res.activeProjectId || (state.projects[0] && state.projects[0].id);
      if (!first) { renderEmptyHome(); return null; }
      return openProject(first);
    }).then(function () {
      applyLite();
      bindEditorScroll();
      if (window.sfBridge && window.sfBridge.loadKey) {
        return window.sfBridge.loadKey().then(function (k) {
          if (k) state.settings.apiKey = k;
          renderRight();
        }).catch(function () { });
      }
    }).catch(renderFatal);
  }

  /* ---------------- 一个项目都没有时的欢迎页 ---------------- */

  function hideEmptyHome() {
    var box = $('#emptyHome');
    if (box) box.hidden = true;
    document.body.classList.remove('is-empty');
  }

  function renderEmptyHome() {
    var box = $('#emptyHome');
    if (!box) return;
    D = null;
    document.body.classList.add('is-empty');
    $('#projName').textContent = '还没有项目';
    $('#projMeta').textContent = '';
    $('#totalWc').innerHTML = '';
    $('#leftBody').innerHTML = '';
    $('#chapterHead').innerHTML = '';
    $('#editorInner').innerHTML = '';
    $('#statusBar').innerHTML = '';
    $('#rightPane').innerHTML = '';
    box.innerHTML = '' +
      '<div class="eh-card">' +
      '<div class="eh-art">' +
      '<svg viewBox="0 0 220 150" width="220" height="150" aria-hidden="true">' +
      '<path d="M110 34c-18-10-40-12-58-8v84c18-4 40-2 58 8 18-10 40-12 58-8V26c-18-4-40-2-58 8z" ' +
      'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>' +
      '<path d="M110 34v84" stroke="currentColor" stroke-width="1.6"/>' +
      '<path d="M62 52c14-2 28 0 38 5M62 68c14-2 28 0 38 5M62 84c14-2 28 0 38 5" ' +
      'stroke="currentColor" stroke-width="1.2" stroke-linecap="round" opacity=".55"/>' +
      '<path d="M158 52c-14-2-28 0-38 5M158 68c-14-2-28 0-38 5" ' +
      'stroke="currentColor" stroke-width="1.2" stroke-linecap="round" opacity=".55"/>' +
      '<path d="M150 118l16-16 7 7-16 16-9 2z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>' +
      '<path d="M84 20l4-9M104 14l2-8M124 20l-4-9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" opacity=".4"/>' +
      '</svg>' +
      '</div>' +
      '<h1>从一句话开始，写到一个能发出去的短篇</h1>' +
      '<p class="eh-sub">StoryForge 不替你决定剧情。它把想法拆成章节卡，帮你把草稿写出来，再用规则守住设定不崩。</p>' +
      '<div class="eh-acts">' +
      '<button class="btn primary lg" data-act="new-project">新建项目</button>' +
      '<button class="btn lg" data-act="load-demo">载入示例项目</button>' +
      '<button class="btn ghost lg" data-act="import-pkg">导入项目包</button>' +
      '</div>' +
      '<div class="eh-foot">' +
      '数据存在' + (S.backend === 'sqlite' ? '本机 SQLite（' + (S.status && S.status.file ? S.status.file : '%APPDATA%\\storyforge') + '）' : '浏览器本地') +
      ' · Key 不出本机 · 随时可导出项目包' +
      '</div>' +
      '</div>';
    box.hidden = false;
  }

  function loadDemoProject() {
    var demo = SEED.demoPayload();
    return S.createProject(demo).then(function (np) {
      return S.init();
    }).then(function (res) {
      state.projects = res.projects || [];
      return openProject(demo.project.id, { toast: '示例项目已载入' });
    }).catch(function (e) { toast('载入失败：' + (e && e.message || e)); });
  }

  function importPackage(payload) {
    if (!payload || payload.format !== 'storyforge.package') {
      toast('这不像是 StoryForge 项目包');
      return;
    }
    var p = payload.project || {};
    var id = SEED.uid('p');
    var proj = Object.assign({}, p, { id: id, name: (p.name || '导入的项目'), isDemo: false });
    /* block id 是数据库主键：导入必须换新号，否则会把同一个库里的原项目覆盖掉 */
    var idMap = {};
    var chapters = (payload.chapters || []).map(function (c, i) {
      var n = Object.assign({}, c);
      n.id = SEED.uid('c');
      n.idx = i + 1;
      n.blocks = (c.blocks || []).map(function (b) {
        var nb = Object.assign({}, b);
        var fresh = SEED.uid('b');
        idMap[b.id] = fresh;
        nb.id = fresh;
        return nb;
      });
      return n;
    });
    function remap(x) { return x && idMap[x] ? idMap[x] : x; }
    var full = {
      project: proj,
      chapters: chapters,
      entities: (payload.entities || []).map(function (e) { var x = Object.assign({}, e); x.id = SEED.uid('e'); return x; }),
      worldRules: (payload.worldRules || []).map(function (w) { var x = Object.assign({}, w); x.id = SEED.uid('w'); return x; }),
      foreshadows: (payload.foreshadows || []).map(function (f) {
        var x = Object.assign({}, f);
        x.id = SEED.uid('f');
        if (x.plantedBlock) x.plantedBlock = remap(x.plantedBlock);
        return x;
      }),
      confirmedStates: (payload.confirmedStates || []).map(function (s) {
        var x = Object.assign({}, s);
        x.id = SEED.uid('cs');
        x.block = remap(x.block);
        return x;
      }),
      proposedStates: (payload.proposedStates || []).map(function (s) {
        var x = Object.assign({}, s);
        x.id = SEED.uid('ps');
        x.block = remap(x.block);
        return x;
      }),
      waivers: (payload.waivers || []).map(function (w) {
        var x = Object.assign({}, w);
        x.blockId = remap(x.blockId);
        return x;
      }),
      kv: {}
    };
    S.createProject(full).then(function () {
      return S.init();
    }).then(function (res) {
      state.projects = res.projects || [];
      closeModal();
      return openProject(id, { toast: '已导入「' + proj.name + '」' });
    }).catch(function (e) { toast('导入失败：' + (e && e.message || e)); });
  }

  boot().then(function () {
    setTimeout(function () {
      if (!D) return;
      toast(S.backend === 'sqlite'
        ? '数据已写入 SQLite（' + state.projects.length + ' 个项目）。刷新、关窗都不会丢。'
        : '数据存在浏览器本地。刷新不会丢；装 Electron 后换成 SQLite。');
    }, 900);
  });
})();
