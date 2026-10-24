'use strict';
/**
 * npm run icon:from -- 我的图标.png
 *
 * 只是给 assets/icon-from-png.py 套一层：找得到哪个 python 就用哪个。
 * 单独跑 python 脚本也行，这里的存在意义是省得配 PATH。
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'assets', 'icon-from-png.py');
const args = process.argv.slice(2);

if (!args.length || args[0] === '-h' || args[0] === '--help') {
  console.log('用法: npm run icon:from -- 你的图.png [--pad 6] [--small 小尺寸版.png]');
  console.log('');
  console.log('要求：正方形 PNG（建议 1024×1024），透明或自带背景；');
  console.log('      尺寸 ≤48px 的细节会糊，小图标请另出一版用 --small 传入。');
  process.exit(args.length ? 0 : 1);
}

const candidates = [
  process.env.STORYFORGE_PYTHON,
  'python',
  'python3',
  'py',
  // DSH/CI 环境里可能只有自带的解释器
  path.join(process.env.USERPROFILE || '', '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe')
].filter(Boolean);

function probe(cmd) {
  const r = spawnSync(cmd, ['-c', 'import PIL, sys; print(sys.version_info[0])'], {
    encoding: 'utf8',
    shell: false
  });
  if (r.error) return false;
  return (r.stdout || '').trim().startsWith('3');
}

let python = null;
for (const c of candidates) {
  if (fs.existsSync(c) || c === 'python' || c === 'python3' || c === 'py') {
    if (probe(c)) { python = c; break; }
  }
}

if (!python) {
  console.error('没找到可用的 Python 3（且装了 Pillow）。');
  console.error('装一个：winget install Python.Python.3.12  然后 pip install pillow');
  console.error('或者直接跑：python assets/icon-from-png.py 你的图.png');
  process.exit(1);
}

const r = spawnSync(python, [SCRIPT].concat(args), { stdio: 'inherit', cwd: ROOT });
if (r.error) {
  console.error('调用 Python 失败：' + r.error.message);
  process.exit(1);
}
process.exit(r.status === null ? 1 : r.status);
