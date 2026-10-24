/* StoryForge v0.1.0 — 模型调用层（渲染进程侧）
 *
 * 只有一件事：把"用户的 Key + 三个模型槽位"变成一次可取消的流式补全。
 *
 * 通道选择：
 *   Electron —— 走主进程（window.sfBridge.llm），用 Node 的 fetch 发请求。
 *               这样做有两个必要理由：渲染进程发跨域请求会被 CORS 拦，
 *               以及 Key 不该在页面上下文里被第三方脚本读到。
 *   浏览器   —— 直接 fetch（file:// 下大概率被 CORS 拦，错误信息要说清楚，
 *               不要让人以为是 Key 填错了）。
 *
 * 事件形状（主进程 → 渲染进程）：
 *   { type:'delta', runId, text }
 *   { type:'done',  runId, usage:{prompt_tokens, completion_tokens}, text }
 *   { type:'error', runId, message }
 */
window.SFLLM = (function () {
  'use strict';

  var bridge = (window.sfBridge && window.sfBridge.llm) || null;
  var listeners = [];
  var seq = 0;

  function dispatch(msg) {
    listeners.slice().forEach(function (fn) {
      try { fn(msg); } catch (e) { }
    });
  }

  if (bridge && bridge.onEvent) {
    bridge.onEvent(dispatch);
  }

  function norm(settings) {
    var s = settings || {};
    return {
      baseURL: String(s.baseURL || '').replace(/\/+$/, ''),
      apiKey: String(s.apiKey || ''),
      model: s.model || (s.slots && s.slots.draft) || '',
      timeout: Math.max(5, Math.min(600, +s.timeout || 120))
    };
  }

  function configured(settings) {
    var s = norm(settings);
    return !!(s.baseURL && s.apiKey);
  }

  /* 连接测试：优先 /models（便宜、几乎是常数成本）；有的网关不实现，
     就退回一次 max_tokens=1 的最小补全。 */
  function ping(settings) {
    var s = norm(settings);
    if (!s.baseURL) return Promise.resolve({ ok: false, message: '还没填 Base URL' });
    if (bridge) {
      return bridge.invoke('ping', { settings: s }).then(function (r) {
        return r && typeof r === 'object' ? r : { ok: false, message: '主进程没有返回结果' };
      }).catch(function (e) {
        return { ok: false, message: String(e && e.message || e) };
      });
    }
    return fetchPing(s);
  }

  function isGemini(s) {
    return /generativelanguage\.googleapis\.com/i.test((s && s.baseURL) || '') || /^gemini/i.test((s && s.model) || '');
  }

  function geminiBody(s, o) {
    var sys = [];
    var contents = [];
    (o.messages || []).forEach(function (m) {
      if (!m) return;
      if ((m.role || 'user') === 'system') { sys.push(String(m.content || '')); return; }
      contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(m.content || '') }] });
    });
    var body = { contents: contents.length ? contents : [{ role: 'user', parts: [{ text: 'ping' }] }] };
    if (sys.length) body.systemInstruction = { parts: [{ text: sys.join('\n\n') }] };
    body.generationConfig = {
      maxOutputTokens: Math.max(16, Math.min(8192, o.maxTokens || 2000)),
      temperature: o.temperature == null ? 0.9 : o.temperature
    };
    return body;
  }

  function geminiBase(s) {
    return String(s.baseURL || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
  }

  function fetchPing(s) {
    var started = Date.now();
    var pingUrl = isGemini(s)
      ? geminiBase(s) + '/models?key=' + encodeURIComponent(s.apiKey || '')
      : s.baseURL + '/models';
    return fetch(pingUrl, {
      headers: isGemini(s) ? {} : (s.apiKey ? { Authorization: 'Bearer ' + s.apiKey } : {})
    }).then(function (r) {
      if (r.status === 401 || r.status === 403) return { ok: false, status: r.status, message: 'Key 无效或没有权限（HTTP ' + r.status + '）' };
      if (!r.ok) return { ok: false, status: r.status, message: 'HTTP ' + r.status };
      return r.json().then(function (j) {
        var models = isGemini(s) ? ((j && j.models) || []) : ((j && j.data) || []);
        return {
          ok: true, status: r.status, ms: Date.now() - started,
          models: models.map(function (m) {
            return isGemini(s) ? String(m.name || '').replace(/^models\//, '') : m.id;
          }).filter(Boolean).slice(0, 40)
        };
      });
    }).catch(function (e) {
      return {
        ok: false,
        message: '请求被浏览器拦住了：' + String(e && e.message || e) +
          '（file:// 直开没有 CORS 头，接真 API 请用 Electron 版）'
      };
    });
  }

  /* 发起一次流式补全。返回 {id, cancel()} */
  function chat(opts) {
    var o = opts || {};
    var s = norm(o.settings);
    var id = 'run' + (++seq);
    var cancelled = false;

    function emit(msg) { dispatch(msg); }

    if (!configured(s)) {
      setTimeout(function () {
        emit({ type: 'error', runId: id, message: '还没配置 API Key' });
      }, 0);
      return { id: id, cancel: function () { cancelled = true; } };
    }

    if (bridge) {
      bridge.invoke('chat', {
        runId: id,
        settings: s,
        model: o.model || s.model,
        messages: o.messages || [],
        maxTokens: o.maxTokens || 2000,
        temperature: o.temperature == null ? 0.9 : o.temperature
      }).catch(function (e) {
        if (!cancelled) emit({ type: 'error', runId: id, message: String(e && e.message || e) });
      });
      return {
        id: id,
        cancel: function () {
          cancelled = true;
          try { bridge.invoke('cancel', { runId: id }); } catch (e) { }
        }
      };
    }

    /* 浏览器直连：能跑通就算赚到，跑不通给出可执行的建议 */
    if (isGemini(s)) {
      var gctrl = new AbortController();
      var gtimer = setTimeout(function () { gctrl.abort(); }, s.timeout * 1000);
      var gurl = geminiBase(s) + '/models/' + encodeURIComponent(o.model || s.model || 'gemini-2.5-flash') +
        ':generateContent?key=' + encodeURIComponent(s.apiKey || '');
      fetch(gurl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(geminiBody(s, o)),
        signal: gctrl.signal
      }).then(function (r) {
        return r.json().then(function (j) {
          if (!r.ok) {
            var msg = (j && j.error && j.error.message) || ('HTTP ' + r.status);
            throw new Error(msg);
          }
          var parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
          var text = parts.map(function (p) { return p.text || ''; }).join('');
          if (text) emit({ type: 'delta', runId: id, text: text });
          emit({ type: 'done', runId: id, text: text });
        });
      }).catch(function (e) {
        if (!cancelled) {
          emit({
            type: 'error', runId: id,
            message: String(e && e.message || e) + '（file:// 直开可能被 CORS 拦，接真 API 请用 Electron 版）'
          });
        }
      }).then(function () { clearTimeout(gtimer); });
      return {
        id: id,
        cancel: function () { cancelled = true; try { gctrl.abort(); } catch (e) { } }
      };
    }

    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, s.timeout * 1000);
    fetch(s.baseURL + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + s.apiKey
      },
      body: JSON.stringify({
        model: o.model || s.model,
        messages: o.messages || [],
        max_tokens: o.maxTokens || 2000,
        temperature: o.temperature == null ? 0.9 : o.temperature,
        stream: true
      }),
      signal: ctrl.signal
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + '：' + (r.status === 401 ? 'Key 无效' : '接口返回错误'));
      var reader = r.body.getReader();
      var dec = new TextDecoder();
      var buf = '';
      var acc = '';
      function pump() {
        return reader.read().then(function (res) {
          if (res.done) {
            clearTimeout(timer);
            emit({ type: 'done', runId: id, text: acc });
            return;
          }
          buf += dec.decode(res.value, { stream: true });
          var lines = buf.split('\n');
          buf = lines.pop();
          lines.forEach(function (line) {
            var t = line.trim();
            if (!t || t.indexOf('data:') !== 0) return;
            var payload = t.slice(5).trim();
            if (payload === '[DONE]') return;
            try {
              var j = JSON.parse(payload);
              var d = j.choices && j.choices[0] && j.choices[0].delta;
              if (d && d.content) { acc += d.content; emit({ type: 'delta', runId: id, text: d.content }); }
            } catch (e) { }
          });
          return pump();
        });
      }
      return pump();
    }).catch(function (e) {
      clearTimeout(timer);
      if (cancelled) return;
      emit({
        type: 'error', runId: id,
        message: '请求失败：' + String(e && e.message || e) +
          (/Failed to fetch|NetworkError/.test(String(e)) ? '（浏览器直连被 CORS 拦，接真 API 请用 Electron 版）' : '')
      });
    });

    return {
      id: id,
      cancel: function () { cancelled = true; try { ctrl.abort(); } catch (e) { } }
    };
  }

  /* 多个调用方（生成、文风分析）可能同时订阅：用监听器数组，onEvent 返回退订函数 */
  function onEvent(fn) {
    listeners.push(fn);
    return function () {
      var i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  return {
    available: !!bridge,
    configured: configured,
    ping: ping,
    chat: chat,
    onEvent: onEvent,
    norm: norm
  };
})();
