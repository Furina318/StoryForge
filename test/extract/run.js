/* 抽取链路端到端测试：起一个假模型服务（子进程），走真实 HTTP，验证
   ① 合法 JSON 全部入库 ② 证据不合格的丢弃 ③ 低置信标 low ④ 非 JSON 重试一次
   ⑤ 长章节分窗 ⑥ 去重 ⑦ 解析器容错
   用法：node test/extract/run.js [--verbose]
   说明：假模型故意放在子进程里——本机 node v24 在进程内关 http server 会踩 libuv 断言，
        主进程只做 fetch，退出才干净。 */
const { spawn } = require('child_process');
const path = require('path');
const FE = require('../../packages/extract/index.js');

const VERBOSE = process.argv.indexOf('--verbose') >= 0;
const PORT = 8791 + Math.floor(Math.random() * 80);

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.log('  ✗ ' + name + (extra ? '  → ' + JSON.stringify(extra) : '')); }
}

const CHAPTER = {
  idx: 1,
  title: '缺笔的字',
  blocks: [
    { id: 'b1-1', text: '沈砚在阁楼里补一页缺笔的手稿。他修过四千多本书，从未见过这样一页。' },
    { id: 'b1-2', text: '老周推门进来，把一只搪瓷杯放在柜台上。他说，这书不干净。' },
    { id: 'b1-3', text: '沈砚没有回话。他翻开第三页，看见一个不属于任何人的名字。' }
  ]
};

function startMock() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'mock-server.js'), String(PORT)], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    const timer = setTimeout(() => reject(new Error('假模型 5s 内没起来')), 5000);
    child.stdout.on('data', (d) => {
      out += String(d);
      if (out.indexOf('ready') >= 0) { clearTimeout(timer); resolve(child); }
    });
    child.stderr.on('data', (d) => process.stderr.write('[mock] ' + d));
    child.on('exit', (code) => { if (code) reject(new Error('假模型退出 code=' + code)); });
  });
}

(async () => {
  const child = await startMock();
  const base = 'http://127.0.0.1:' + PORT + '/v1';
  const common = {
    baseURL: base, apiKey: 'sk-test', model: 'mock', transport: 'http',
    chapter: CHAPTER, entities: [{ name: '沈砚' }, { name: '老周' }]
  };

  console.log('抽取链路（假模型 @ ' + base + '）');

  /* 1. 正常一章 */
  const r1 = await FE.runChapter(Object.assign({ blocks: CHAPTER.blocks }, common));
  ok('三段正文抽出 3 条', r1.kept.length === 3, { got: r1.kept.length, stats: r1.stats });
  ok('两条证据不合格被丢弃', r1.stats.dropped === 2, r1.stats);
  ok('低置信标 low 且排在最后', r1.kept[2].low === true && r1.kept[0].conf >= 0.8, r1.kept.map((k) => k.conf));
  ok('quote 都逐字来自原文', r1.kept.every((k) => CHAPTER.blocks.some((b) => b.text.indexOf(k.quote) >= 0)));
  if (VERBOSE) console.log(JSON.stringify(r1, null, 2));

  /* 2. 非 JSON → 重试一次 */
  const ch2 = { idx: 2, title: '第二个字', blocks: [{ id: 'b2-1', text: 'BADJSON 沈砚把灯吹灭了，屋里黑下来。他听见楼下有人上楼。' }] };
  const r2 = await FE.runChapter(Object.assign({}, common, { chapter: ch2, blocks: ch2.blocks }));
  ok('非法 JSON 触发重试', r2.stats.retries === 1, r2.stats);
  ok('重试后成功入库', r2.kept.length >= 1, r2.kept);

  /* 3. 长章节分窗 */
  const long = [];
  for (let i = 0; i < 30; i++) long.push({ id: 'b9-' + i, text: '第' + i + '段：他沿着旧货市场往里走，摊主们在收摊，没有人抬头看他。' });
  const ch3 = { idx: 9, title: '长章', blocks: long };
  const r3 = await FE.runChapter(Object.assign({}, common, { chapter: ch3, blocks: long, chunkChars: 600 }));
  ok('长章节切成多窗', r3.stats.chunks > 1, r3.stats);
  ok('每窗都调用了模型', r3.stats.calls >= r3.stats.chunks, r3.stats);

  /* 4. 去重 */
  const dup = FE.dedupe(
    [{ entity: '沈砚', field: '位置', to: '市场', conf: 0.9 }, { entity: '沈砚', field: '位置', to: '市场', conf: 0.8 }],
    [{ entity: '沈砚', field: '位置', to: '市场' }]
  );
  ok('已确认的同一条不再出现', dup.length === 0, dup);

  /* 5. 解析器容错 */
  ok('解析器吃 ```json 围栏', (FE.parseList('好的\n```json\n[{"a":1}]\n```') || []).length === 1);
  ok('解析器对纯废话返回 null', FE.parseList('我不知道你在说什么。') === null);

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  try { child.kill(); } catch (e) { /* ignore */ }
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e && e.message);
  process.exit(1);
});
