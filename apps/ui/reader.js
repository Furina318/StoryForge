/* StoryForge — 阅读视图
 *
 * 为什么不是弹窗：阅读要占满整个窗口（弹窗有 80vh 上限并且点空白就关，
 * styles.css:276 + app.js:3106），所以这里是 body 上的一个全屏层 #reader。
 *
 * 只读：不碰编辑器的 D / 不写库里的项目数据，自己一条进度。
 * 正文按节懒加载：#rdMain 里先画 30 块，滚到底再追加 30 块，
 * 所以 2000 章的网文也只是一节一节地读（方案 §4 的"按节取"）。
 *
 * 三种 render 走三条路：
 *   text / richtext → 本文件的阅读视图
 *   paged           → PDF：B 路线（pdf.js canvas，可夜间压暗/缩放/选中待接），
 *                     同时留一个"A 路线：原版窗口"的按钮（Chromium 自带查看器，保真兜底）
 *   launch          → 认不出的格式，交给系统程序打开
 */
window.SFReader = (function () {
  'use strict';

  var S = window.SFStore;
  var CHUNK = 30;

  var st = {
    open: false,
    book: null,
    toc: [],
    ord: 0,
    section: null,
    shown: 0,
    prefs: { fs: 18, lh: 1.95, theme: 'paper', width: 720 },
    saveTimer: 0,
    io: null,
    /* B 路线（内嵌 pdf.js）的运行时状态；A 路线走独立窗口，不在这里 */
    pdf: null
  };

  function ui() { return (window.SFApp && window.SFApp.ui) || {}; }
  function esc(s) {
    var u = ui();
    if (u.esc) return u.esc(s);
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function toast(m) { var u = ui(); if (u.toast) u.toast(m); }
  function el(id) { return document.getElementById(id); }
  function root() { return el('reader'); }

  function fmtNum(n) {
    return String(n == null ? 0 : n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  /* ---------------- 行内标记 ----------------
   * 先 esc 再上标记：正文来自用户的文件，任何 < 都已经变成 &lt; 了，
   * 这里只会造出我们自己的标签，不会执行文件里的东西。
   */
  function inline(s) {
    var t = esc(s);
    t = t.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    t = t.replace(/\[([^\]\n]{1,120})\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>');
    return t;
  }

  function blockHtml(b, i) {
    var k = b.kind || 'para';
    var t = b.text || '';
    if (k === 'heading') {
      var lv = Math.min(3, Math.max(1, b.level || 2));
      return '<h' + (lv + 1) + ' class="rd-h rd-h' + lv + '" data-b="' + i + '">' + inline(t) + '</h' + (lv + 1) + '>';
    }
    if (k === 'hr') return '<hr class="rd-hr" data-b="' + i + '">';
    if (k === 'code') return '<pre class="rd-code" data-b="' + i + '"><code>' + esc(t) + '</code></pre>';
    if (k === 'quote') return '<blockquote class="rd-quote" data-b="' + i + '">' + inline(t) + '</blockquote>';
    if (k === 'list') return '<div class="rd-li" data-b="' + i + '">' + (b.ordered ? '•' : '·') + ' ' + inline(t) + '</div>';
    if (k === 'img') {
      /* 图片：主进程 readSection 已经把真实路径塞进 b.file（正文里只存文件名） */
      var p = b.file || '';
      if (!p) return '';
      var src = 'file:///' + encodeURI(String(p).replace(/\\/g, '/'));
      return '<figure class="rd-fig" data-b="' + i + '">' +
        '<img class="rd-img" loading="lazy" src="' + esc(src) + '" alt="">' +
        (t ? '<figcaption>' + inline(t) + '</figcaption>' : '') + '</figure>';
    }
    if (!t.trim()) return '';
    return '<p class="rd-p" data-b="' + i + '">' + inline(t) + '</p>';
  }

  /* ---------------- 骨架 ---------------- */

  function barHtml() {
    var b = st.book;
    var pos = st.toc.length
      ? (st.ord + 1) + ' / ' + st.toc.length
      : '';
    return '<div class="rd-bar">' +
      '<button class="btn ghost sm" data-act="rd-back" title="回书架（Esc）">← 书架</button>' +
      '<div class="rd-head"><div class="rd-name">' + esc(b.title) + '</div>' +
      '<div class="rd-sub">' + esc(b.author || b.label || b.format || '') +
      (b.chars ? ' · ' + fmtNum(b.chars) + ' 字' : '') +
      (pos ? ' · 第 ' + pos + ' 节' : '') + '</div></div>' +
      '<div class="rd-tools">' +
      '<button class="btn ghost sm" data-act="rd-fs-minus" title="小一点">A－</button>' +
      '<button class="btn ghost sm" data-act="rd-fs-plus" title="大一点">A＋</button>' +
      '<button class="btn ghost sm" data-act="rd-theme" title="换底色">' + (st.prefs.theme === 'dark' ? '暗色' : '纸色') + '</button>' +
      '<button class="btn ghost sm" data-act="rd-width" title="宽窄">版心</button>' +
      '</div></div>';
  }

  function tocHtml() {
    if (!st.toc.length) {
      return '<div class="rd-toc"><div class="rd-toc-empty">这本书没识别出目录，按「上一节 / 下一节」翻就行。</div></div>';
    }
    var rows = st.toc.map(function (t, i) {
      return '<div class="rd-toc-row' + (i === st.ord ? ' on' : '') + '" data-act="rd-goto" data-ord="' + i + '"' +
        ' title="' + esc(t.title) + '"><i>' + (i + 1) + '</i><span>' + esc(t.title) + '</span></div>';
    }).join('');
    return '<div class="rd-toc"><div class="rd-toc-head">目录<span class="cnt">' + st.toc.length + '</span></div>' +
      '<div class="rd-toc-list">' + rows + '</div></div>';
  }

  function shellHtml() {
    return barHtml() +
      '<div class="rd-body">' + tocHtml() + '<article class="rd-main" id="rdMain"><div class="rd-inner" id="rdInner"></div></article></div>' +
      '<div class="rd-foot">' +
      '<button class="btn ghost sm" data-act="rd-prev"' + (st.ord > 0 ? '' : ' disabled') + '>← 上一节</button>' +
      '<span class="rd-pos">' + (st.toc.length ? esc(st.toc[st.ord] ? st.toc[st.ord].title : '') : '') + '</span>' +
      '<button class="btn ghost sm" data-act="rd-next"' + (st.ord < st.toc.length - 1 ? '' : ' disabled') + '>下一节 →</button>' +
      '</div>';
  }

  function applyPrefs() {
    var r = root();
    if (!r) return;
    r.setAttribute('data-theme', st.prefs.theme);
    var inner = el('rdInner');
    if (inner) {
      inner.style.fontSize = st.prefs.fs + 'px';
      inner.style.lineHeight = String(st.prefs.lh);
      inner.style.maxWidth = st.prefs.width + 'px';
    }
  }

  /* ---------------- 正文 ---------------- */

  function paintSection(reset) {
    var inner = el('rdInner');
    if (!inner) return;
    if (reset) { inner.innerHTML = ''; st.shown = 0; }
    var blocks = (st.section && st.section.blocks) || [];
    var end = Math.min(blocks.length, st.shown + CHUNK);
    var html = '';
    for (var i = st.shown; i < end; i++) html += blockHtml(blocks[i], i);
    st.shown = end;

    var sent = el('rdSentinel');
    if (sent) sent.parentNode && sent.parentNode.removeChild(sent);
    inner.insertAdjacentHTML('beforeend', html);

    if (st.shown < blocks.length) {
      var s = document.createElement('div');
      s.id = 'rdSentinel';
      s.className = 'rd-sentinel';
      inner.appendChild(s);
      if (st.io) st.io.disconnect();
      st.io = new IntersectionObserver(function (ents) {
        for (var k = 0; k < ents.length; k++) {
          if (ents[k].isIntersecting) { paintSection(false); break; }
        }
      }, { root: el('rdMain'), rootMargin: '600px 0px' });
      st.io.observe(s);
    }
    if (!blocks.length) {
      inner.innerHTML = '<div class="rd-empty">这一节没有正文。</div>';
    }
    applyPrefs();
  }

  function goto(ord, opts) {
    var o = opts || {};
    var n = st.toc.length ? Math.max(0, Math.min(ord, st.toc.length - 1)) : 0;
    st.ord = n;
    return S.lib('section', { id: st.book.id, ord: n }).then(function (sec) {
      st.section = sec || { ord: n, title: '', blocks: [] };
      var main = el('rdMain');
      if (main) main.scrollTop = 0;
      paintSection(true);
      /* 顶栏/底栏里跟节有关的部分重画一遍（目录高亮 + 位置） */
      var r = root();
      if (r) {
        var bar = r.querySelector('.rd-bar');
        if (bar) bar.outerHTML = barHtml();
        var toc = r.querySelector('.rd-toc');
        if (toc) toc.outerHTML = tocHtml();
        var foot = r.querySelector('.rd-foot');
        if (foot) foot.outerHTML = shellFootHtml();
      }
      var on = r && r.querySelector('.rd-toc-row.on');
      if (o.scroll && st.section) scrollToBlock(st.section.savedBlk || 0);
      else if (on && on.scrollIntoView) {
        try { on.scrollIntoView({ block: 'nearest' }); } catch (e) { /* 忽略 */ }
      }
      saveProgressSoon(0);
      return st.section;
    }).catch(function (e) {
      toast('这一节读不出来：' + (e && e.message || e));
    });
  }

  function shellFootHtml() {
    return '<div class="rd-foot">' +
      '<button class="btn ghost sm" data-act="rd-prev"' + (st.ord > 0 ? '' : ' disabled') + '>← 上一节</button>' +
      '<span class="rd-pos">' + (st.toc.length ? esc(st.toc[st.ord] ? st.toc[st.ord].title : '') : '') + '</span>' +
      '<button class="btn ghost sm" data-act="rd-next"' + (st.ord < st.toc.length - 1 ? '' : ' disabled') + '>下一节 →</button>' +
      '</div>';
  }

  function scrollToBlock(i) {
    var inner = el('rdInner');
    if (!inner || !i) return;
    var b = inner.querySelector('[data-b="' + i + '"]');
    if (b && b.scrollIntoView) {
      try { b.scrollIntoView({ block: 'start' }); } catch (e) { /* 忽略 */ }
    }
  }

  /* 当前读到的块：滚到顶上的那一块。用于"下次从这儿接着读"。 */
  function currentBlock() {
    var main = el('rdMain');
    if (!main) return 0;
    var top = main.getBoundingClientRect().top + 24;
    var nodes = main.querySelectorAll('[data-b]');
    for (var i = 0; i < nodes.length; i++) {
      var r = nodes[i].getBoundingClientRect();
      if (r.bottom > top) return +nodes[i].getAttribute('data-b');
    }
    return 0;
  }

  function saveProgressSoon(delay) {
    if (!st.book) return;
    if (st.saveTimer) clearTimeout(st.saveTimer);
    st.saveTimer = setTimeout(function () {
      st.saveTimer = 0;
      if (!st.book) return;
      S.lib('progress', { id: st.book.id, ord: st.ord, blk: currentBlock() }).catch(function () { /* 进度次要，丢了不算错 */ });
    }, delay == null ? 900 : delay);
  }

  /* ---------------- B 路线：PDF 内嵌渲染 ---------------- */
  /*
   * 为什么要 worker 走 IPC、再做成 blob URL：
   *   渲染进程是 file:// 的 origin null，Worker 直接引 file://…js 会被同源策略挡掉；
   *   主进程把 worker 源码读出来交给这里，`new Blob` 起的 URL 属于 null origin，pdf.js 就认了。
   * 为什么一次只画一页：
   *   教材动辄几百页，一次全画会把内存吃干净；按页画、按页记进度，和 A 路线的手感一致。
   */

  function pdfState() {
    if (!st.pdf) st.pdf = { doc: null, page: 1, scale: 1, workerUrl: '', busy: false, total: 0, rendering: false };
    return st.pdf;
  }

  function pdfLib() {
    return window.pdfjsLib || null;
  }

  function pdfShellHtml() {
    var b = st.book;
    var p = pdfState();
    return '<div class="rd-bar">' +
      '<button class="btn ghost sm" data-act="rd-back" title="回书架（Esc）">← 书架</button>' +
      '<div class="rd-head"><div class="rd-name">' + esc(b.title) + '</div>' +
      '<div class="rd-sub">' + esc(b.author || b.label || 'PDF') + (b.srcName ? ' · ' + esc(b.srcName) : '') +
      '</div></div>' +
      '<div class="rd-tools">' +
      '<button class="btn ghost sm" data-act="rd-pdf-prev">上一页</button>' +
      '<span class="rd-page-in"><input id="rdPageNo" type="text" value="' + (p.page || 1) + '"> / <b id="rdPageTotal">' +
      (p.total || '?') + '</b></span>' +
      '<button class="btn ghost sm" data-act="rd-pdf-next">下一页</button>' +
      '<button class="btn ghost sm" data-act="rd-pdf-zoom-out">－</button>' +
      '<button class="btn ghost sm" data-act="rd-pdf-zoom-in">＋</button>' +
      '<button class="btn ghost sm" data-act="rd-theme" title="换底色">' + (st.prefs.theme === 'dark' ? '暗色' : '纸色') + '</button>' +
      '<button class="btn ghost sm" data-act="rd-open-pdf" title="用 Chromium 自带查看器打开（缩放/搜索/书签更全）">原版窗口</button>' +
      '</div></div>' +
      '<div class="rd-body rd-body-pdf">' +
      '<div class="rd-pdf-wrap" id="rdPdfWrap"><canvas id="rdCanvas"></canvas>' +
      '<div class="rd-pdf-hint" id="rdPdfHint">正在打开 PDF…</div></div></div>' +
      '<div class="rd-foot">' +
      '<button class="btn ghost sm" data-act="rd-pdf-prev"' + (p.page > 1 ? '' : ' disabled') + '>← 上一页</button>' +
      '<span class="rd-pos">第 ' + (p.page || 1) + ' 页</span>' +
      '<button class="btn ghost sm" data-act="rd-pdf-next">下一页 →</button>' +
      '</div>';
  }

  function setPdfHint(text) {
    var h = el('rdPdfHint');
    if (!h) return;
    h.textContent = text || '';
    h.style.display = text ? 'block' : 'none';
  }

  function loadPdf() {
    var p = pdfState();
    var lib = pdfLib();
    if (!lib) { setPdfHint('pdf.js 没加载（apps/ui/vendor/pdf.min.js 缺失）'); return Promise.resolve(); }
    if (p.doc) return Promise.resolve();
    p.busy = true;
    var workerP = p.workerUrl
      ? Promise.resolve(p.workerUrl)
      : S.lib('pdf-worker').then(function (r) {
        var url = URL.createObjectURL(new Blob([r.code], { type: 'text/javascript' }));
        p.workerUrl = url;
        return url;
      });
    return workerP.then(function (url) {
      lib.GlobalWorkerOptions.workerSrc = url;
      return S.lib('bytes', { id: st.book.id });
    }).then(function (r) {
      var data = r && r.bytes;
      return lib.getDocument({ data: data, isEvalSupported: false }).promise;
    }).then(function (doc) {
      p.doc = doc;
      p.total = doc.numPages;
      var totalEl = el('rdPageTotal');
      if (totalEl) totalEl.textContent = String(doc.numPages);
      p.busy = false;
      return paintPage(p.page, { scroll: true });
    }).catch(function (e) {
      p.busy = false;
      setPdfHint('打开 PDF 失败：' + ((e && e.message) || e) + '（可以点右上角「原版窗口」用系统查看器打开）');
    });
  }

  function paintPage(n, opts) {
    var p = pdfState();
    var doc = p.doc;
    if (!doc) return Promise.resolve();
    var page = Math.max(1, Math.min(n, doc.numPages));
    p.page = page;
    p.rendering = true;
    return doc.getPage(page).then(function (pg) {
      var canvas = el('rdCanvas');
      if (!canvas) return null;
      var base = pg.getViewport({ scale: 1 });
      var wrap = el('rdPdfWrap');
      var avail = wrap ? Math.max(320, wrap.clientWidth - 40) : 900;
      var scale = Math.min(3, (avail / base.width) * (p.scale || 1));
      var vp = pg.getViewport({ scale: scale });
      var dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
      canvas.width = Math.floor(vp.width * dpr);
      canvas.height = Math.floor(vp.height * dpr);
      canvas.style.width = Math.floor(vp.width) + 'px';
      canvas.style.height = Math.floor(vp.height) + 'px';
      var ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return pg.render({ canvasContext: ctx, viewport: vp }).promise.then(function () {
        setPdfHint('');
        p.rendering = false;
        syncPdfUi();
        if (opts && opts.scroll) {
          var m = el('rdPdfWrap');
          if (m) m.scrollTop = 0;
        }
        /* 页码就是进度：和 A 路线写同一列（progress_ord） */
        saveProgressSoon(0);
      });
    }).catch(function (e) {
      p.rendering = false;
      setPdfHint('这一页画不出来：' + ((e && e.message) || e));
    });
  }

  function syncPdfUi() {
    var p = pdfState();
    var no = el('rdPageNo');
    if (no && document.activeElement !== no) no.value = String(p.page);
    var total = el('rdPageTotal');
    if (total) total.textContent = String(p.total || '?');
    var pos = el('rdMain');
    var footPos = document.querySelector('.rd-pos');
    if (footPos) footPos.textContent = '第 ' + p.page + ' 页';
    if (pos) pos.scrollTop = pos.scrollTop;
  }

  function pdfGoto(n) {
    var p = pdfState();
    if (!p.doc) return Promise.resolve();
    return paintPage(n, { scroll: true });
  }

  /* ---------------- 特例：PDF / 认不出的格式 ---------------- */

  function specialHtml() {
    var b = st.book;
    var paged = b.render === 'paged';
    var note = b.note ? '<div class="rd-note">' + esc(b.note) + '</div>' : '';
    var prog = paged && b.progressOrd ? '<div class="rd-prog">上次读到第 ' + b.progressOrd + ' 页</div>' : '';
    return '<div class="rd-special">' +
      '<div class="rd-special-ico">' + (paged ? 'PDF' : (esc(b.format || 'FILE').toUpperCase())) + '</div>' +
      '<div class="rd-special-name">' + esc(b.title) + '</div>' +
      '<div class="rd-special-sub">' + esc(b.label || b.format || '') +
      (b.srcName ? ' · ' + esc(b.srcName) : '') + '</div>' + note + prog +
      '<div class="rd-special-acts">' +
      (paged
        ? '<button class="btn primary" data-act="rd-open-pdf">在内建查看器里打开</button>' +
          '<button class="btn" data-act="rd-open-ext">用系统程序打开</button>'
        : '<button class="btn primary" data-act="rd-open-ext">用系统程序打开</button>') +
      '<button class="btn ghost" data-act="rd-reveal">定位源文件</button>' +
      '</div>' +
      '<div class="rd-hint">' + (paged
        ? 'PDF 走原版渲染：字体、公式、图、表格都是原样，不会被"文字抽取"弄坏。页码会在这本书上记着。'
        : '这个格式 StoryForge 读不了，但书还在书架上，随时可以交给系统里的程序打开。') +
      '</div></div>';
  }

  function bindPdfUi() {
    var no = el('rdPageNo');
    if (!no || no.__bound) return;
    no.__bound = true;
    no.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      var n = parseInt(String(no.value).replace(/\D/g, ''), 10) || 1;
      pdfGoto(n);
      no.blur();
    });
    no.addEventListener('blur', function () { syncPdfUi(); });
  }

  /* ---------------- 打开 / 关闭 ---------------- */

  function show() {
    var r = root();
    if (!r) return;
    r.classList.remove('hidden');
    document.body.classList.add('reading');
    st.open = true;
  }

  function close() {
    if (!st.open) return;
    saveProgressSoon(0);
    if (st.pdf) {
      try { if (st.pdf.doc) st.pdf.doc.destroy(); } catch (e) { /* 已销毁 */ }
      st.pdf = null;
    }
    st.open = false;
    var r = root();
    if (r) {
      r.classList.add('hidden');
      r.innerHTML = '';
      r.removeAttribute('data-theme');
    }
    document.body.classList.remove('reading');
    if (st.io) { st.io.disconnect(); st.io = null; }
    st.book = null; st.toc = []; st.section = null; st.ord = 0;
  }

  function open(id) {
    if (!S || !S.canLibrary) { toast('阅读器只在桌面版可用'); return; }
    var r = root();
    if (!r) { toast('阅读器容器没找到（index.html 里缺 #reader）'); return; }
    S.lib('open', { id: id }).then(function (res) {
      if (!res || !res.book) { toast('这本书不在书架上了'); return; }
      st.book = res.book;
      st.toc = res.toc || [];
      st.ord = Math.max(0, Math.min(st.book.progressOrd || 0, Math.max(0, st.toc.length - 1)));
      st.prefs = Object.assign({ fs: 18, lh: 1.95, theme: 'paper', width: 720 }, st.book.prefs || {});

      r.innerHTML = shellHtml();
      /* 小说 txt 按中文习惯首行缩进；md 说明文档不缩进，不然看着像乱排版 */
      var innerEl = el('rdInner');
      if (innerEl) innerEl.className = 'rd-inner' + (st.book.format === 'txt' ? ' indent' : '');
      show();

      if (st.book.render === 'paged' && st.book.format === 'pdf') {
        /* B 路线：先把页码恢复成上次读到的页，再交给 pdf.js 画 */
        var ps = pdfState();
        ps.page = Math.max(1, st.book.progressOrd || 1);
        r.innerHTML = pdfShellHtml();
        applyPrefs();
        show();
        bindPdfUi();
        return loadPdf();
      }
      if (st.book.render === 'paged' || st.book.render === 'launch') {
        var main = el('rdMain');
        if (main) main.innerHTML = specialHtml();
        return;
      }
      return goto(st.ord, { scroll: true });
    }).catch(function (e) {
      toast('打开失败：' + (e && e.message || e));
    });
  }

  /* ---------------- 交互 ---------------- */

  function savePrefs() {
    if (!st.book) return;
    S.lib('prefs', { id: st.book.id, prefs: st.prefs }).catch(function () { /* 记不住样式不影响读 */ });
  }

  function handle(act, node) {
    if (act === 'rd-back') { close(); if (window.SFLibrary) window.SFLibrary.open(); return; }
    if (act === 'rd-goto') { goto(+node.getAttribute('data-ord')); return; }
    if (act === 'rd-prev') { if (st.ord > 0) goto(st.ord - 1); return; }
    if (act === 'rd-next') { if (st.ord < st.toc.length - 1) goto(st.ord + 1); return; }
    if (act === 'rd-fs-plus') { st.prefs.fs = Math.min(30, st.prefs.fs + 1); applyPrefs(); savePrefs(); return; }
    if (act === 'rd-fs-minus') { st.prefs.fs = Math.max(13, st.prefs.fs - 1); applyPrefs(); savePrefs(); return; }
    if (act === 'rd-theme') {
      st.prefs.theme = st.prefs.theme === 'dark' ? 'paper' : 'dark';
      applyPrefs(); savePrefs();
      var r = root();
      var btn = r && r.querySelector('[data-act="rd-theme"]');
      if (btn) btn.textContent = st.prefs.theme === 'dark' ? '暗色' : '纸色';
      return;
    }
    if (act === 'rd-width') {
      st.prefs.width = st.prefs.width > 700 ? 760 : 640;
      applyPrefs(); savePrefs(); return;
    }
    if (act === 'rd-pdf-next') { pdfGoto(pdfState().page + 1); return; }
    if (act === 'rd-pdf-prev') { pdfGoto(pdfState().page - 1); return; }
    if (act === 'rd-pdf-zoom-in') { pdfState().scale = Math.min(3, (pdfState().scale || 1) + 0.15); paintPage(pdfState().page); return; }
    if (act === 'rd-pdf-zoom-out') { pdfState().scale = Math.max(0.4, (pdfState().scale || 1) - 0.15); paintPage(pdfState().page); return; }
    if (act === 'rd-open-pdf') {
      S.lib('open-pdf', { id: st.book.id, page: st.book.progressOrd || 1 })
        .then(function (res) {
          if (res && res.ok === false) toast(res.reason || '打不开这个 PDF');
        })
        .catch(function (e) { toast('打不开这个 PDF：' + (e && e.message || e)); });
      return;
    }
    if (act === 'rd-open-ext') {
      S.lib('open-external', { id: st.book.id })
        .then(function () { toast('已经交给系统程序打开'); })
        .catch(function (e) { toast(e && e.message || '系统打不开这个文件'); });
      return;
    }
    if (act === 'rd-reveal') {
      S.lib('reveal', { id: st.book.id }).catch(function (e) { toast(e && e.message || '定位失败'); });
      return;
    }
  }

  document.addEventListener('click', function (e) {
    if (!st.open) return;
    var t = e.target;
    if (!t || !t.closest) return;
    var node = t.closest('[data-act]');
    if (!node) return;
    var act = node.getAttribute('data-act');
    if (act.slice(0, 3) !== 'rd-') return;
    e.preventDefault();
    handle(act, node);
  });

  /* 键位：必须排在 app.js 的 keydown 最前面（那边会把 ↑↓ 当滚轮、Enter 当拆段） */
  function keys(e) {
    if (st.open && st.pdf && st.pdf.doc) {
      if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); pdfGoto(pdfState().page + 1); return true; }
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); pdfGoto(pdfState().page - 1); return true; }
    }
    if (!st.open) return false;
    var tag = (e.target && e.target.tagName) || '';
    if (/^(INPUT|TEXTAREA)$/.test(tag) || (e.target && e.target.isContentEditable)) return false;
    if (e.key === 'Escape') { e.preventDefault(); close(); return true; }
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); if (st.ord > 0) goto(st.ord - 1); return true; }
    if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); if (st.ord < st.toc.length - 1) goto(st.ord + 1); return true; }
    if (e.key === 'Home') { var m = el('rdMain'); if (m) { m.scrollTop = 0; e.preventDefault(); return true; } }
    return false;
  }

  /* 滚动时记录进度（节流在 saveProgressSoon 里） */
  document.addEventListener('scroll', function (e) {
    if (!st.open || !st.section) return;
    var main = el('rdMain');
    if (!main || e.target !== main) return;
    saveProgressSoon();
  }, true);

  /* PDF 窗口推回来的页码：更新进度显示 */
  function onEvent(msg) {
    if (!msg || !st.book) return;
    if (msg.bookId && msg.bookId !== st.book.id) return;
    if (msg.type === 'pdf-page' && msg.page) {
      st.book.progressOrd = msg.page;
      var pr = root() && root().querySelector('.rd-prog');
      if (pr) pr.textContent = '上次读到第 ' + msg.page + ' 页';
    }
  }

  /* 打开一段"不在书架上"的正文（联网抓回来的章节走这里）：
     只给标题 + 段落，不落库、不记进度，翻页按钮隐藏。 */
  function openText(opts) {
    var o = opts || {};
    var r = root();
    if (!r) { toast('阅读器容器没找到'); return; }
    var blocks = (o.blocks || []).map(function (t) { return { kind: 'para', text: t }; });
    st.book = {
      id: '__web__', title: o.bookTitle || o.title || '联网章节',
      author: o.author || '', format: 'txt', render: 'text', prefs: {}
    };
    st.toc = [{ title: o.title || '正文', ord: 0 }];
    st.ord = 0;
    st.prefs = Object.assign({ fs: 18, lh: 1.95, theme: 'paper', width: 720 }, st.prefs || {});
    st.section = { ord: 0, title: o.title || '', blocks: blocks };
    r.innerHTML = shellHtml();
    var innerEl = el('rdInner');
    if (innerEl) innerEl.className = 'rd-inner indent';
    show();
    applyPrefs();
    paintSection(true);
    var barEl = r.querySelector('.rd-bar');
    if (barEl) barEl.outerHTML = barHtml();
    var tocEl = r.querySelector('.rd-toc');
    if (tocEl) tocEl.outerHTML = tocHtml();
    var footEl = r.querySelector('.rd-foot');
    if (footEl) footEl.outerHTML = shellFootHtml();
  }

  if (window.SFStore && window.SFStore.onLibEvent) window.SFStore.onLibEvent(onEvent);

  return {
    open: open,
    openText: openText,
    close: close,
    keys: keys,
    isOpen: function () { return st.open; },
    state: st
  };
})();
