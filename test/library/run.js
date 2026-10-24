'use strict';
/**
 * 书库自测：不依赖 Electron，纯 node 跑。
 *
 *   node test/library/run.js [--verbose]
 *
 * 只测"能把文件变成书"这一段纯逻辑（探测 / 解码 / 切目录 / 写节 / 读回），
 * DB 和 IPC 交给 Electron 里手测——那部分需要真窗口。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LIB = require('../../packages/library/index.js');
const registry = require('../../packages/library/registry.js');
const toc = require('../../packages/library/toc.js');
const enc = require('../../packages/library/encoding.js');
const sections = require('../../packages/library/sections.js');

const VERBOSE = process.argv.indexOf('--verbose') >= 0;
let pass = 0;
let fail = 0;

function ok(name, cond, extra) {
  if (cond) {
    pass++;
    if (VERBOSE) console.log('  ✓ ' + name);
  } else {
    fail++;
    console.log('  ✗ ' + name + (extra == null ? '' : '\n      ' + extra));
  }
}

function group(title) {
  if (VERBOSE) console.log('\n' + title);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-lib-'));

/* ---------------- 1. 解码 ---------------- */

group('编码');
{
  const utf8 = Buffer.from('第一章 起风了\n\n他推开门。', 'utf8');
  const r1 = enc.decodeText(utf8);
  ok('utf-8 原样解出', r1.text.indexOf('第一章 起风了') === 0, r1.text.slice(0, 20));
  ok('utf-8 记了编码', /utf-?8/i.test(r1.enc || ''), r1.enc);

  /* '第一章' 的 GBK 字节：B5 DA D2 BB D5 C2 —— 故意不给 BOM、扩展名也说谎 */
  const gbk = Buffer.from([0xb5, 0xda, 0xd2, 0xbb, 0xd5, 0xc2, 0x0a, 0x0a, 0x0b]);
  const r2 = enc.decodeText(gbk);
  ok('GBK 字节能认出「第一章」', /第一章/.test(r2.text), JSON.stringify(r2.text) + ' enc=' + r2.enc);

  const u16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('第一章', 'utf16le')]);
  const r3 = enc.decodeText(u16);
  ok('UTF-16LE 带 BOM 解对', r3.text.trim() === '第一章', JSON.stringify(r3.text));

  const bin = Buffer.alloc(512);
  for (let i = 0; i < bin.length; i++) bin[i] = (i * 37) & 0xff;
  ok('二进制能算出比例', enc.binaryRatio(bin) > 0.05, String(enc.binaryRatio(bin)));
}

/* ---------------- 2. txt 目录 ---------------- */

group('txt 目录');
{
  const txt = [
    '第一章 起风了',
    '　　' + '他推开门。'.repeat(30),
    '',
    '第二章 夜路',
    '　　' + '路上没有人。'.repeat(30),
    '',
    '第三章 归途',
    '　　' + '远处有灯。'.repeat(30)
  ].join('\n');

  const r = toc.parseTxt(txt);
  ok('切出 3 节', r.sections.length === 3, 'sections=' + r.sections.length);
  ok('第一节标题对', r.sections[0] && r.sections[0].title === '第一章 起风了', r.sections[0] && r.sections[0].title);
  ok('目录来源是正则', r.tocSource === 'txt-regex', r.tocSource);
  ok('字数统计非零', r.stats.chars > 0, String(r.stats.chars));
  ok('标题没重复进正文',
    !(r.sections[0].blocks[0] && r.sections[0].blocks[0].text.indexOf('第一章') === 0),
    r.sections[0].blocks[0] && r.sections[0].blocks[0].text.slice(0, 12));

  /* 没有章节标记的长文 → 自动分段，绝不能只给一节（那样整本都在一个 dom 里） */
  const long = Array.from({ length: 120 }, (_, i) => '第' + i + '段，' + '随便写点东西。'.repeat(6)).join('\n\n');
  const r2 = toc.parseTxt(long);
  ok('无目录长文自动分段', r2.sections.length > 1, 'sections=' + r2.sections.length);
  ok('自动分段标了来源', r2.tocSource === 'auto', r2.tocSource);
}

/* ---------------- 3. md 目录（围栏不能被当成标题） ---------------- */

group('md 目录');
{
  const md = [
    '---',
    'title: 测试手册',
    'author: 某人',
    '---',
    '',
    '# 第一章',
    '正文一。',
    '',
    '```js',
    '# 这行是注释，不是标题',
    'var a = 1;',
    '```',
    '',
    '## 1.1 小节',
    '正文二。',
    '',
    '# 第二章',
    '正文三。'
  ].join('\n');

  const r = toc.parseMd(md);
  ok('frontmatter 取到书名', r.title === '测试手册', r.title);
  ok('frontmatter 取到作者', r.author === '某人', r.author);
  ok('按 # 切出 2 节', r.sections.length === 2, 'sections=' + r.sections.length);
  ok('目录来源是 md 标题', r.tocSource === 'md-heading', r.tocSource);
  const all = JSON.stringify(r.sections);
  ok('代码块里的 # 没变成标题', !/这行是注释/.test(JSON.stringify(r.sections.map((s) => s.title))),
    JSON.stringify(r.sections.map((s) => s.title)));
  ok('代码块内容保留为 code 块', /"kind":"code"/.test(all));
}

/* ---------------- 4. 探测：认不出的给 external，绝不报"导入失败" ---------------- */

group('格式探测');
{
  const d1 = registry.parse(Buffer.from('第一章\n正文他推开门。', 'utf8'), { ext: 'txt', size: 20, name: 'a.txt' });
  ok('txt 命中 txt 适配器', d1.adapter === 'txt', d1.adapter + ' score=' + d1.adapterScore);

  const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64)]);
  const d2 = registry.parse(pdf, { ext: 'txt', size: pdf.length, name: '骗人的.txt' });
  ok('魔数优先于扩展名（假 txt 真 pdf）', d2.adapter === 'pdf', d2.adapter);
  ok('pdf 走 paged 渲染', d2.render === 'paged', d2.render);

  const exe = Buffer.alloc(256);
  for (let i = 0; i < exe.length; i++) exe[i] = (i * 91 + 7) & 0xff;
  const d3 = registry.parse(exe, { ext: 'bin', size: exe.length, name: 'x.bin' });
  ok('二进制落到 external', d3.adapter === 'external', d3.adapter);
  ok('external 说明能读懂', /系统/.test(d3.note || ''), d3.note);

  const md = registry.parse(Buffer.from('# 标题\n\n正文', 'utf8'), { ext: 'md', size: 12, name: 'a.md' });
  ok('md 走 richtext 渲染', md.adapter === 'md' && md.render === 'richtext', md.adapter + '/' + md.render);
}

/* ---------------- 5. 端到端：文件 → 书 → 节 → 读回 ---------------- */

group('导入 → 落盘 → 读回');
{
  const root = path.join(tmp, 'library');
  const src = path.join(tmp, 'novel.txt');
  const body = [
    '第一章 起风了',
    '　　' + '他推开门。'.repeat(60),
    '',
    '第二章 夜路',
    '　　' + '路上没有人。'.repeat(60)
  ].join('\n');
  fs.writeFileSync(src, body, 'utf8');
  const stBefore = fs.statSync(src);

  const res = LIB.importFile(LIB.ensureRoot(root), src, {});
  ok('导入拿到一本书', !!(res && res.book && res.book.id), JSON.stringify(res && res.book && res.book.id));
  ok('书里有 2 节', res.book.sectionCount === 2, String(res.book.sectionCount));
  ok('目录 2 条', res.toc.length === 2, JSON.stringify(res.toc.map((t) => t.title)));
  ok('format=txt / render=text', res.book.format === 'txt' && res.book.render === 'text',
    res.book.format + '/' + res.book.render);

  const sec = LIB.readSection(root, res.book.id, 1);
  ok('读第 2 节读得到', !!(sec && sec.blocks && sec.blocks.length), JSON.stringify(sec && sec.title));
  ok('第 2 节标题是「第二章 夜路」', sec && sec.title === '第二章 夜路', sec && sec.title);
  ok('第 2 节正文对得上', sec && /路上没有人/.test(sec.blocks[0].text), sec && sec.blocks[0].text.slice(0, 12));

  const stAfter = fs.statSync(src);
  ok('源文件没被写过（字节数不变）', stAfter.size === stBefore.size, stBefore.size + ' → ' + stAfter.size);
  ok('源文件没被写过（mtime 不变）', stAfter.mtimeMs === stBefore.mtimeMs);

  ok('落盘节数一致', LIB.countSections(root, res.book.id) === 2, String(LIB.countSections(root, res.book.id)));

  /* 超大节必须被切开：不然一节 5 万字，阅读视图一次要画几千个 p */
  const fat = [{ title: '巨节', blocks: Array.from({ length: 4000 }, (_, i) => ({ kind: 'para', text: '第' + i + '段。' })) }];
  const capped = sections.capSections(fat);
  ok('超大节被切开', capped.length > 1, 'sections=' + capped.length);
  ok('切开后标题带（续）', /续/.test(capped[1].title), capped[1].title);

  /* 换编码重读：id 不变，内容变 */
  const badSrc = path.join(tmp, 'gbk.txt');
  fs.writeFileSync(badSrc, Buffer.from([0xb5, 0xda, 0xd2, 0xbb, 0xd5, 0xc2, 0x0a, 0xb5, 0xda, 0xb6, 0xfe, 0xd5, 0xc2]));
  const r2 = LIB.importFile(root, badSrc, {});
  ok('GBK 文件也进得来', !!r2.book.id);
  ok('GBK 内容没变成乱码', /第[一二]章/.test(JSON.stringify(r2.toc)), JSON.stringify(r2.toc));

  const rep = LIB.reparse(root, r2.book, badSrc, 'gb18030');
  ok('重读后 id 不变', rep.book.id === r2.book.id);
  ok('重读后有目录', rep.toc.length >= 2, JSON.stringify(rep.toc));

  LIB.removeBook(root, res.book.id);
  ok('删书删掉目录', LIB.countSections(root, res.book.id) === 0);
}

/* ---------------- 6. 名字清理 ---------------- */

group('杂项');
{
  const d = registry.parse(Buffer.from('# 标题\n\n正文', 'utf8'), { ext: 'MD', size: 10, name: 'x.MD' });
  ok('扩展名大小写不敏感', d.adapter === 'md', d.adapter);
  const t = registry.parse(Buffer.alloc(0), { ext: '', size: 0, name: '空' });
  ok('空文件也不崩', !!t && !!t.adapter, t && t.adapter);
}

/* ---------------- 7. EPUB ---------------- */

group('EPUB');
{
  /* 手写一个 store-only（不压缩）的 zip：我们的解包器不依赖 zlib 也能读，
     顺手也验证了 method 0 那条分支。CRC32 老老实实算。 */
  const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();
  function crc32(buf) {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  }
  function zipStore(entries) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    entries.forEach((en) => {
      const nameBuf = Buffer.from(en.name, 'utf8');
      const data = Buffer.from(en.data, 'utf8');
      const crc = crc32(data);
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0);
      lh.writeUInt16LE(20, 4);
      lh.writeUInt16LE(0, 6);
      lh.writeUInt16LE(0, 8);                       // method 0 = stored
      lh.writeUInt16LE(0, 10);
      lh.writeUInt16LE(0, 12);
      lh.writeUInt32LE(crc, 14);
      lh.writeUInt32LE(data.length, 18);
      lh.writeUInt32LE(data.length, 22);
      lh.writeUInt16LE(nameBuf.length, 26);
      lh.writeUInt16LE(0, 28);
      locals.push(lh, nameBuf, data);

      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0);
      ch.writeUInt16LE(20, 4);
      ch.writeUInt16LE(20, 6);
      ch.writeUInt16LE(0, 8);
      ch.writeUInt16LE(0, 10);
      ch.writeUInt16LE(0, 12);
      ch.writeUInt16LE(0, 14);
      ch.writeUInt32LE(crc, 16);
      ch.writeUInt32LE(data.length, 20);
      ch.writeUInt32LE(data.length, 24);
      ch.writeUInt16LE(nameBuf.length, 28);
      ch.writeUInt16LE(0, 30);
      ch.writeUInt16LE(0, 32);
      ch.writeUInt16LE(0, 34);
      ch.writeUInt16LE(0, 36);
      ch.writeUInt32LE(0, 38);
      ch.writeUInt32LE(offset, 42);
      centrals.push(ch, nameBuf);
      offset += 30 + nameBuf.length + data.length;
    });
    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([Buffer.concat(locals), cd, eocd]);
  }

  const OPF = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>测试之书</dc:title><dc:creator>某人</dc:creator><dc:language>zh</dc:language>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="ch1" href="Text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="Text/ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="cv" href="Text/cover.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="cv"/><itemref idref="ch1"/><itemref idref="ch2"/>
  </spine>
</package>`;

  const NCX = `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>
    <navPoint id="n1"><navLabel><text>第一章 起点</text></navLabel><content src="Text/ch1.xhtml"/>
      <navPoint id="n1a"><navLabel><text>第一节 屋里</text></navLabel><content src="Text/ch1.xhtml#a"/></navPoint>
    </navPoint>
    <navPoint id="n2"><navLabel><text>第二章 归来</text></navLabel><content src="Text/ch2.xhtml"/></navPoint>
  </navMap>
</ncx>`;

  const CH1 = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>标题</title></head>
<body><h1>第一章 起点</h1>
<p>光芒&nbsp;、照进屋里。他从柜台上抬起头，看见尘埃在光里慢慢地落。外面有人在敲门，敲了三下，停一停，又敲了三下。他把手里的活儿放下，站起来，走到门边，却没有立刻去开。银发&nbsp;少女站着，手里拿着一本&amp;旧书。她说她从很远的北边来，路上走了十一天，脚上起过泡，后来又结了痂。她说她只是想找一个会修书的人，把这本书里缺的那一页补上。</p>
</body></html>`;

  const CH2 = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>未知</title></head>
<body><p>他推开门，外面在下雨。雨点砸在石阶上，溅起一层白汽。屋檐下的水汇成一条线，顺着砖缝往低处流。他站在门口看了一会儿，没有急着出去。街上没什么人，只有远处一盏灯还亮着，被雨糊成一团。他想起很多年前也有过这样一个雨天，那时候他还小，站在同一个门口，等一个不会回来的人。雨越下越大，把台阶上的灰冲得干干净净。</p><p>他把伞收起来，靠在门边，回头看了一眼桌上那本合着的书。书脊朝里，书口朝外，像是不想被人翻开。他走过去，把书翻过来，掌心压住封皮，停了一会儿才松开。</p></body></html>`;

  const COVER = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>封面</title></head>
<body><p>封面</p></body></html>`;

  const CONTAINER = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

  const epubBuf = zipStore([
    { name: 'mimetype', data: 'application/epub+zip' },
    { name: 'META-INF/container.xml', data: CONTAINER },
    { name: 'OEBPS/content.opf', data: OPF },
    { name: 'OEBPS/toc.ncx', data: NCX },
    { name: 'OEBPS/Text/ch1.xhtml', data: CH1 },
    { name: 'OEBPS/Text/ch2.xhtml', data: CH2 },
    { name: 'OEBPS/Text/cover.xhtml', data: COVER }
  ]);

  const ePubRoot = path.join(tmp, 'lib-epub');
  fs.mkdirSync(ePubRoot, { recursive: true });

  const epubPath = path.join(tmp, 'test.epub');
  fs.writeFileSync(epubPath, epubBuf);


  const d = registry.parse(epubBuf, { ext: 'epub', size: epubBuf.length, name: 'test.epub' });
  ok('epub 被认出来', d.adapter === 'epub', d.adapter);
  ok('书名取自 OPF', d.title === '测试之书', d.title);
  ok('作者取自 OPF', d.author === '某人', d.author);
  ok('封面页被丢掉（太短）', d.sections && d.sections.length === 2,
    d.sections && JSON.stringify(d.sections.map((x) => x.title)));
  ok('第一章标题来自 NCX', d.sections && d.sections[0].title === '第一章 起点',
    d.sections && d.sections[0].title);
  ok('第二章标题来自 NCX', d.sections && d.sections[1].title === '第二章 归来',
    d.sections && d.sections[1].title);

  const text1 = d.sections && d.sections[0].blocks
    ? d.sections[0].blocks.map((b) => b.text).join('\n') : '';
  ok('中文标点前的空格被清掉', /光芒、照进屋里/.test(text1), JSON.stringify(text1.slice(0, 40)));
  ok('两个汉字之间的空格被清掉', /银发少女站着/.test(text1), JSON.stringify(text1.slice(0, 60)));
  ok('实体被解开（&amp; → &）', /一本&旧书/.test(text1), JSON.stringify(text1.slice(0, 80)));

  /* 改名成 .txt 也照样按内容认出来 */
  const renamed = registry.parse(epubBuf, { ext: 'txt', size: epubBuf.length, name: '伪装.txt' });
  ok('改名 .txt 仍按 epub', renamed.adapter === 'epub', renamed.adapter);

  /* 走一遍完整导入：落盘 + 目录 */
  const imp = LIB.importFile(ePubRoot, epubPath, {});
  ok('epub 能导入书架', !!(imp && imp.book && imp.book.id), imp && imp.book && imp.book.id);
  ok('导入后目录 2 节', !!(imp && imp.toc && imp.toc.length === 2),
    imp && imp.toc && JSON.stringify(imp.toc.map((t) => t.title)));
  const sec0 = imp && LIB.readSection(ePubRoot, imp.book.id, 0);
  ok('导入后能读回第一节', !!(sec0 && sec0.blocks && sec0.blocks.length),
    sec0 && sec0.blocks && sec0.blocks.length);
  if (imp && imp.book) LIB.removeBook(ePubRoot, imp.book.id);
}

/* 收尾 */
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 临时目录，删不掉无所谓 */ }

console.log('\n书库自测：' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail ? 1 : 0);
