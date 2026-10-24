/* StoryForge — 书库（阅读器模式的入口）
 *
 * 跟"项目"是平行的两套收藏：
 *   项目 = 你自己写的东西（书架在 app.js:2058 openProjects）
 *   书库 = 你导入进来读的东西（本文件）
 *
 * 交互契约（方案 §8.3）：
 *   书脊 —— 选中不打开，再点一次 / 回车才打开（滚轮滑过不会误开）；
 *   清单 —— 单击直接打开（点名字就是"我要看这本"）。
 *   两条路都进 SFReader.open(id)，进度是同一份。
 *
 * 依赖 app.js 暴露的 SFApp.ui（esc / toast / openModal / closeModal），
 * 不重复实现一套 DOM 工具。
 */
window.SFLibrary = (function () {
  'use strict';

  var S = window.SFStore;

  var st = {
    books: [],
    sel: 0,
    busy: false,
    owns: false,
    lastImport: null
  };

  function ui() {
    return (window.SFApp && window.SFApp.ui) || {};
  }
  function esc(s) {
    var u = ui();
    if (u.esc) return u.esc(s);
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function toast(msg) {
    var u = ui();
    if (u.toast) u.toast(msg);
    else if (window.console) console.log('[lib]', msg);
  }
  function fmtNum(n) {
    return String(n == null ? 0 : n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function rootEl() { return document.getElementById('libShelf'); }

  /* 判断"书库弹窗现在是不是开着"：不能只看 #libShelf，
     移除确认 / 换编码这两个小弹窗会把它整块换掉。 */
  function isOpen() {
    var m = document.getElementById('modal');
    if (!m || !m.classList.contains('open')) { st.owns = false; return false; }
    return !!st.owns;
  }

  /* ---------------- 数据 ---------------- */

  function loadList() {
    if (!S || !S.canLibrary) {
      st.books = [];
      return Promise.resolve([]);
    }
    return S.lib('list', {}).then(function (list) {
      st.books = list || [];
      if (st.sel >= st.books.length) st.sel = 0;
      return st.books;
    }).catch(function (e) {
      st.books = [];
      toast('读书架失败：' + (e && e.message || e));
      return [];
    });
  }

  /* ---------------- 渲染 ---------------- */

  var TONES = ['#e8e0cf', '#efe6d4', '#e3dac9', '#f0e9db', '#e6ddcb', '#ebe2d3'];

  function pct(b) {
    if (!b.sectionCount) return 0;
    if (b.render === 'paged') return 0;
    return Math.min(100, Math.round(((b.progressOrd || 0) / b.sectionCount) * 100));
  }

  function coverUrl(b) {
    var c = String((b && b.cover) || '');
    if (!c) return '';
    if (/^https?:/i.test(c) || /^data:/i.test(c)) return c;
    return 'file:///' + c.replace(/\\/g, '/').replace(/#/g, '%23').replace(/^\/+/, '');
  }

  function spineHtml(b, i, sel) {
    var on = i === sel ? ' on' : '';
    var tone = TONES[i % TONES.length];
    var tag = b.render === 'paged' ? 'PDF' : (b.format || '').toUpperCase();
    var cv = coverUrl(b);
    return '<div class="book lib-book' + on + '" data-act="lib-book" data-id="' + esc(b.id) + '" data-i="' + i + '"' +
      ' style="--tone:' + tone + '" title="' + esc(b.title) + '｜' + (tag ? esc(tag) + ' · ' : '') +
      (b.chars ? fmtNum(b.chars) + ' 字' : (b.sectionCount ? b.sectionCount + ' 节' : '未解析')) + '">' +
      '<div class="bk-spine"><span class="bk-name">' + esc(b.title) + '</span></div>' +
      '<div class="bk-cover' + (cv ? ' has-cv' : '') + '"' + (cv ? ' style="background-image:url(&quot;' + cv.replace(/"/g, '%22') + '&quot;)"' : '') + '>' + (cv ? '' : '<i class="bk-ph"></i>') +
      (b.srcMissing ? '<span class="bk-badge">源文件缺失</span>' : '') + '</div>' +
      '</div>';
  }

  function rowHtml(b) {
    var tag = b.render === 'paged' ? 'PDF' : (b.format || '');
    var p = pct(b);
    return '<div class="ll-row" data-act="lib-open" data-id="' + esc(b.id) + '" title="打开《' + esc(b.title) + '》">' +
      '<div class="ll-main">' +
      '<div class="ll-name">' + esc(b.title) + (b.author ? '<span class="ll-author">' + esc(b.author) + '</span>' : '') + '</div>' +
      '<div class="ll-meta">' +
      (tag ? esc(tag) + ' · ' : '') +
      (b.sectionCount ? b.sectionCount + ' 节 · ' : '') +
      (b.chars ? fmtNum(b.chars) + ' 字' : '') +
      (b.srcMissing ? ' · <b class="warn">源文件缺失</b>' : '') +
      '</div>' +
      '</div>' +
      '<div class="ll-bar"><i style="width:' + p + '%"></i></div>' +
      '<div class="ll-pct">' + (p ? p + '%' : '未读') + '</div>' +
      '</div>';
  }

  function bodyHtml() {
    var list = st.books;
    var sel = Math.max(0, Math.min(st.sel, Math.max(0, list.length - 1)));
    var cur = list[sel];

    var spines = list.map(function (b, i) { return spineHtml(b, i, sel); }).join('');
    var rows = list.length
      ? list.map(rowHtml).join('')
      : '<div class="ll-empty">书架上还没有书。点下面的「导入文件」，或把 txt / md / pdf 拖进来。</div>';

    return '<h3>书架</h3>' +
      '<div class="sub">这里放的是<strong>读的</strong>书（txt / md / pdf，也可以放认不出的格式交给系统程序开）。' +
      '书脊：滚轮或 ← → 挑，再点一次（或回车）打开；清单：单击直接打开。</div>' +
      '<div class="shelf-dl" id="shelfDl" hidden>' +
      '<span class="sdl-t" id="sdlTitle">正在下载…</span>' +
      '<span class="sdl-bar"><i id="sdlFill"></i></span>' +
      '<b id="sdlText">0 / 0</b></div>' +
      '<div class="shelf-wrap" id="libShelfWrap">' +
      '<div class="shelf" id="libShelf">' + spines +
      '<div class="book add" data-act="lib-import" title="导入文件">' +
      '<div class="bk-top"></div><div class="bk-name">＋ 导入书</div><div class="bk-meta">txt / md / pdf…</div></div>' +
      '</div><div class="shelf-board"></div></div>' +
      (cur ? '<div class="shelf-info">' +
        '<div class="si-name">' + esc(cur.title) + (cur.author ? '<span class="chip">' + esc(cur.author) + '</span>' : '') + '</div>' +
        '<div class="si-meta">' + esc(cur.srcName || cur.srcPath || '') +
        (cur.note ? '<span class="si-note">' + esc(cur.note) + '</span>' : '') + '</div>' +
        '<div class="si-acts">' +
        '<button class="btn primary sm" data-act="lib-open" data-id="' + esc(cur.id) + '">打开</button>' +
        '<button class="btn sm" data-act="lib-reveal" data-id="' + esc(cur.id) + '">定位源文件</button>' +
        '<button class="btn sm" data-act="lib-reparse" data-id="' + esc(cur.id) + '">换编码重读</button>' +
        '<button class="btn sm" data-act="lib-update" data-id="' + esc(cur.id) + '">检查更新</button>' +
        '<button class="btn sm" data-act="lib-fiximg" data-id="' + esc(cur.id) + '">补插图</button>' +
        '<button class="btn sm danger" data-act="lib-remove" data-id="' + esc(cur.id) + '">移除</button>' +
        '</div></div>' : '') +
      '<div class="lib-list">' +
      '<div class="ll-head"><span>清单</span><span class="ll-count">' + st.books.length + ' 本</span>' +
      '<span class="spacer"></span>' +
      '<button class="btn ghost sm" data-act="lib-import">＋ 导入文件</button></div>' +
      '<div class="ll-rows">' + rows + '</div>' +
      '</div>' +
      '<div class="src-box" id="srcBox">' +
      '<div class="src-bar">' +
      '<select id="srcProvider" class="src-prov"></select>' +
      '<input id="srcQuery" type="text" placeholder="书名 / 作者 / 书号 / 书页链接">' +
      '<button class="btn primary sm src-go" data-act="src-go">搜索 / 打开</button>' +
      '</div>' +
      '<div class="src-bar2" id="srcExtra">' +
      '<select id="srcBy" class="src-by" title="按书名还是按作者找">' +
        '<option value="title">按书名</option>' +
        '<option value="author">按作者</option>' +
      '</select>' +
      '<button class="btn ghost sm" data-act="wk-cat-toggle" id="wkCatBtn" hidden>书单</button>' +
      '<button class="btn ghost sm" data-act="wk-login" hidden>登录</button>' +
      '<button class="btn ghost sm" data-act="wk-check" hidden>检测</button>' +
      '<span class="src-spacer"></span>' +
      '<span class="src-prog" id="srcProg" hidden><span class="sp-bar"><i id="spFill"></i></span><b id="spText">0 / 0</b></span>' +
      '</div>' +
      '<div class="src-note" id="srcNote"></div>' +
      '<div class="wk-cat" id="wkCatBar" hidden>' +
        '<div class="wk-cat-tabs">' +
          '<button class="wct on" data-act="wk-cat" data-kind="all">全部</button>' +
          '<button class="wct" data-act="wk-cat" data-kind="top">排行榜</button>' +
        '</div>' +

        '<div class="wkc-grid" id="wkcGrid"></div>' +
        '<div class="wk-pager" id="wkPager" hidden>' +
          '<button class="btn ghost sm" data-act="wk-page" data-d="-1">上一页</button>' +
          '<span class="wk-pg" id="wkPageLabel">第 1 页</span>' +
          '<button class="btn ghost sm" data-act="wk-page" data-d="1">下一页</button>' +
        '</div>' +
      '</div>' +
      '<div class="src-rows" id="srcRows"></div>' +
      '<div class="src-rows" id="srcRows"></div>' +
      '</div>' +
      '<div class="drop-hint" id="libDropHint"><div class="dh-in">松手就导入<br><span>txt / md / epub / pdf</span></div></div>' +
      '<div class="form-acts"><button class="btn" data-act="close-modal">关闭</button></div>';
  }

  function paint() {
    /* 关掉书库再打开：进度条要还在（否则用户以为下载没了） */
    setTimeout(function () {
      if (dq.items.length) repaintJobs();
      if (dn.state && Date.now() - dn.state.at < 20 * 60 * 1000) {
        dlStage = dn.state.stage || '';
        paintProg(dn.state.done || 0, dn.state.total || 0);
      }
    }, 30);
    var u = ui();
    if (!u.openModal) return;
    st.owns = true;
    u.openModal(bodyHtml(), 'wide');
    var card = document.getElementById('modalCard');
    if (card) card.className = 'modal-card wide shelf-card lib-card';
    var root = document.getElementById('libShelf');
    /* 记个锚：键盘处理靠它判断"现在是不是书库这一版弹窗" */
    if (root) root.setAttribute('data-lib', '1');
    bindWheel();
    bindSources();
  }

  /* ---------------- 联网找书 ---------------- */

  var src = { providers: null, results: [], busy: false, note: '', catalog: [], catalogKind: '', catalogPage: 1, loggedIn: false, loginTimer: null };
  var progTimer = null;
  var dlTick = null;
  var dlStage = '';
  var dlT0 = 0;

  function pctOf(done, total) {
    if (!total) return 3;
    var p = Math.round((done / total) * 100);
    /* 没真正结束之前不要显示 100%：234 章时 233/234 会被四舍五入成 100%，
       用户会以为卡死 */
    if (done < total) p = Math.min(99, p);
    return Math.max(1, Math.min(p, 99));
  }

  var dlStageText = '';

  /* 画进度：源栏一条、详情一条、书架顶部一条（三个地方都能看到） */
  function paintProg(done, total) {
    var pct = pctOf(done, total);
    var pctShown = done >= total ? 100 : pct;
    var label = done + ' / ' + total + '（' + pctShown + '%）';
    if (dlStage === 'book') label = '正在读书籍页…';
    else if (dlStage === 'toc') label = '正在读目录…';
    else if (dlStage === 'chapters' && done < 1) label = (dlStageText || '正在抓正文') + '…';
    else if (dlStage === 'images') label = '正在收尾：抓插图 ' + done + ' / ' + total;
    else if (dlStage === 'write') label = '正在写入书架 ' + done + ' / ' + total;
    else if (done >= total) label = total + ' / ' + total + '（100%）· 正在收尾';
    else {
      var el = Date.now() - (dlT0 || Date.now());
      if (done > 2 && el > 8000) label += ' · 约还要 ' + Math.max(1, Math.round(((total - done) * (el / done)) / 60000)) + ' 分钟';
    }
    var pairs = [
      ['srcProg', 'spFill', 'spText'],
      ['wkProg2', 'wkFill2', 'wkText2'],
      ['shelfDl', 'sdlFill', 'sdlText']
    ];
    pairs.forEach(function (ids) {
      var box = document.getElementById(ids[0]);
      if (!box) return;
      box.hidden = false;
      var f = document.getElementById(ids[1]);
      var t = document.getElementById(ids[2]);
      if (f) f.style.width = pct + '%';
      if (t) t.textContent = label;
    });
    var nameEl = document.getElementById('sdlTitle');
    if (nameEl && st.wk && st.wk.book && st.wk.book.title) {
      nameEl.textContent = '正在下载《' + st.wk.book.title + '》';
    }
  }

  var dn = { state: null };
  function showProg(done, total) {
    dn.state = Object.assign({}, dn.state || {}, { done: done, total: total, at: Date.now() });
    paintProg(done, total);
  }

  function stopDlTick() {
    if (dlTick) { clearInterval(dlTick); dlTick = null; }
  }

  /* 真实事件没来也要让用户知道"在动"：按 1.6 秒/章估个下限往前走 */
  function startDlEstimate(total) {
    stopDlTick();
    dlStage = '';
    dlT0 = Date.now();
    var t0 = Date.now();
    var shown = 0;
    dlTick = setInterval(function () {
      var est = Math.min(Math.max(1, total - 1), Math.floor((Date.now() - t0) / 1600));
      if (est > shown) {
        shown = est;
        paintProg(shown, total || 1);
      }
    }, 900);
  }

  function hideProg(delay) {
    if (progTimer) clearTimeout(progTimer);
    progTimer = setTimeout(function () {
      ['srcProg', 'wkProg2', 'shelfDl'].forEach(function (id) {
        var box = document.getElementById(id);
        if (box) box.hidden = true;
      });
    }, delay == null ? 1600 : delay);
  }

  var LS_PROV = 'sf.libprov.v1';
  var LS_BY = 'sf.libby.v1';
  function savedProv(v) {
    try {
      if (v === undefined) return localStorage.getItem(LS_PROV) || '';
      localStorage.setItem(LS_PROV, v || '');
    } catch (e) { return ''; }
  }
  function savedBy(v) {
    try {
      if (v === undefined) return localStorage.getItem(LS_BY) || 'title';
      localStorage.setItem(LS_BY, v || 'title');
    } catch (e) { return 'title'; }
  }
  var LS_CAT = 'sf.libcat.v1';
  function catOpen() { try { return localStorage.getItem(LS_CAT) === '1'; } catch (e) { return false; } }
  function setCatOpen(on) { try { localStorage.setItem(LS_CAT, on ? '1' : '0'); } catch (e) { /* 忽略 */ } }

  /* 弹窗统一入口：library.js 不在 app.js 的作用域里，
     只能通过 SFApp.ui 拿 openModal/closeModal（拿不到就给一句人话）。 */
  function uiModal(html, cls) {
    var x = ui();
    if (!x || typeof x.openModal !== 'function') throw new Error('界面还没准备好（书库刚关掉？）请重开书库再点一次');
    x.openModal(html, cls);
  }
  function uiClose() {
    var x = ui();
    if (x && typeof x.closeModal === 'function') x.closeModal();
  }

  function bindSources() {
    if (!src.evBound && S.onLibEvent) {
      src.evBound = true;
      S.onLibEvent(function (msg) {
        if (msg && msg.type === 'wk8-stage') {
          dlStage = msg.stage || '';
          dlStageText = msg.detail || '';
          var cur2 = dq.items.filter(function (x) { return x.state === 'running'; })[0];
          if (cur2) { cur2.done = msg.done || 0; cur2.total = msg.total || cur2.total; repaintJobs(); }
          dn.state = { stage: dlStage, done: msg.done || 0, total: msg.total || 0, at: Date.now() };
          showProg(msg.done || 0, msg.total || 0);
          return;
        }
        if (!msg || msg.type !== 'wk8-progress') return;
        dlStage = '';
        var cur = dq.items.filter(function (x) { return x.state === 'running'; })[0];
        if (cur) { cur.done = msg.done || 0; cur.total = msg.total || cur.total; repaintJobs(); }
        showProg(msg.done || 0, msg.total || 0);
        var nowT = Date.now();
        if (!src.__toastAt || nowT - src.__toastAt > 2500) {
          src.__toastAt = nowT;
          toast('下载中：' + (msg.done || 0) + ' / ' + (msg.total || 0) + ' 章');
        }
      });
    }
    var sel = document.getElementById('srcProvider');
    var bySel = document.getElementById('srcBy');
    if (bySel && !bySel.dataset.bound) {
      bySel.value = savedBy();
      bySel.dataset.bound = '1';
      bySel.addEventListener('change', function () { savedBy(bySel.value); });
    }
    if (sel && !sel.dataset.persist) {
      sel.dataset.persist = '1';
      sel.addEventListener('change', function () { savedProv(sel.value); });
    }
    var note = document.getElementById('srcNote');
    if (!sel) return;
    var box = document.getElementById('srcBox');
    if (box && box._sfBound) { renderSrc(); return; }
    if (box) box._sfBound = true;

    if (!src.providers) {
      if (!S || !S.lib) return;
      S.lib('src-providers', {}).then(function (list) {
        src.providers = list || [];
        renderSrc();
      }).catch(function (e) { src.note = '书源列表拿不到：' + (e && e.message || e); renderSrc(); });
      return;
    }
    renderSrc();
  }

  /* 书单面板：默认收起（用「书单」按钮开），只在 wenku8 源下出现 */
  function catSync(isWk) {
    var bar = document.getElementById('wkCatBar');
    var btn = document.getElementById('wkCatBtn');
    var pager = document.getElementById('wkPager');
    if (!bar) return;
    var open = !!isWk && catOpen();
    bar.hidden = !open;
    if (btn) {
      btn.classList.toggle('primary', open);
      btn.textContent = open ? '收起书单' : '书单';
    }
    if (pager) {
      var withPage = src.catalogKind === 'all' || src.catalogKind === 'top';
      pager.hidden = !open || !withPage;
      var lab = document.getElementById('wkPageLabel');
      if (lab) lab.textContent = '第 ' + (src.catalogPage || 1) + ' 页';
    }
    var tabs = document.querySelectorAll('#wkCatBar .wct');
    for (var i = 0; i < tabs.length; i += 1) {
      var k = tabs[i].getAttribute('data-kind');
      tabs[i].classList.toggle('on', k === (src.catalogKind || 'all'));
    }
  }

  function wkCatHtml() {
    var el = document.getElementById('wkAlpha');
    if (el && !el.getAttribute('data-filled')) {
      var letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
      el.innerHTML = letters.map(function (a) {
        return '<button class="wk-al" data-act="wk-cat" data-kind="alpha" data-alpha="' + a + '">' + a + '</button>';
      }).join('');
      el.setAttribute('data-filled', '1');
    }
    var grid = document.getElementById('wkcGrid');
    if (!grid) return;
    var items = src.catalog || [];
    grid.innerHTML = items.map(function (b) {
      var cv = b.cover ? '<img src="' + esc(b.cover) + '" loading="lazy" alt="">' : '<i class="bk-ph"></i>';
      return '<div class="wkc" data-act="wkc-open" data-bid="' + esc(b.bid) + '" title="' + esc(b.title) + '">' +
        '<div class="wkc-cv">' + cv + '</div>' +
        '<div class="wkc-t">' + esc(b.title) + '</div>' +
        '<div class="wkc-a">' + esc(b.author || ('书号 ' + b.bid)) + '</div>' +
        '</div>';
    }).join('');
  }

  function renderSrc() {
    var sel = document.getElementById('srcProvider');
    var note = document.getElementById('srcNote');
    var rows = document.getElementById('srcRows');
    if (!sel || !note || !rows) return;
    if (!sel.options.length && src.providers) {
      src.providers.forEach(function (p) {
        var o = document.createElement('option');
        o.value = p.id;
        var shortName = { gutenberg: '古登堡', wenku8: '轻小说文库', wensuoge: '文搜阁', direct: '直链' }[p.id] || p.label;
        o.textContent = shortName + (p.canDownload ? ' · 可下载' : ' · 只给链接');
        o.title = p.note || '';
        sel.appendChild(o);
      });
      /* 重画后恢复上次选的书源：否则下载完一刷新就跳回第一个（古登堡） */
      var keep = savedProv();
      if (keep && (src.providers || []).some(function (p) { return p.id === keep; })) {
        sel.value = keep;
      }
    }
    var curP = (src.providers || []).filter(function (p) { return p.id === sel.value; })[0];
    note.className = 'src-note' + (src.results.length ? '' : ' muted');
    note.textContent = src.note || (curP ? curP.note : '');
    note.setAttribute('data-open', src.openUrl || '');

    /* wenku8：登录/检测按钮只在选它的时候出现 */
    var loginBtn = document.querySelector('[data-act="wk-login"]');
    var checkBtn = document.querySelector('[data-act="wk-check"]');
    var isWk = sel.value === 'wenku8';
    if (loginBtn) loginBtn.hidden = !isWk;
    if (checkBtn) checkBtn.hidden = !isWk;
    var catBtn = document.getElementById('wkCatBtn');
    if (catBtn) catBtn.hidden = !isWk;
    catSync(isWk);

    if (!src.results.length) {
      rows.innerHTML = '';
      wkCatHtml();
      return;
    }
    rows.innerHTML = src.results.map(function (r, i) {
      return '<div class="src-row" data-i="' + i + '">' +
        '<div class="sr-main"><div class="sr-t">' + esc(r.title) + '</div>' +
        '<div class="sr-m">' + esc(r.extra || '') + (r.note ? ' · ' + esc(r.note) : '') + '</div></div>' +
        (r.downloadable
          ? '<button class="btn primary sm" data-act="src-dl" data-i="' + i + '">下到书架</button>'
          : (r.wkRef
            ? '<button class="btn sm" data-act="wk-book" data-ref="' + esc(r.wkRef) + '">看这本书</button>'
            : '<button class="btn sm" data-act="src-open" data-i="' + i + '">浏览器打开</button>')) +
        '</div>';
    }).join('');
    wkCatHtml();
  }

  /* ---------------- wenku8：详情 / 目录 / 单章阅读 / 整本下载 ----------------
     这几扇"窗"是照着 Wenku8_Flutter 的流程做的：搜索/链接 → 详情（封面+简介+目录）→
     点章读正文 → 或整本下载成 txt 落成书架上的一本书。 */
  function openWkDetail(ref) {
    if (!S.canLibrary) { toast('联网抓取只在桌面版可用'); return; }
    if (!ref) { toast('先填个书号或粘书页链接'); return; }
    src.note = '正在抓这本书…';
    renderSrc();
    S.lib('wk8-detail', { ref: String(ref).trim() }).then(function (r) {
      if (!r || !r.book) { toast('没抓到这本书'); return; }
      st.wk = r;
      renderWkDetail();
    }).catch(function (e) {
      toast('抓不到：' + (e && e.message || e));
      renderSrc();
    });
  }

  function renderWkDetail() {
    var r = st.wk;
    if (!r || !r.book) return;
    var b = r.book;
    var rows = (r.toc || []).map(function (c, i) {
      return '<div class="wk-ch">' +
        '<button class="btn ghost sm" data-act="wk-ch" data-i="' + i + '">读</button>' +
        '<span class="wk-ct">' + esc(c.title) + '</span></div>';
    }).join('');
    var html = '<div class="wk-detail">' +
      '<div class="wk-head">' +
      (b.cover ? '<img class="wk-cover" alt="" src="' + esc(b.cover) + '">' : '<div class="wk-cover ph">无封面</div>') +
      '<div class="wk-meta">' +
      '<div class="wk-title">' + esc(b.title) + '</div>' +
      '<div class="wk-sub">' + esc(b.author || '') + (b.latest ? ' · 最新：' + esc(b.latest) : '') + '</div>' +
      (b.intro ? '<div class="wk-intro">' + esc(b.intro) + '</div>' : '') +
      '<div class="wk-prog2" id="wkProg2" hidden>' +
          '<span class="sp-bar"><i id="wkFill2"></i></span>' +
          '<b id="wkText2">0 / 0</b></div>' +
        '<div class="wk-acts">' +
      '<button class="btn primary sm" data-act="wk-dl">下载整本到书架</button>' +
      '<button class="btn ghost sm" data-act="wk-back">返回书库</button>' +
      '<span class="src-hint">共 ' + (r.tocCount || (r.toc || []).length) + ' 章 · 抓取限速 0.3 秒/章</span>' +
      '</div></div></div>' +
      '<div class="wk-toc-h">目录</div>' +
      '<div class="wk-toc">' + (rows || '<div class="empty-hint">目录是空的（可能要登录，或这个书号不存在）</div>') + '</div>' +
      '<div class="form-acts"><button class="btn" data-act="wk-back">返回书库</button>' +
      '<button class="btn" data-act="close-modal">关闭</button></div>' +
      '</div>';
    var card = document.getElementById('modalCard');
    if (card) {
      card.className = 'modal-card wide wk-card';
      card.innerHTML = html;
    }
  }

  function readWkChapter(i) {
    var r = st.wk;
    if (!r || !r.toc || !r.toc[i]) return;
    var c = r.toc[i];
    toast('正在抓这一章…');
    S.lib('wk8-chapter', { url: c.url, title: c.title }).then(function (ch) {
      if (!ch || !ch.blocks || !ch.blocks.length) { toast('这一章没有正文（可能要登录）'); return; }
      if (window.SFReader && window.SFReader.openText) {
        window.SFReader.openText({
          bookTitle: r.book.title, author: r.book.author,
          title: ch.title || c.title, blocks: ch.blocks
        });
      } else {
        toast('阅读器没准备好');
      }
    }).catch(function (e) { toast('抓不到这一章：' + (e && e.message || e)); });
  }

  /* ---------------- 下载队列：一次只跑一本，其余排队 ---------------- */
  var dq = { items: [], busy: false };

  function dlJobsHtml() {
    if (!dq.items.length) return '';
    return '<div class="dl-jobs" id="dlJobs">' + dq.items.map(function (it) {
      var state = it.state === 'running' ? '进行中'
        : it.state === 'queued' ? '排队中'
        : it.state === 'done' ? '已完成'
        : it.state === 'failed' ? ('失败：' + (it.why || '')) : '';
      return '<div class="dl-job ' + it.state + '">' +
        '<span class="dj-t">《' + esc(it.title) + '》</span>' +
        '<span class="dj-s">' + esc(state) + '</span>' +
        (it.state === 'queued' ? '<button class="btn ghost sm" data-act="dl-cancel" data-id="' + it.id + '">取消</button>' : '') +
        (it.state === 'done' || it.state === 'failed' ? '<button class="btn ghost sm" data-act="dl-dismiss" data-id="' + it.id + '">×</button>' : '') +
        '</div>';
    }).join('') + '</div>';
  }

  function stageText(stage, it) {
    if (stage === 'images') return '正在收尾：抓插图 ' + it.done + ' / ' + it.total;
    if (stage === 'write') return '正在写入书架 ' + it.done + ' / ' + it.total;
    return '正在抓正文';
  }

  function repaintJobs() {
    var box = document.getElementById('dlJobs');
    var host = document.getElementById('libShelfWrap');
    if (!host) return;
    if (!box) {
      host.insertAdjacentHTML('beforebegin', dlJobsHtml());
    } else {
      box.outerHTML = dlJobsHtml();
    }
    /* 顶部大条只服务"当前这一本" */
    var cur1 = dq.items.filter(function (x) { return x.state === 'running'; })[0];
    if (cur1) {
      st.wk = Object.assign({}, st.wk || {}, { book: { title: cur1.title } });
      paintProg(cur1.done, cur1.total);
    }
  }

  function enqueueDl(bid, title, total) {
    dq.items.push({ id: 'd' + Date.now().toString(36), title: title || ('书号 ' + bid), bid: String(bid), state: 'queued', done: 0, total: total || 0 });
    repaintJobs();
    pumpDl();
  }

  function pumpDl() {
    if (dq.busy) return;
    var it = dq.items.filter(function (x) { return x.state === 'queued'; })[0];
    if (!it) { stopDlTick(); hideProg(1500); return; }
    dq.busy = true;
    it.state = 'running';
    st.wk = { book: { title: it.title, bid: it.bid }, toc: new Array(it.total || 1) };
    dlStage = '';
    dlT0 = Date.now();
    repaintJobs();
    S.lib('wk8-download', { ref: it.bid, maxChapters: 0 }).then(function (out) {
      var n = (out && out.chapters) || 0;
      it.total = (out && out.totalChapters) || it.total || n;
      it.done = it.total;
      it.state = 'done';
      var bad = (out && out.failed) || 0;
      toast('《' + it.title + '》下载完成：' + n + ' / ' + it.total + ' 章' + (bad ? '（' + bad + ' 章被限流没抓到）' : ''));
      return loadList().then(function () { paint(); });
    }).catch(function (e) {
      it.state = 'failed';
      it.why = String((e && e.message) || e);
      toast('《' + it.title + '》下载失败：' + it.why);
    }).then(function () {
      dq.busy = false;
      dlStage = '';
      repaintJobs();
      pumpDl();
    });
  }

  function downloadWkBook() {
    var r = st.wk;
    if (!r || !r.book) return;
    var total = (r.toc && r.toc.length) || 0;
    enqueueDl(r.book.bid, r.book.title, total);
    var left = dq.items.filter(function (x) { return x.state === 'queued'; }).length;
    toast(left > 1 ? ('已加入下载队列（前面还有 ' + (left - 1) + ' 本）') : '开始下载：逐章抓取（约 1.6 秒/章），可以先去写别的');
  }

  /* 登录 wenku8：开窗口让用户自己登录，应用不碰账号密码 */
  function wkLogin() {
    if (!S.canLibrary) { toast('登录窗口只在桌面版可用'); return; }
    S.lib('wk8-login', {}).then(function (r) {
      if (!r || !r.ok) { toast('窗口没打开：' + ((r && r.error) || '')); return; }
      toast('窗口已打开：在窗口里登录一次，登录完会自动确认');
      if (src.loginTimer) clearInterval(src.loginTimer);
      var left = 60;
      src.loginTimer = setInterval(function () {
        left -= 1;
        S.lib('wk8-session', {}).then(function (st2) {
          if (st2 && st2.loggedIn) {
            clearInterval(src.loginTimer);
            src.loginTimer = null;
            src.loggedIn = true;
            var el = document.getElementById('wkState');
            if (el) el.textContent = '已登录' + (st2.user ? '：' + st2.user : '') + '，可以搜书名/作者，也可以翻书单';
            toast('登录成功：之后抓取都走这个会话');
            renderSrc();
          } else if (left <= 0) {
            clearInterval(src.loginTimer);
            src.loginTimer = null;
          }
        }).catch(function () { left -= 1; });
      }, 2000);
    }).catch(function (e) { toast('打不开窗口：' + (e && e.message || e)); });
  }

  function wkCheck() {
    var st = document.getElementById('wkState');
    if (st) st.textContent = '正在看会话…';
    S.lib('wk8-session', {}).then(function (r) {
      if (!r || !r.ok) { if (st) st.textContent = '读不到会话：' + ((r && r.error) || '未知'); return; }
      if (r.loggedIn) {
        if (st) st.textContent = '已登录' + (r.user ? '：' + r.user : '（会话里有登录 Cookie）') + '，可以直接搜书名/作者';
        toast('已登录，之后抓取都走这个会话');
      } else if (r.cf) {
        if (st) st.textContent = '过了人机验证，但还没登录：点「登录 wenku8」登一次';
      } else {
        if (st) st.textContent = '还没有登录：点「登录 wenku8」在窗口里登一次';
      }
    }).catch(function (e) { if (st) st.textContent = '检测失败：' + (e && e.message || e); });
  }

  /* wenku8 走"已登录会话"搜索：结果点一下就能打开那本书 */
  function wkCatalog(kind, arg, page) {
    if (!S.canLibrary) { toast('书单只在桌面版可用'); return; }
    var k = kind || 'all';
    var pg = Math.max(1, Number(page) || 1);
    src.catalogKind = k;
    src.catalogPage = pg;
    src.catalogArg = arg || '';
    src.note = k === 'alpha'
      ? ('正在翻「' + (arg || '') + '」开头的书…')
      : (k === 'top' ? '正在翻排行榜…' : '正在翻全部书目…');
    renderSrc();
    S.lib('wk8-listing', { kind: k, alpha: arg || '', page: pg, limit: 60 }).then(function (r) {
      var items = (r && r.items) || [];
      src.catalog = items;
      src.catalogHasNext = !!(r && r.hasNext);
      var diag = (r && r.diag) || null;
      src.note = items.length
        ? ('书单 ' + items.length + ' 本 · ' + (k === 'alpha' ? (arg || '') + ' 开头' : (k === 'top' ? '排行榜' : '全部书目')) + ' · 第 ' + pg + ' 页')
        : ((r && r.error)
          || (diag
            ? ('这一页解析出 0 本（' + diag.bytes + ' 字节' + (diag.login ? ' · 像是登录页' : '')
              + (diag.dump ? ' · 已存页面：' + diag.dump : '') + '）')
            : '这一页没有书'));
      setCatOpen(true);
      renderSrc();
      if (!items.length && r && r.needLogin) toast('这一页要登录：先点「登录」在窗口里登一次');
    }).catch(function (e) {
      src.note = '书单抓取失败：' + ((e && e.message) || e);
      renderSrc();
    });
  }

  function wkSearch(q) {
    src.busy = true;
    src.note = '用已登录的会话搜「' + q + '」…';
    src.results = [];
    renderSrc();
    S.lib('wk8-search', { q: q, limit: 30, by: savedBy() }).then(function (r) {
      src.busy = false;
      var items = (r && r.items) || [];
      src.results = items.map(function (it) {
        return {
          title: it.title,
          extra: 'wenku8 · 书号 ' + it.bid,
          downloadable: false,
          wkRef: String(it.bid),
          note: '点「看这本书」抓目录与正文'
        };
      });
      if (r && r.note) src.backNote = r.note;
      if (items.length) {
        var rawN = (r && r.raw) || items.length;
        src.note = (r && r.loose)
          ? ('「wenku8」' + items.length + ' 条 · 书名没对上的没过滤掉（可能是在作者/简介里命中的）')
          : ('「wenku8」' + items.length + ' 条'
            + (rawN > items.length ? ('（页面上一共 ' + rawN + ' 条，只留书名对得上的 ' + items.length + ' 条）') : ''));
      } else {
        src.note = '没搜到' + (r && r.raw ? ('（页面上 ' + r.raw + ' 条都不相关）') : '')
          + '：要么真没有，要么还没登录 —— 先点「登录」，或直接粘书号 / 书页链接'
          + (r && r.error ? ' · ' + r.error : '');
      }
      renderSrc();
    }).catch(function (e) {
      src.busy = false;
      src.note = '搜索失败：' + (e && e.message || e);
      renderSrc();
    });
  }

  function doSrcSearch() {    if (src.busy) return;
    var sel = document.getElementById('srcProvider');
    var inp = document.getElementById('srcQuery');
    if (!sel || !inp) return;
    var q = (inp.value || '').trim();
    if (!q) { toast('先输个关键词，或者粘一个直链'); return; }
    /* wenku8 用"已登录的会话"搜，走另一条路 */
    if (sel.value === 'wenku8') { wkSearch(q); return; }
    src.busy = true;
    src.note = '搜索中…';
    src.results = [];
    renderSrc();
    /* 兜底看门狗：主进程那边有超时，但网络卡住时别让界面一直"搜索中…" */
    var token = Date.now();
    src.ticket = token;
    setTimeout(function () {
      if (src.busy && src.ticket === token) {
        src.busy = false;
        src.note = '搜索超时（20 秒没回音）。可能网络慢、站点挡了，或者换个关键词。';
        renderSrc();
      }
    }, 20000);
    S.lib('src-search', { provider: sel.value, q: q }).then(function (r) {
      src.busy = false;
      if (!r || !r.ok) {
        src.results = [];
        src.openUrl = (r && r.openUrl) || '';
        src.note = (r && r.error) || '没搜到';
        renderSrc();
        return;
      }
      src.results = r.items || [];
      src.openUrl = r.openUrl || '';
      src.note = '「' + (r.label || sel.value) + '」' + src.results.length + ' 条 · ' + (r.ms || 0) + 'ms' +
        (r.total && r.total > src.results.length ? '（共 ' + r.total + ' 条，只列前 ' + src.results.length + '）' : '');
      renderSrc();
    }).catch(function (e) {
      src.busy = false;
      src.note = '搜索出错：' + (e && e.message || e);
      renderSrc();
    });
  }

  function doSrcDownload(i) {
    var r = src.results[i];
    if (!r) return;
    var sel = document.getElementById('srcProvider');
    toast('正在下载「' + r.title + '」…');
    S.lib('src-download', { provider: sel ? sel.value : '', item: r }).then(function (res) {
      if (res && res.duplicate) { toast('这本书已经在书架上了'); return loadList().then(paint); }
      toast('已加入书架：' + ((res && res.book && res.book.title) || r.title));
      return loadList().then(paint);
    }).catch(function (e) {
      toast('下载失败：' + (e && e.message || e));
    });
  }

  /* 滚轮换书：节流 140ms，和项目书架同一套手感 */
  var wheelAt = 0;
  function bindWheel() {
    var wrap = document.getElementById('libShelfWrap');
    if (!wrap || wrap._sfBound) return;
    wrap._sfBound = true;
    wrap.addEventListener('wheel', function (e) {
      if (!st.books.length) return;
      e.preventDefault();
      var now = Date.now();
      if (now - wheelAt < 140) return;
      wheelAt = now;
      var dy = e.deltaY || e.deltaX;
      move(dy > 0 ? 1 : -1);
    }, { passive: false });
  }

  function paintSelection() {
    var shelf = document.getElementById('libShelf');
    if (!shelf) return;
    var books = shelf.querySelectorAll('.lib-book[data-i]');
    for (var i = 0; i < books.length; i++) {
      books[i].classList.toggle('on', +books[i].getAttribute('data-i') === st.sel);
    }
    var on = shelf.querySelector('.lib-book.on');
    if (on && on.scrollIntoView) {
      try { on.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) { /* 老 Chromium */ }
    }
    /* 信息条整块重画最省事：只在这里，不是每次换书都重建书架 */
    var info = document.querySelector('.shelf-info');
    var u = ui();
    if (!info || !u.openModal) return;
    var cur = st.books[st.sel];
    if (!cur) return;
    var nameEl = info.querySelector('.si-name');
    var metaEl = info.querySelector('.si-meta');
    var acts = info.querySelector('.si-acts');
    if (nameEl) nameEl.innerHTML = esc(cur.title) + (cur.author ? '<span class="chip">' + esc(cur.author) + '</span>' : '');
    if (metaEl) {
      metaEl.innerHTML = esc(cur.srcName || cur.srcPath || '') +
        (cur.note ? '<span class="si-note">' + esc(cur.note) + '</span>' : '');
    }
    if (acts) {
      Array.prototype.forEach.call(acts.querySelectorAll('[data-id]'), function (el) {
        el.setAttribute('data-id', cur.id);
      });
    }
  }

  function move(d) {
    var n = st.books.length;
    if (!n) return;
    st.sel = (st.sel + d + n) % n;
    paintSelection();
  }

  /* ---------------- 动作 ---------------- */

  /* 项目书架的键盘回调是挂在 state.shelfKeys 上的，关掉弹窗时它不一定会清。
     书库要是被这个残留的回调抢走按键，方向键就会去翻项目而不是翻书，所以动手前先清掉。 */
  function clearStaleShelfKeys() {
    try {
      var s = window.SFApp && window.SFApp.debug && window.SFApp.debug().state;
      if (s) s.shelfKeys = null;
    } catch (e) { /* 拿不到就算了 */ }
  }

  function openShelf() {
    if (!S || !S.canLibrary) {
      toast('书库只在桌面版可用（浏览器里没有文件权限）');
      return;
    }
    clearStaleShelfKeys();
    st.sel = 0;
    loadList().then(paint);
  }

  function doImport() {
    if (st.busy) return;
    if (!S || !S.canLibrary) { toast('书库只在桌面版可用'); return; }
    st.busy = true;
    S.lib('pick', {}).then(function (r) {
      if (!r || r.canceled || !r.paths || !r.paths.length) { st.busy = false; return null; }
      toast('正在导入 ' + r.paths.length + ' 个文件…');
      return S.lib('import', { paths: r.paths });
    }).then(function (res) {
      st.busy = false;
      if (!res) return;
      var all = res.added || [];
      var dup = all.filter(function (x) { return x.duplicate; }).length;
      var added = all.length - dup;
      var failed = res.failed || [];
      if (added) {
        var first = all.filter(function (x) { return !x.duplicate; })[0];
        toast('已加入书架：' + added + ' 本' +
          (first && first.book && first.book.note ? '（' + first.book.note + '）' : ''));
      }
      if (dup) toast(dup + ' 本已经在书架上了（按内容判重，没重复导入）');
      failed.forEach(function (f) {
        toast('「' + String(f.file).split(/[\\/]/).pop() + '」没导进来：' + f.error);
      });
      return loadList().then(paint);
    }).catch(function (e) {
      st.busy = false;
      toast('导入出错：' + (e && e.message || e));
    });
  }

  function openBook(id) {
    if (!window.SFReader) { toast('阅读器没加载'); return; }
    var u = ui();
    if (u.closeModal) u.closeModal();
    st.owns = false;
    window.SFReader.open(id);
  }

  /* Electron 里没有 window.confirm / window.prompt（prompt 直接抛错），
     确认和输编码都用自己的小弹窗，别指望浏览器对话框。 */
  function backToShelf() {
    loadList().then(paint);
  }

  function removeBook(id) {
    var b = null;
    st.books.forEach(function (x) { if (x.id === id) b = x; });
    if (!b) return;
    var u = ui();
    if (!u.openModal) return;
    st.owns = true;
    u.openModal('<h3>移除《' + esc(b.title) + '》？</h3>' +
      '<p class="hint">只删 StoryForge 书架里的副本、目录和阅读进度；' +
      '你磁盘上的源文件一个字节都不会动。</p>' +
      '<div class="form-acts">' +
      '<button class="btn" data-act="lib-back">取消</button>' +
      '<button class="btn danger" data-act="lib-remove-yes" data-id="' + esc(id) + '">移除</button>' +
      '</div>', 'wide');
  }

  function reparse(id) {
    var b = null;
    st.books.forEach(function (x) { if (x.id === id) b = x; });
    if (!b) return;
    var u = ui();
    if (!u.openModal) return;
    st.owns = true;
    u.openModal('<h3>换个编码重读</h3>' +
      '<p class="hint">满屏方块或者一堆「锟斤拷」的时候用这个。留空 = 重新自动探测。</p>' +
      '<div class="form-row"><label>编码</label>' +
      '<input id="libEnc" type="text" value="' + esc(b.encoding || '') + '" placeholder="留空=自动探测"></div>' +
      '<div class="hint">常用：<code>gb18030</code>（多数中文老 txt）、<code>utf-8</code>、<code>big5</code>（繁体）</div>' +
      '<div class="form-acts">' +
      '<button class="btn" data-act="lib-back">取消</button>' +
      '<button class="btn primary" data-act="lib-reparse-go" data-id="' + esc(id) + '">重新解析</button>' +
      '</div>', 'wide');
    var inp = document.getElementById('libEnc');
    if (inp) { inp.focus(); inp.select(); }
  }

  function doReparse(id, enc) {
    S.lib('reparse', { id: id, encoding: (enc || '').trim() }).then(function (r) {
      toast('已重读' + ((r && r.book && r.book.encoding) ? '，编码：' + r.book.encoding : ''));
      return loadList().then(paint);
    }).catch(function (e) { toast('重读失败：' + (e && e.message || e)); });
  }

  /* ---------------- 事件 ---------------- */

  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;

    /* 顶栏入口 */
    if (t.closest('#btnLibrary') || t.closest('[data-act="open-library"]')) {
      e.preventDefault();
      openShelf();
      return;
    }
    if (!isOpen()) return;

    var el = t.closest('[data-act]');
    if (!el) return;
    var act = el.getAttribute('data-act');
    var id = el.getAttribute('data-id');

    if (act === 'lib-book') {
      var i = +el.getAttribute('data-i');
      if (i === st.sel) openBook(id);
      else { st.sel = i; paintSelection(); }
      return;
    }
    if (act === 'lib-open') { openBook(id); return; }
    if (act === 'src-search') { doSrcSearch(); return; }
    if (act === 'src-go') {
      var qv = (document.getElementById('srcQuery') || {}).value || '';
      qv = String(qv).trim();
      if (!qv) { toast('写点什么：书名、作者、书号或书页链接'); return; }
      var mRef = qv.match(/wenku8\.(?:net|com|cc)\/book\/(\d+)/i);
      var mId = qv.match(/^(?:id=)?(\d{1,6})$/);
      if (mRef) { openWkDetail(mRef[1]); return; }
      if (mId) { openWkDetail(mId[1]); return; }
      var pv = (document.getElementById('srcProvider') || {}).value || '';
      if (pv === 'wenku8') { wkSearch(qv); return; }
      doSrcSearch();
      return;
    }
    if (act === 'wk-cat-toggle') {
      setCatOpen(!catOpen());
      var isWkP = ((document.getElementById('srcProvider') || {}).value || '') === 'wenku8';
      catSync(isWkP);
      if (catOpen() && !src.catalog.length) wkCatalog('all', '', 1);
      return;
    }
    if (act === 'wk-page') {
      var d = Number(el.getAttribute('data-d')) || 1;
      var np = Math.max(1, (src.catalogPage || 1) + d);
      if (d > 0 && !src.catalogHasNext) { toast('已经是最后一页了'); return; }
      wkCatalog(src.catalogKind || 'all', src.catalogArg || '', np);
      return;
    }
    if (act === 'wk-cat') {
      var kk = el.getAttribute('data-kind');
      var aa = el.getAttribute('data-alpha') || '';
      wkCatalog(kk, aa, 1);
      return;
    }
    if (act === 'wkc-open') {
      openWkDetail(el.getAttribute('data-bid'));
      return;
    }
    if (act === 'wk-open') {
      var qi = document.getElementById('srcQuery');
      openWkDetail(qi ? qi.value : '');
      return;
    }
    if (act === 'wk-login') { wkLogin(); return; }
    if (act === 'wk-check') { wkCheck(); return; }
    if (act === 'wk-book') { openWkDetail(el.getAttribute('data-ref') || ''); return; }
    if (act === 'wk-ch') { readWkChapter(+el.getAttribute('data-i')); return; }
    if (act === 'wk-dl') { downloadWkBook(); return; }
    if (act === 'wk-back') { st.wk = null; paint(); return; }
    if (act === 'src-dl') { doSrcDownload(+el.getAttribute('data-i')); return; }
    if (act === 'src-open') {
      var sr = src.results[+el.getAttribute('data-i')];
      if (sr && sr.url) {
        S.lib('src-open', { url: sr.url }).catch(function (err) { toast('打不开：' + (err && err.message || err)); });
      }
      return;
    }
    if (act === 'dl-dismiss') {
        var did = el.getAttribute('data-id');
        dq.items = dq.items.filter(function (x) { return x.id !== did; });
        repaintJobs();
        return;
      }
      if (act === 'dl-cancel') {
        var cid = el.getAttribute('data-id');
        dq.items = dq.items.filter(function (x) { return !(x.id === cid && x.state === 'queued'); });
        repaintJobs();
        return;
      }
      if (act === 'web-open') {
      var sel2 = document.getElementById('srcProvider');
      var inp2 = document.getElementById('srcQuery');
      var payload = { source: (sel2 && sel2.value) || 'wenku8', q: (inp2 && inp2.value) || '' };
      S.lib('web-open', payload).then(function (r) {
        if (r && r.ok === false) { toast('打不开：' + (r.error || '')); return; }
        toast('窗口开了：登录或搜出结果页后，回来点「搜索 / 打开」。');
      }).catch(function (e) { toast('打不开：' + (e && e.message || e)); });
      return;
    }
    if (act === 'lib-import') { doImport(); return; }
    if (act === 'lib-back') { backToShelf(); return; }
    if (act === 'lib-remove-yes') {
      S.lib('remove', { id: id }).then(function () {
        toast('已移除');
        return loadList().then(paint);
      }).catch(function (e) { toast('移除失败：' + (e && e.message || e)); });
      return;
    }
    if (act === 'lib-reparse-go') {
      var inp = document.getElementById('libEnc');
      doReparse(id, inp ? inp.value : '');
      return;
    }
    if (act === 'lib-remove') { removeBook(id); return; }
    if (act === 'lib-reparse') { reparse(id); return; }
    if (act === 'lib-update') {
      var upId = el.getAttribute('data-id') || id;
      toast('正在检查更新…');
      S.lib('wk8-update', { id: upId }).then(function (r) {
        if (!r || !r.ok) { toast('检查失败：' + ((r && r.error) || '未知原因')); return; }
        if (!r.added) { toast('已是最新（线上 ' + r.remote + ' 章，本地 ' + r.local + ' 章）'); return; }
        toast('发现 ' + r.added + ' 章新内容（线上 ' + r.remote + '，本地 ' + r.local + '）');
        uiModal('<h3>更新到最新？</h3>' +
          '<p class="hint">《' + esc(r.title || '这本书') + '》线上共 ' + r.remote + ' 章，本地已有 ' + r.local + ' 章。' +
          '只补新增的 ' + r.added + ' 章，已有章节不动。</p>' +
          '<div class="form-acts"><button class="btn" data-act="close-modal">算了</button>' +
          '<button class="btn primary" data-act="lib-update-go" data-id="' + esc(upId) + '">更新到最新（' + r.added + ' 章）</button></div>', 'wide');
      }).catch(function (e) { toast('检查失败：' + ((e && e.message) || e)); });
      return;
    }

    if (act === 'lib-update-go') {
      var goId = el.getAttribute('data-id');
      uiClose();
      showProg(0, 0);
      toast('开始更新：只抓新增章节');
      S.lib('wk8-update', { id: goId, apply: true }).then(function (r) {
        hideProg(1200);
        if (!r || !r.ok) { toast('更新失败：' + ((r && r.error) || '未知原因')); return; }
        toast('更新完成：新增 ' + (r.written || 0) + ' 章，现在共 ' + (r.sectionCount || r.local) + ' 章');
        loadList().then(paint);
      }).catch(function (e) { hideProg(0); toast('更新失败：' + ((e && e.message) || e)); });
      return;
    }

    if (act === 'lib-fiximg') {
      var fixId = el.getAttribute('data-id') || id;
      toast('正在补插图…');
      S.lib('repair-images', { id: fixId }).then(function (r) {
        if (!r || r.ok === false) { toast('补插图失败：' + ((r && r.error) || '')); return; }
        var msg = '插图处理完成：正文插入 ' + (r.inline || 0) + ' 张';
        if (r.failed) msg += '，' + r.failed + ' 张没抓到（保留了原地址一行）';
        if (r.residue) msg += '，清掉 ' + r.residue + ' 行残片';
        toast(msg);
        return loadList().then(paint);
      }).catch(function (e) { toast('补插图失败：' + ((e && e.message) || e)); });
      return;
    }
    if (act === 'lib-reveal') {
      S.lib('reveal', { id: id }).then(function () { toast('已在资源管理器里定位'); })
        .catch(function (err) { toast('定位失败：' + (err && err.message || err)); });
      return;
    }
  });

  /* 键盘：只在书库弹窗开着时接管。Escape 交回 app.js（它负责关弹窗）。 */
  function keys(e) {
    if (!isOpen()) return false;
    if (e.key === 'Escape') return false;
    /* 小弹窗（确认移除 / 换编码）里不接管方向键 */
    if (!document.getElementById('libShelf')) return false;
    if (e.target && e.target.closest && e.target.closest('input, textarea')) return false;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); move(-1); return true; }
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); move(1); return true; }
    if (e.key === 'Enter') {
      var cur = st.books[st.sel];
      if (cur) { e.preventDefault(); openBook(cur.id); return true; }
    }
    return false;
  }

  /* 拖拽导入：Electron 32+ 没有 File.path 了，用 preload 暴露的 sfBridge.pathFor(File)。
     浏览器里没有这条路（拿不到真实路径），给一句说明。 */
  function droppedPaths(dt) {
    const out = [];
    if (!dt) return out;
    const files = dt.files ? Array.prototype.slice.call(dt.files) : [];
    files.forEach((f) => {
      let p = '';
      if (window.sfBridge && window.sfBridge.pathFor) {
        try { p = window.sfBridge.pathFor(f) || ''; } catch (e) { p = ''; }
      }
      if (!p) p = f.path || '';
      if (p) out.push(p);
    });
    return out;
  }

  function dropHint(on) {
    var box = document.getElementById('libDropHint');
    if (!box) return;
    box.classList.toggle('on', !!on);
  }

  document.addEventListener('dragover', function (e) {
    if (!isOpen()) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    dropHint(true);
  });
  document.addEventListener('dragleave', function (e) {
    if (!isOpen()) return;
    if (e.target === document.documentElement || e.target === document.body) dropHint(false);
  });
  document.addEventListener('drop', function (e) {
    if (!isOpen()) return;
    e.preventDefault();
    dropHint(false);
    var paths = droppedPaths(e.dataTransfer);
    if (!paths.length) {
      toast(window.sfBridge && window.sfBridge.pathFor
        ? '没认出拖进来的文件，试试用「导入文件」'
        : '浏览器版拿不到文件路径，请用「导入文件」或装桌面版');
      return;
    }
    toast('正在导入 ' + paths.length + ' 个文件…');
    S.lib('import', { paths: paths }).then(function (r) {
      var added = (r && r.added) || [];
      var failed = (r && r.failed) || [];
      if (added.length) toast('已导入 ' + added.length + ' 本' + (failed.length ? '，' + failed.length + ' 个失败' : ''));
      else if (failed.length) toast('导入失败：' + failed[0].error);
      return loadList().then(paint);
    }).catch(function (err) {
      toast('导入失败：' + (err && err.message || err));
    });
  });

  /* 演示/截图用：假装正在下载某一本（只画界面，不改数据） */
  function __demoDl(total, done) {
    st.wk = { book: { title: 'Re：从零开始的异世界生活 01', bid: '1' }, toc: new Array(total || 234) };
    paintProg(done || 37, total || 234);
    hideProg(90000);
  }

  function __demoJobs() {
    dq.items = [
      { id: 'd1', title: 'Re：从零开始的异世界生活 01', bid: '1', state: 'running', done: 137, total: 234 },
      { id: 'd2', title: '文学少女', bid: '1', state: 'queued', done: 0, total: 213 }
    ];
    dlStage = 'images';
    dlT0 = Date.now() - 120000;
    repaintJobs();
  }

  return {
    __demoDl: __demoDl,
    __demoJobs: __demoJobs,
    open: openShelf,
    keys: keys,
    isOpen: isOpen,
    state: st,
    reload: function () { return loadList().then(paint); }
  };
})();
