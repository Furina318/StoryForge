/* StoryForge 抽取核心（纯函数 + 一次 HTTP 调用）
   放在包里而不是 app.js 里，是为了能在 Node 下用假模型跑端到端测试：
   浏览器里 file:// 页面直连 http://127.0.0.1 会被 CORS/PNA 拦，Electron 走主进程代理没问题。

   契约（与 docs/v0.1.0-规则设计文档.md §抽取契约 一致）：
   - 模型必须返回 JSON 数组，每项含 entity / field / from / to / block_id / quote / confidence
   - block_id 必须存在于本章，quote 必须是该段正文的连续子串
   - 校验不过 => 丢弃并计数；置信 < LOW_CONF => 保留但标 low，默认不勾选
*/
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SFExtract = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var CHUNK_CHARS = 1800;
  var LOW_CONF = 0.7;
  var MIN_QUOTE = 4;
  var MAX_QUOTE = 200;

  function normQuote(s) {
    return String(s || '').replace(/\s+/g, '').replace(/[「」『』“”"'‘’]/g, '');
  }

  /* 按字数把段落切成若干窗（保持段落完整，不要在一段中间切） */
  function splitChunks(blocks, limit) {
    var max = limit || CHUNK_CHARS;
    var out = [], cur = [], size = 0;
    (blocks || []).forEach(function (b) {
      var n = (b.text || '').length;
      if (cur.length && size + n > max) { out.push(cur); cur = []; size = 0; }
      cur.push(b);
      size += n;
    });
    if (cur.length) out.push(cur);
    return out;
  }

  function systemPrompt(names) {
    return '你是小说一致性抽取器。从给定正文里抽取"状态变化"，只输出 JSON 数组，不要任何解释或代码块标记。\n' +
      '每条形如 {"entity":"角色名","field":"生死|位置|已知信息|持有物","from":"旧值或空","to":"新值","block_id":"b3-2","quote":"原文整句","confidence":0.0~1.0}\n' +
      '硬性要求：\n' +
      '1) entity 必须是这些名字之一：' + (names || []).join('、') + '；\n' +
      '2) block_id 只能是给你的方括号里的 id，不许自己造；\n' +
      '3) quote 必须是那一小段里逐字出现的完整句子，不许改写、缩写、拼接、省略号；\n' +
      '4) 只在文本明确写出时抽：传闻（有人说/听说/据说/据称）、假设（如果/假如）、回忆里的既往状态都不算"现在发生了变化"；\n' +
      '5) 拿不准就不要抽。没有可抽的输出 []。';
  }

  function userPrompt(chapter, blocks, attempt) {
    var body = (blocks || []).map(function (b) { return '[' + b.id + '] ' + b.text; }).join('\n\n');
    var head = '【第 ' + chapter.idx + ' 章 ' + chapter.title + '（片段 ' + ((attempt || 0) + 1) + '）】\n';
    var tail = attempt ? '\n\n注意：上一次你没有返回合法 JSON。这次只输出一个 JSON 数组。' : '';
    return head + body + tail;
  }

  /* 宽松解析：容忍 ```json 围栏、前后废话；解析不出数组则返回 null（触发重试） */
  function parseList(text) {
    var t = String(text || '').trim();
    if (!t) return null;
    var a = t.indexOf('['), b = t.lastIndexOf(']');
    if (a >= 0 && b > a) t = t.slice(a, b + 1);
    try {
      var v = JSON.parse(t);
      return Array.isArray(v) ? v : null;
    } catch (e) {
      return null;
    }
  }

  /* 证据校验：不过的丢弃。返回 {kept, dropped:[{item,why}]} */
  function validate(blocks, arr, chapter) {
    var byId = {};
    (blocks || []).forEach(function (b) { byId[b.id] = b; });
    var kept = [], dropped = [];
    (arr || []).forEach(function (it) {
      if (!it || !it.entity || !it.to) { dropped.push({ item: it, why: '缺字段' }); return; }
      var b = byId[it.block_id];
      if (!b) { dropped.push({ item: it, why: 'block 不存在:' + it.block_id }); return; }
      var q = String(it.quote || '');
      var nq = normQuote(q);
      if (!q) { dropped.push({ item: it, why: '没有 quote' }); return; }
      if (normQuote(b.text).indexOf(nq) < 0) { dropped.push({ item: it, why: 'quote 不在原文' }); return; }
      if (nq.length < MIN_QUOTE) { dropped.push({ item: it, why: 'quote 太短' }); return; }
      if (q.length > MAX_QUOTE) { dropped.push({ item: it, why: 'quote 太长' }); return; }
      var conf = typeof it.confidence === 'number' ? it.confidence : 0.5;
      conf = Math.max(0.05, Math.min(0.95, conf));
      kept.push({
        entity: String(it.entity),
        field: String(it.field || '已知信息'),
        from: String(it.from || '—'),
        to: String(it.to).slice(0, 40),
        block: b.id,
        quote: q,
        chapter: (chapter && chapter.idx) || 0,
        conf: conf,
        low: conf < LOW_CONF,
        checked: false
      });
    });
    return { kept: kept, dropped: dropped };
  }

  /* 去重：同 entity+field+to 视为同一条 */
  function dedupe(list, existing) {
    var seen = {};
    (existing || []).forEach(function (p) { seen[p.entity + '|' + p.field + '|' + p.to] = 1; });
    var out = [];
    (list || []).forEach(function (p) {
      var k = p.entity + '|' + p.field + '|' + p.to;
      if (seen[k]) return;
      seen[k] = 1;
      out.push(p);
    });
    /* 高置信在前，低置信垫底 */
    out.sort(function (a, b) { return (b.low ? 0 : 1) - (a.low ? 0 : 1) || b.conf - a.conf; });
    return out;
  }

  /* 一次 HTTP 调用。默认用 fetch（浏览器/Electron 都有），
     但 Node 侧测试可传 transport:'http' 走 http 模块——
     本机 node v24 + undici 在进程退出时会踩 libuv 断言，绕开它测试才干净。 */
  function callViaHttp(url, headers, payload) {
    var http = require(url.indexOf('https:') === 0 ? 'https' : 'http');
    var u = new URL(url);
    return new Promise(function (resolve, reject) {
      var req = http.request({
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'POST',
        headers: headers
      }, function (res) {
        var body = '';
        res.setEncoding('utf8');
        res.on('data', function (d) { body += d; });
        res.on('end', function () {
          if (res.statusCode < 200 || res.statusCode >= 300) { reject(new Error('HTTP ' + res.statusCode)); return; }
          resolve(body);
        });
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  function callOnce(opts) {
    var url = String(opts.baseURL || '').replace(/\/+$/, '') + '/chat/completions';
    var headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (opts.apiKey || '') };
    var payload = JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      max_tokens: opts.maxTokens || 1200,
      temperature: opts.temperature == null ? 0.2 : opts.temperature,
      stream: false
    });
    var useHttp = opts.transport === 'http' || typeof fetch === 'undefined';
    var p = useHttp
      ? callViaHttp(url, headers, payload)
      : fetch(url, { method: 'POST', headers: headers, body: payload }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      });
    return p.then(function (text) {
      /* 兼容服务端强制流式：把 data: 行拼起来 */
      if (text.indexOf('data:') === 0) {
        var acc = '';
        text.split('\n').forEach(function (line) {
          var t = line.trim();
          if (t.indexOf('data:') !== 0) return;
          var p = t.slice(5).trim();
          if (p === '[DONE]') return;
          try {
            var j = JSON.parse(p);
            var d = j.choices && j.choices[0] && j.choices[0].delta;
            if (d && d.content) acc += d.content;
          } catch (e) { /* 忽略 */ }
        });
        return acc;
      }
      var j = JSON.parse(text);
      var c = j.choices && j.choices[0];
      return (c && ((c.message && c.message.content) || c.text)) || '';
    });
  }

  /* 跑一章：分窗 → 每窗最多两次（第二次带提醒）→ 汇总 */
  function runChapter(opts) {
    var blocks = opts.blocks || [];
    var chunks = splitChunks(blocks, opts.chunkChars || CHUNK_CHARS);
    var names = (opts.entities || []).map(function (e) { return e.name; }).filter(Boolean);
    var stats = { chunks: chunks.length, calls: 0, retries: 0, dropped: 0, bad: 0 };
    var all = [];

    function step(i) {
      if (i >= chunks.length) {
        var fresh = dedupe(all, opts.existing || []);
        return Promise.resolve({ kept: fresh, stats: stats });
      }
      return ask(chunks[i], 0).then(function (res) {
        all = all.concat(res);
        return step(i + 1);
      });
    }

    function ask(chunk, attempt) {
      stats.calls += 1;
      if (attempt > 0) stats.retries += 1;
      return callOnce({
        baseURL: opts.baseURL,
        apiKey: opts.apiKey,
        model: opts.model,
        transport: opts.transport,
        messages: [
          { role: 'system', content: systemPrompt(names) },
          { role: 'user', content: userPrompt(opts.chapter, chunk, attempt) }
        ]
      }).then(function (text) {
        var arr = parseList(text);
        if (!arr) {
          if (attempt < 1) return ask(chunk, attempt + 1);
          stats.bad += 1;
          return [];
        }
        var v = validate(chunk, arr, opts.chapter);
        stats.dropped += v.dropped.length;
        return v.kept;
      });
    }

    return step(0);
  }

  return {
    CHUNK_CHARS: CHUNK_CHARS,
    LOW_CONF: LOW_CONF,
    normQuote: normQuote,
    splitChunks: splitChunks,
    parseList: parseList,
    validate: validate,
    dedupe: dedupe,
    systemPrompt: systemPrompt,
    userPrompt: userPrompt,
    callOnce: callOnce,
    runChapter: runChapter
  };
});
