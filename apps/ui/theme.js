/* StoryForge — 外观（背景色 / 玻璃态 / 色卡滚轮）
   纯变量驱动：这里只负责算出 CSS 变量并写到 <html> 上，具体长相全在 styles.css。
   放在 app.js 之前加载，boot 时先应用一次，避免"先米色后变深色"的闪。 */
(function () {
  'use strict';

  var KEY = 'sf.theme.v1';

  /* 色卡：name 显示在卡片左上角；hex 是背景色；accent 是这套背景上的强调色（按钮/选中态） */
  var PALETTE = [
    { name: '米白', hex: '#f6f4f0', accent: '#2f6b5f' },
    { name: '奶油', hex: '#f6ecd4', accent: '#8a6a2f' },
    { name: '杏仁', hex: '#f5e6cf', accent: '#9a5f38' },
    { name: '砂岩', hex: '#e8d9c2', accent: '#7d5a3c' },
    { name: '陶土', hex: '#e0bda4', accent: '#a8503a' },
    { name: '玫瑰', hex: '#eccfcd', accent: '#9c4557' },
    { name: '鼠尾草', hex: '#d5e0cb', accent: '#4b7052' },
    { name: '苔绿', hex: '#c2d6bb', accent: '#3c6b47' },
    { name: '湖水', hex: '#c3dcdb', accent: '#2b6b74' },
    { name: '雾蓝', hex: '#cdd9ea', accent: '#3a5f8f' },
    { name: '靛青', hex: '#b9c6de', accent: '#3b4f80' },
    { name: '可可', hex: '#dcc8b6', accent: '#6b4a37' },
    { name: '夜蓝', hex: '#2b3444', accent: '#7d9bc4' },
    { name: '墨绿', hex: '#22332f', accent: '#6ea08c' },
    { name: '炭灰', hex: '#302d2b', accent: '#b3a89b' }
  ];

  var state = { bg: PALETTE[0].hex, accent: PALETTE[0].accent, glass: false, sel: 0 };

  /* ---------- 颜色小工具 ---------- */

  function parse(hex) {
    var h = String(hex || '').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    if (isNaN(n)) return { r: 246, g: 244, b: 240 };
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function hex(c) {
    function p(v) { var s = Math.max(0, Math.min(255, Math.round(v))).toString(16); return s.length === 1 ? '0' + s : s; }
    return '#' + p(c.r) + p(c.g) + p(c.b);
  }
  function mix(a, b, t) {
    var A = parse(a), B = parse(b);
    return hex({ r: A.r + (B.r - A.r) * t, g: A.g + (B.g - A.g) * t, b: A.b + (B.b - A.b) * t });
  }
  function shade(h, amt) { return mix(h, amt < 0 ? '#000000' : '#ffffff', Math.abs(amt)); }
  function rgba(h, a) { var c = parse(h); return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + a + ')'; }
  function luminance(h) {
    var c = parse(h);
    function f(v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  }
  function isDark(h) { return luminance(h) < 0.42; }

  /* ---------- 算变量并落盘 ---------- */

  function vars() {
    var dark = isDark(state.bg);
    var v = {};
    v['--bg'] = state.bg;
    v['--bg-deep'] = shade(state.bg, dark ? -0.18 : -0.06);
    v['--accent'] = state.accent;
    v['--accent-ink'] = dark ? '#101418' : '#ffffff';

    if (!state.glass) {
      v['--paper'] = dark ? mix(state.bg, '#ffffff', 0.07) : mix(state.bg, '#ffffff', 0.76);
      v['--surface'] = v['--paper'];
      v['--surface-2'] = dark ? mix(state.bg, '#ffffff', 0.04) : mix(state.bg, '#ffffff', 0.5);
      v['--glass-blur'] = '0px';
    } else {
      v['--paper'] = dark ? rgba('#ffffff', 0.07) : rgba('#ffffff', 0.52);
      v['--surface'] = dark ? rgba('#ffffff', 0.05) : rgba('#ffffff', 0.34);
      v['--surface-2'] = dark ? rgba('#ffffff', 0.09) : rgba('#ffffff', 0.6);
      v['--glass-blur'] = '18px';
    }

    v['--line'] = dark ? mix(state.bg, '#ffffff', 0.16) : shade(state.bg, -0.1);
    v['--line-strong'] = dark ? mix(state.bg, '#ffffff', 0.26) : shade(state.bg, -0.18);
    v['--hover'] = dark ? rgba('#ffffff', 0.07) : shade(state.bg, -0.035);
    v['--chip'] = dark ? rgba('#ffffff', 0.1) : shade(state.bg, -0.055);
    v['--accent-line'] = dark ? mix(state.accent, state.bg, 0.6) : mix(state.accent, '#ffffff', 0.72);
    v['--warn-soft'] = dark ? rgba('#d8b163', 0.16) : mix('#a97a17', '#ffffff', 0.86);
    v['--info-soft'] = dark ? rgba('#8fb4d8', 0.16) : mix('#3f6f9e', '#ffffff', 0.88);
    v['--danger-soft'] = dark ? rgba('#e08a72', 0.16) : mix('#b4462f', '#ffffff', 0.88);
    v['--selline'] = dark ? rgba('#ffffff', 0.22) : 'rgba(255,255,255,.72)';
    v['--ink'] = dark ? '#eae5db' : '#221f1b';
    v['--ink-2'] = dark ? '#c7c1b6' : '#56504a';
    v['--muted'] = dark ? '#968f84' : '#8e867b';
    v['--accent-soft'] = dark ? mix(state.accent, state.bg, 0.78) : mix(state.accent, '#ffffff', 0.88);
    v['--shadow'] = dark
      ? '0 1px 2px rgba(0,0,0,.4), 0 8px 22px rgba(0,0,0,.32)'
      : '0 1px 2px rgba(40,34,26,.05), 0 6px 18px rgba(40,34,26,.05)';
    v['--danger'] = dark ? '#e08a72' : '#b4462f';
    v['--warn'] = dark ? '#d8b163' : '#a97a17';
    v['--info'] = dark ? '#8fb4d8' : '#3f6f9e';
    return v;
  }

  function apply() {
    var root = document.documentElement;
    var v = vars();
    Object.keys(v).forEach(function (k) { root.style.setProperty(k, v[k]); });
    root.setAttribute('data-theme', isDark(state.bg) ? 'dark' : 'light');
    root.setAttribute('data-glass', state.glass ? '1' : '0');
    root.style.setProperty('--bg-a', rgba(state.bg, 0.92));
    /* 玻璃态需要一点深度，否则"毛玻璃"后面什么都没有 */
    if (state.glass) {
      root.style.setProperty('--bg-art',
        'radial-gradient(1100px 620px at 10% -10%, ' + shade(state.bg, 0.34) + ' 0%, transparent 62%),' +
        'radial-gradient(900px 560px at 104% 4%, ' + mix(state.bg, state.accent, 0.34) + ' 0%, transparent 58%),' +
        'linear-gradient(160deg, ' + state.bg + ' 0%, ' + shade(state.bg, -0.16) + ' 100%)');
      root.setAttribute('data-art', '1');
    } else {
      root.style.setProperty('--bg-art', 'none');
      root.removeAttribute('data-art');
    }
  }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* 隐私模式：不存也能用 */ }
  }

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return;
      var o = JSON.parse(raw);
      if (o && o.bg) {
        state.bg = o.bg;
        state.accent = o.accent || accentFor(o.bg);
        state.glass = !!o.glass;
        state.sel = typeof o.sel === 'number' ? o.sel : -1;
      }
    } catch (e) { /* 存储坏了就当没设置过 */ }
  }

  function accentFor(h) {
    var hit = PALETTE.filter(function (p) { return p.hex.toLowerCase() === String(h).toLowerCase(); })[0];
    if (hit) return hit.accent;
    /* 自定义色：按明度给一个能看清的强调色 */
    return isDark(h) ? mix(h, '#ffffff', 0.55) : shade(mix(h, '#000000', 0.35), -0.25);
  }

  function set(patch, opts) {
    if (patch.bg) { state.bg = patch.bg; state.accent = opts && opts.accent ? opts.accent : accentFor(patch.bg); }
    if (patch.accent) state.accent = patch.accent;
    if (typeof patch.glass === 'boolean') state.glass = patch.glass;
    if (typeof patch.sel === 'number') state.sel = patch.sel;
    apply();
    if (!opts || opts.persist !== false) save();
  }

  /* ---------- 色卡滚轮 ---------- */

  var CARD_W = 104, CARD_H = 132, RADIUS = 344, STEP = 17;

  function wheelHtml() {
    return '' +
      '<div class="wheel-block">' +
        '<div class="wheel" id="sfWheel">' +
          '<div class="wheel-arc"></div>' +
          '<div class="wheel-cards" id="sfWheelCards">' +
            PALETTE.map(function (p, i) {
              return '<button class="swcard" data-card="' + i + '" style="--own:' + p.hex + '">' +
                '<span class="nm">' + p.name + '</span>' +
                '<i class="sw" style="background:' + p.hex + '"></i>' +
                '<span class="hx">' + p.hex + '</span>' +
                '</button>';
            }).join('') +
          '</div>' +
          '<div class="wheel-mask"></div>' +
        '</div>' +
        '<div class="wheel-label"><b id="sfWheelName">' + PALETTE[0].name + '</b>' +
          '<span id="sfWheelHex">' + PALETTE[0].hex + '</span></div>' +
        '<div class="wheel-hint">滚轮 / 拖动 / 方向键切换 · 卡片上提的是当前选中的颜色</div>' +
      '</div>';
  }

  function wheelLayout(root) {
    var cards = root.querySelectorAll('.swcard');
    var sel = state.sel;
    var N = PALETTE.length;
    for (var i = 0; i < cards.length; i++) {
      var el = cards[i];
      /* 圆环是首尾相接的：选第 0 张时，左边那几张来自色板末尾，视觉上才两边对称 */
      var d = i - sel;
      if (sel >= 0) {
        if (d > N / 2) d -= N;
        if (d < -N / 2) d += N;
      }
      var a = d * STEP;
      var far = Math.abs(a);
      var rad = a * Math.PI / 180;
      var x = Math.sin(rad) * RADIUS;
      var y = -Math.cos(rad) * RADIUS;
      var lift = (i === sel) ? -22 : 0;
      var scale = (i === sel) ? 1.08 : 1;
      el.style.transform = 'translate(-50%,-50%) translate(' + x.toFixed(2) + 'px,' + (y + lift).toFixed(2) + 'px) rotate(' +
        (a * 0.5).toFixed(2) + 'deg) scale(' + scale + ')';
      el.style.zIndex = String(200 - Math.abs(d));
      el.style.opacity = far > 76 ? '0' : String(Math.max(0.22, 1 - far / 84));
      el.classList.toggle('on', i === sel);
      el.disabled = far > 84;
    }
    var nm = root.querySelector('#sfWheelName');
    var hx = root.querySelector('#sfWheelHex');
    if (nm && hx) {
      if (sel >= 0 && PALETTE[sel]) {
        nm.textContent = PALETTE[sel].name;
        hx.textContent = PALETTE[sel].hex;
      } else {
        nm.textContent = '自定义';
        hx.textContent = state.bg;
      }
    }
  }

  /* root = 弹窗内容容器；onPick 由 app.js 传入（用来刷新按钮等） */
  function bindWheel(root, onPick) {
    if (!root) return;
    var wheel = root.querySelector('#sfWheel');
    if (!wheel) return;

    function pick(i) {
      if (i < 0) i = 0;
      if (i > PALETTE.length - 1) i = PALETTE.length - 1;
      if (i === state.sel) return;
      set({ bg: PALETTE[i].hex, sel: i }, { accent: PALETTE[i].accent });
      wheelLayout(root);
      syncControls(root);
      if (onPick) onPick();
    }

    wheel.addEventListener('click', function (e) {
      var card = e.target.closest('.swcard');
      if (card) pick(+card.getAttribute('data-card'));
    });

    wheel.addEventListener('wheel', function (e) {
      e.preventDefault();
      pick(state.sel + (e.deltaY > 0 ? 1 : -1));
    }, { passive: false });

    var dragging = false, startX = 0, startSel = 0, moved = 0;
    wheel.addEventListener('pointerdown', function (e) {
      dragging = true; moved = 0; startX = e.clientX; startSel = state.sel;
      wheel.setPointerCapture(e.pointerId);
      wheel.classList.add('dragging');
    });
    wheel.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var dx = e.clientX - startX;
      moved = Math.max(moved, Math.abs(dx));
      var step = Math.round(-dx / 42);
      if (step !== 0 && startSel + step !== state.sel) pick(startSel + step);
    });
    wheel.addEventListener('pointerup', function (e) {
      dragging = false;
      wheel.classList.remove('dragging');
      try { wheel.releasePointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    });

    wheelLayout(root);
    syncControls(root);
  }

  function syncControls(root) {
    var dark = root.querySelector('#sfGlass');
    if (dark) dark.checked = state.glass;
    var pick = root.querySelector('#sfCustom');
    if (pick) pick.value = state.bg;
    var hexIn = root.querySelector('#sfHex');
    if (hexIn) hexIn.value = state.bg;
    var rows = root.querySelectorAll('[data-preset]');
    for (var i = 0; i < rows.length; i++) {
      var key = rows[i].getAttribute('data-preset');
      var on = (key === 'glass' && state.glass) || (key === 'solid' && !state.glass);
      rows[i].classList.toggle('on', !!on);
    }
  }

  window.SFTheme = {
    palette: PALETTE,
    state: state,
    init: function () { load(); apply(); return state; },
    apply: apply,
    set: set,
    isDark: isDark,
    mix: mix,
    shade: shade,
    rgba: rgba,
    accentFor: accentFor,
    wheelHtml: wheelHtml,
    bindWheel: bindWheel,
    layout: wheelLayout,
    syncControls: syncControls,
    save: save
  };

  /* 尽早应用：脚本在 body 末尾加载，此时 DOM 已有，直接上色 */
  try { load(); apply(); } catch (e) { /* 出错也不该挡住应用启动 */ }
})();
