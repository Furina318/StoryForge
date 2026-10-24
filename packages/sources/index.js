'use strict';
/**
 * 联网找书：provider 接口 + 几个现成的源。
 *
 * 设计原则（跟书库其它部分一致）：
 *   - **能下载的就真下载**（古登堡计划：公有领域，epub/txt 直链）；
 *   - **不能下载的就诚实说清**（wenku8 有 Cloudflare 人机验证、wensuoge 常年不可达），
 *     只给"在浏览器里打开搜索页"的链接，不假装抓到了正文；
 *   - 所有网络请求都走主进程（渲染进程是 file://，跨域会被拦），带超时与体积上限；
 *   - 抓回来的字节一律交给书库的 importFile，跟本地导入走同一条路（判重、落副本、切目录都在那里）。
 *
 * provider 形状：
 *   { id, label, note, canDownload, search(q, opts) -> { ok, items[], error?, openUrl? } }
 *   items: { id, title, author, extra, format, downloadable, url, downloadUrl, note }
 */

const UA = 'StoryForge/0.3 (+local novel workbench; contact: none)';
const TIMEOUT_MS = 15000;
const MAX_BYTES = 60 * 1024 * 1024;

function timeout(ms) {
  /* 不用 AbortSignal.timeout：Electron 的 node 版本差异会让它报 "terminated"，
     自己拿 AbortController + setTimeout 最稳。 */
  const ctl = new AbortController();
  const t = setTimeout(() => { try { ctl.abort(); } catch (e) { /* 已经结束了 */ } }, ms);
  ctl.signal._clear = () => clearTimeout(t);
  return ctl.signal;
}

async function getBuffer(url, opts) {
  const o = opts || {};
  const signal = timeout(o.timeout || TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      headers: Object.assign({ 'user-agent': UA, accept: o.accept || '*/*' }, o.headers || {}),
      redirect: 'follow',
      signal: signal
    });
    if (!r.ok) {
      const e = new Error('HTTP ' + r.status + '（' + url + '）');
      e.status = r.status;
      throw e;
    }
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error('文件太大（' + Math.round(buf.length / 1048576) + ' MB），先不下载');
    return { buf, headers: r.headers, status: r.status };
  } catch (e) {
    if (e && (e.name === 'AbortError' || /aborted|terminated/i.test(String(e.message)))) {
      throw new Error('请求超时（' + Math.round((o.timeout || TIMEOUT_MS) / 1000) + ' 秒）：' + url);
    }
    throw e;
  } finally {
    if (signal._clear) signal._clear();
  }
}

async function getJson(url, opts) {
  const { buf } = await getBuffer(url, Object.assign({ accept: 'application/json' }, opts));
  return JSON.parse(buf.toString('utf8'));
}

async function getText(url, opts) {
  const { buf } = await getBuffer(url, opts);
  return buf.toString('utf8');
}

/* ---------------- 古登堡计划（可下载） ---------------- */

/* gutendex 只索引到某个时间点，新书（比如 "Im Bernsteinwald" #79837）它在 search 里搜不到，
   但 gutenberg 站内搜索能命中。所以：先用 gutendex（快、结构化），0 条时退一次站内搜索页——
   只解析 <li class="booklink"> 里的 id / 标题 / 作者 / 语言，不抓正文，且做了节流。 */
let lastHtmlSearch = 0;
function parseGutenbergSearch(html) {
  const out = [];
  const re = /<li class="booklink">([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = re.exec(html))) {
    const chunk = m[1];
    const idm = chunk.match(/href="\/ebooks\/(\d+)"/i);
    if (!idm) continue;
    const id = Number(idm[1]);
    const title = (chunk.match(/<span class="title">([\s\S]*?)<\/span>/i) || [, ''])[1].replace(/<[^>]+>/g, '').trim();
    const author = (chunk.match(/<span class="subtitle">([\s\S]*?)<\/span>/i) || [, ''])[1].replace(/<[^>]+>/g, '').trim();
    const extra = (chunk.match(/<span class="extra">([\s\S]*?)<\/span>/i) || [, ''])[1].replace(/<[^>]+>/g, '').trim();
    if (!title) continue;
    const lang = (/German/i.test(title + ' ' + extra) ? 'de' : (/French/i.test(title + ' ' + extra) ? 'fr' : 'en'));
    out.push({
      id: 'g' + id,
      gutId: id,
      title: title.replace(/\s*\((German|French|English|Dutch|Italian|Spanish)\)\s*$/i, ''),
      author,
      extra: [author, lang, extra].filter(Boolean).join(' · ').slice(0, 120),
      format: 'epub',
      downloadable: true,
      url: 'https://www.gutenberg.org/ebooks/' + id,
      downloadUrl: 'https://www.gutenberg.org/cache/epub/' + id + '/pg' + id + '.epub',
      note: 'EPUB'
    });
  }
  return out;
}

const gutenberg = {
  id: 'gutenberg',
  label: '古登堡计划 · Project Gutenberg',
  note: '公有领域的老书（英文为主），可以直接下载 epub / txt 进书架。',
  canDownload: true,
  async search(q) {
    const query = String(q || '').trim();
    const items = [];
    let total = 0;
    try {
      const j = await getJson('https://gutendex.com/books?search=' + encodeURIComponent(query));
      total = j.count || 0;
      (j.results || []).slice(0, 20).forEach((b) => {
        const f = b.formats || {};
        const epub = f['application/epub+zip'] || '';
        const txt = f['text/plain; charset=utf-8'] || f['text/plain; charset=us-ascii'] || f['text/plain'] || '';
        const author = (b.authors && b.authors[0] && b.authors[0].name) || '';
        items.push({
          id: 'g' + b.id,
          gutId: b.id,
          title: b.title || ('#' + b.id),
          author,
          extra: [author, (b.languages || []).join('/'), b.download_count ? '下载 ' + b.download_count : '']
            .filter(Boolean).join(' · '),
          format: epub ? 'epub' : (txt ? 'txt' : ''),
          downloadable: !!(epub || txt),
          url: 'https://www.gutenberg.org/ebooks/' + b.id,
          downloadUrl: epub || txt,
          note: epub ? 'EPUB' : (txt ? 'TXT' : '这个版本没有可直接下载的文本')
        });
      });
    } catch (e) {
      /* gutendex 挂了还有站内搜索兜底 */
    }

    if (!items.length) {
      /* 站内搜索：同一 query 3 秒内只打一次，避免把人家站点打烦 */
      const wait = 3000 - (Date.now() - lastHtmlSearch);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastHtmlSearch = Date.now();
      const html = await getText(
        'https://www.gutenberg.org/ebooks/search/?query=' + encodeURIComponent(query),
        { headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) StoryForge/0.3' } }
      );
      const found = parseGutenbergSearch(html);
      found.forEach((x) => items.push(x));
      total = Math.max(total, items.length);
    }

    return {
      ok: items.length > 0,
      items,
      total,
      error: items.length ? '' : '古登堡里没搜到（换个作者名或原名试试，比如德语书名）',
      openUrl: 'https://www.gutenberg.org/ebooks/search/?query=' + encodeURIComponent(query)
    };
  },
  async download(item) {
    if (!item || (!item.downloadUrl && !item.gutId)) throw new Error('这条结果没有可下载的地址');
    /* gutenberg.org 直链偶尔会掐连接（本机实测 1/3 概率 "terminated"），
       所以先试更稳的 /cache/epub/<id>/pg<id>.epub，再退回 gutendex 给的地址；每次失败重试一次。 */
    const urls = [];
    if (item.gutId) urls.push('https://www.gutenberg.org/cache/epub/' + item.gutId + '/pg' + item.gutId + '.epub');
    if (item.downloadUrl) urls.push(item.downloadUrl);
    let lastErr = null;
    for (const u of urls) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const { buf } = await getBuffer(u, { timeout: 90000 });
          if (buf.length < 1024) throw new Error('下载到的文件太小（' + buf.length + ' 字节）');
          return { buf, name: safeName(item.title, item.format) };
        } catch (e) {
          lastErr = e;
          await new Promise((r) => setTimeout(r, 600));
        }
      }
    }
    throw new Error('下载失败：' + ((lastErr && lastErr.message) || '未知原因'));
  }
};

/* ---------------- 中文站：能搜就给链接，抓不到就说清楚 ---------------- */

function chineseStub(cfg) {
  return {
    id: cfg.id,
    label: cfg.label,
    note: cfg.note,
    canDownload: false,
    /* 内嵌浏览器用：把「在站点里搜这个词」的地址交给主进程去开窗 */
    searchUrlOf(q) { return cfg.searchUrl(q); },
    async search(q, opts) {
      /* 先试一下站点通不通：通了也只解析"结果链接"，不抓正文；
         不通就把真实原因（403 人机验证 / DNS 失败）原样带回去。 */
      const url = cfg.searchUrl(q);
      try {
        const r = await fetch(url, {
          headers: { 'user-agent': UA, accept: 'text/html' },
          redirect: 'follow',
          signal: timeout(12000)
        });
        if (r.status === 403) {
          return { ok: false, items: [], openUrl: url, error: cfg.blockedHint || '站点有人机验证（HTTP 403），应用内抓不到搜索结果' };
        }
        if (!r.ok) return { ok: false, items: [], openUrl: url, error: 'HTTP ' + r.status };
        const raw = Buffer.from(await r.arrayBuffer());
        const ct = String(r.headers.get('content-type') || '');
        const asGbk = /gbk|gb2312|gb18030/i.test(ct) || cfg.gbk;
        const html = asGbk ? decodeGbk(raw) : raw.toString('utf8');
        if (cfg.loginHint && /login\.php|请先登录|请登录后/i.test(html)) {
          return { ok: false, items: [], openUrl: url, error: cfg.loginHint };
        }
        const items = cfg.parse(html).slice(0, 20);
        if (!items.length) {
          return { ok: false, items: [], openUrl: url, error: '页面拿到了，但没解析出结果（站点结构可能变了）' };
        }
        return { ok: true, items, total: items.length, openUrl: url };
      } catch (e) {
        return { ok: false, items: [], openUrl: url, error: '连不上：' + ((e && e.message) || e) };
      }
    },
    async download() {
      throw new Error('这个源只给搜索结果，不提供直接下载（请用浏览器打开链接）');
    }
  };
}

function decodeGbk(buf) {
  try { return new TextDecoder('gbk').decode(buf); } catch (e) { return buf.toString('utf8'); }
}

const wenku8 = chineseStub({
  id: 'wenku8',
  label: '轻小说文库 · wenku8',
  note: '轻小说为主（Re:Zero 这类）。站点有 Cloudflare 人机验证，应用内通常搜不到；会给一个能直接在浏览器打开的搜索链接。',
  blockedHint: 'wenku8 有人机验证（Cloudflare），应用内抓不到搜索结果；用下面的链接在浏览器里搜，抓下来的文件再用「导入文件」加进来',
  gbk: true,
  loginHint: 'wenku8 的搜索需要登录，应用内拿不到结果；用下面的链接在浏览器里搜（登录后），文件下好再用「导入文件」加进来',
  searchUrl: (q) => 'https://www.wenku8.net/modules/article/search.php?searchkey=' + encodeURIComponent(q),
  parse: (html) => {
    const out = [];
    const re = /<a[^>]+href="([^"]*(?:book|article)[^"]*)"[^>]*>([\s\S]{1,80}?)<\/a>/gi;
    let m;
    while ((m = re.exec(html)) && out.length < 20) {
      const title = m[2].replace(/<[^>]+>/g, '').trim();
      if (!title || title.length < 2) continue;
      if (out.some((x) => x.title === title)) continue;
      out.push({
        id: 'w' + out.length, title, author: '', extra: 'wenku8',
        format: '', downloadable: false,
        url: m[1].indexOf('http') === 0 ? m[1] : ('https://www.wenku8.net' + m[1]),
        downloadUrl: '', note: '只给链接'
      });
    }
    return out;
  }
});

const wensuoge = chineseStub({
  id: 'wensuoge',
  label: '文书阁 · wensuoge',
  note: '中文电子书搜索站。域名经常变、也常不可达；应用内只做"搜一下 + 给链接"。',
  blockedHint: 'wensuoge 不可达或换了域名；用下面的链接在浏览器里试',
  loginHint: 'wensuoge 需要登录才能看结果；用下面的链接在浏览器里搜',
  searchUrl: (q) => 'https://www.wensuoge.com/search?q=' + encodeURIComponent(q),
  parse: (html) => {
    const out = [];
    const re = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]{1,80}?)<\/a>/gi;
    let m;
    while ((m = re.exec(html)) && out.length < 20) {
      const title = m[2].replace(/<[^>]+>/g, '').trim();
      if (!title || title.length < 2) continue;
      if (/^(首页|登录|注册|下一页|上一页)$/.test(title)) continue;
      if (out.some((x) => x.title === title)) continue;
      out.push({
        id: 's' + out.length, title, author: '', extra: 'wensuoge',
        format: '', downloadable: false,
        url: m[1].indexOf('http') === 0 ? m[1] : ('https://www.wensuoge.com' + m[1]),
        downloadUrl: '', note: '只给链接'
      });
    }
    return out;
  }
});

/* ---------------- 直链兜底：任何 URL ---------------- */

const direct = {
  id: 'direct',
  label: '直链下载',
  note: '把任意 epub / txt / pdf 直链粘进来，直接下到书架。浏览器里搜到的资源可以用这条。',
  canDownload: true,
  async search(q) {
    const url = String(q || '').trim();
    if (!/^https?:\/\//i.test(url)) {
      return { ok: false, items: [], error: '粘一个 http(s) 开头的直链' };
    }
    const name = (url.split(/[?#]/)[0].split('/').pop() || 'download').slice(-80);
    return {
      ok: true,
      items: [{
        id: 'd1', title: name, author: '', extra: url,
        format: (/\.epub(3)?(\b|\.)/i.test(url) ? 'epub' : (/\.pdf(\b|\.)/i.test(url) ? 'pdf' : 'txt')),
        downloadable: true, url, downloadUrl: url, note: '直链'
      }]
    };
  },
  async download(item) {
    const { buf } = await getBuffer(item.downloadUrl, { timeout: 60000 });
    return { buf, name: safeName(item.title, item.format) };
  }
};

const PROVIDERS = { gutenberg, wenku8, wensuoge, direct };

function safeName(title, format) {
  const t = String(title || 'book').replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'book';
  const ext = format === 'epub' ? '.epub' : (format === 'pdf' ? '.pdf' : '.txt');
  return t + ext;
}

function list() {
  return Object.keys(PROVIDERS).map((k) => {
    const p = PROVIDERS[k];
    return { id: p.id, label: p.label, note: p.note, canDownload: !!p.canDownload };
  });
}

function get(id) {
  const p = PROVIDERS[id];
  if (!p) throw new Error('没有这个书源：' + id);
  return p;
}

async function search(id, q) {
  const p = get(id);
  const query = String(q || '').trim();
  if (!query) return { ok: false, items: [], error: '先输入关键词或链接' };
  const t0 = Date.now();
  const r = await p.search(query);
  return Object.assign({ provider: p.id, label: p.label, ms: Date.now() - t0 }, r);
}

async function download(id, item) {
  const p = get(id);
  const r = await p.download(item);
  return { buf: r.buf, name: r.name };
}

/** 内嵌浏览器要打开的地址：能站内搜的就搜，不能的给主页 */
function webUrl(id, q) {
  const p = PROVIDERS[id];
  if (!p) throw new Error('没有这个书源：' + id);
  const query = String(q || '').trim();
  if (query && typeof p.searchUrlOf === 'function') return p.searchUrlOf(query);
  if (p.id === 'gutenberg') {
    return query
      ? 'https://www.gutenberg.org/ebooks/search/?query=' + encodeURIComponent(query)
      : 'https://www.gutenberg.org/';
  }
  if (p.id === 'wenku8') return query ? p.searchUrlOf(query) : 'https://www.wenku8.net/';
  if (p.id === 'wensuoge') return query ? p.searchUrlOf(query) : 'https://www.wensuoge.com/';
  return query || 'https://www.gutenberg.org/';
}

module.exports = { list, get, search, download, webUrl, safeName, decodeGbk, MAX_BYTES };
