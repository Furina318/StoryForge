/* 把 content/补字人/chNN.md 汇编成 apps/ui/content.js
   用法：node scripts/build-content.js
   规则：
   - 空行分段；以 # 开头的行是注释（不会进正文）。
   - 顶格 `@@place:xxx` / `@@actor:甲,乙` / `@@move:xxx` / `@@scene:xxx` 是给这一段打标签的指令，
     对它下面所有段落生效，直到出现新的同类指令。规则引擎只读这些标签，不猜自然语言。 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const srcDir = path.join(root, 'content', '补字人');
const outFile = path.join(root, 'apps', 'ui', 'content.js');

const DIRS = { '@@place:': 'place', '@@actor:': 'actors', '@@move:': 'moveTo', '@@scene:': 'scene' };

function parseChapter(raw) {
  const marks = {};
  const paras = [];
  raw.replace(/\r\n/g, '\n').split(/\n{2,}/).forEach((block) => {
    const keep = [];
    block.split('\n').forEach((line) => {
      const s = line.trim();
      if (!s || s.startsWith('#')) return;
      const key = Object.keys(DIRS).find((k) => s.startsWith(k));
      if (key) {
        const val = s.slice(key.length).trim();
        const field = DIRS[key];
        marks[field] = field === 'actors' ? val.split(/[,，]/).map((x) => x.trim()).filter(Boolean) : val;
        return;
      }
      keep.push(s);
    });
    if (!keep.length) return;
    const item = { text: keep.join('') };
    Object.keys(marks).forEach((k) => { item[k] = Array.isArray(marks[k]) ? marks[k].slice() : marks[k]; });
    paras.push(item);
  });
  return paras;
}

function chapters() {
  if (!fs.existsSync(srcDir)) return [];
  return fs.readdirSync(srcDir)
    .filter((f) => /^ch\d+\.md$/.test(f))
    .sort()
    .map((f) => {
      const idx = Number(f.match(/ch(\d+)\.md/)[1]);
      const paras = parseChapter(fs.readFileSync(path.join(srcDir, f), 'utf8'));
      return { idx, paras, chars: paras.reduce((n, p) => n + p.text.length, 0) };
    });
}

const list = chapters();
const data = {};
list.forEach((c) => { data['c' + c.idx] = c.paras; });

const body = '/* 自动生成，别手改：改 content/补字人/chNN.md 后跑 node scripts/build-content.js */\n' +
  'window.SF_CONTENT = ' + JSON.stringify(data, null, 0) + ';\n';

fs.writeFileSync(outFile, body, 'utf8');

const total = list.reduce((n, c) => n + c.chars, 0);
console.log('章节 ' + list.length + ' / 共 ' + total + ' 字');
list.forEach((c) => console.log('  第 ' + c.idx + ' 章：' + c.paras.length + ' 段 · ' + c.chars + ' 字'));
console.log('写出 ' + path.relative(root, outFile));
