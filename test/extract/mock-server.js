/* 假模型服务（抽取链路测试用，由 test/extract/run.js 以子进程启动）
   用法：node test/extract/mock-server.js 8791
   行为：读请求里最后一个 user 消息，按其中的 [blockId] 行造"逐字引用"的 JSON；
        正文里出现 BADJSON 且不是重试请求时，故意返回一段非 JSON 的话。 */
const http = require('http');

const PORT = Number(process.argv[2] || 8791);

function blocksFrom(text) {
  const out = [];
  const re = /\[([A-Za-z0-9_-]+)\]\s*([^\n]+)/g;
  let m;
  while ((m = re.exec(text))) out.push({ id: m[1], line: m[2] });
  return out;
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    let p = {};
    try { p = JSON.parse(body); } catch (e) { /* ignore */ }
    const user = ((p.messages || []).find((m) => m.role === 'user') || {}).content || '';
    const isRetry = /上一次你没有返回合法 JSON/.test(user);
    const blocks = blocksFrom(user);

    let content;
    if (/BADJSON/.test(user) && !isRetry) {
      content = '好的，我先分析一下这段文字的意思，然后再说结论。';
    } else {
      const items = [];
      blocks.slice(0, 3).forEach((b, i) => {
        const sentence = (b.line.split(/[。！？]/).filter((s) => s.trim().length > 6)[0] || b.line).trim();
        items.push({
          entity: ['沈砚', '老周', '摊主'][i % 3],
          field: i === 0 ? '位置' : '已知信息',
          from: '—',
          to: i === 0 ? '城南旧货市场' : '账本里有自己的名字',
          block_id: b.id,
          quote: sentence,
          confidence: i === 2 ? 0.42 : 0.88
        });
      });
      if (blocks.length) {
        items.push({ entity: '沈砚', field: '生死', to: '已故', block_id: blocks[0].id, quote: '这句根本不在正文里', confidence: 0.9 });
        items.push({ entity: '沈砚', field: '生死', to: '已故', block_id: 'b-does-not-exist', quote: blocks[0].line, confidence: 0.9 });
      }
      content = JSON.stringify(items);
    }

    res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('ready ' + PORT);
});
