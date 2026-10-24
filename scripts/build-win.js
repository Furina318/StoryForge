'use strict';
/**
 * 一条命令打包 Windows 安装包：node scripts/build-win.js
 *
 * 为什么不是一个纯 electron-builder 调用：
 *   electron-builder 默认用 winCodeSign 里的 rcedit 给 exe 换图标，而 winCodeSign
 *   那个 7z 里有 darwin 的符号链接，普通用户没 SeCreateSymbolicLink 权限，解压会报
 *   "Cannot create symbolic link" 并整体失败。
 * 所以这里：win.signAndEditExecutable = false 关掉那一步，先用 --dir 生成目录，
 * 自己拿缓存里已经解出来的 rcedit 换图标，再用 --prepackaged 出安装包。
 *
 * 全程走 npmmirror，GitHub 直连在国内基本装不动。
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const UNPACKED = path.join(DIST, 'win-unpacked');
const EXE = path.join(UNPACKED, 'StoryForge.exe');
const ICON = path.join(ROOT, 'assets', 'icon.ico');
const PKG = require(path.join(ROOT, 'package.json'));

const env = Object.assign({}, process.env, {
  ELECTRON_BUILDER_BINARIES_MIRROR: 'https://npmmirror.com/mirrors/electron-builder-binaries/',
  ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/',
  USE_HARD_LINKS: 'false',
  ELECTRON_RUN_AS_NODE: ''
});

function run(args, label) {
  console.log('\n▶ ' + label);
  const r = spawnSync(process.execPath, [path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js')].concat(args), {
    cwd: ROOT,
    env,
    stdio: 'inherit'
  });
  if (r.status !== 0) {
    console.error('✗ ' + label + ' 失败，退出码 ' + r.status);
    process.exit(r.status || 1);
  }
}

function findRcedit() {
  const cache = path.join(os.homedir(), 'AppData', 'Local', 'electron-builder', 'Cache', 'winCodeSign');
  if (!fs.existsSync(cache)) return null;
  for (const dir of fs.readdirSync(cache)) {
    const p = path.join(cache, dir, 'rcedit-x64.exe');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function stampIcon() {
  const rcedit = findRcedit();
  if (!rcedit) {
    console.warn('⚠ 没找到 rcedit（首次打包会下载 winCodeSign），这次跳过换图标');
    return;
  }
  console.log('\n▶ 写入图标与版本信息');
  const args = [
    EXE,
    '--set-icon', ICON,
    '--set-version-string', 'ProductName', 'StoryForge',
    '--set-version-string', 'FileDescription', 'StoryForge 本地优先小说创作工作台',
    '--set-version-string', 'CompanyName', 'StoryForge',
    '--set-file-version', PKG.version + '.0',
    '--set-product-version', PKG.version
  ];
  const r = spawnSync(rcedit, args, { stdio: 'inherit' });
  if (r.status !== 0) console.warn('⚠ rcedit 返回 ' + r.status + '，图标可能没写进去');
}

if (!fs.existsSync(ICON)) {
  console.error('缺少 assets/icon.ico，先运行 python assets/make-icon.py');
  process.exit(1);
}

run(['--win', '--dir'], '生成 win-unpacked');
stampIcon();
run(['--win', 'nsis', '--prepackaged', UNPACKED], '生成 NSIS 安装包');

const setup = path.join(DIST, 'StoryForge-' + PKG.version + '-Setup.exe');
if (fs.existsSync(setup)) {
  const mb = (fs.statSync(setup).size / 1048576).toFixed(1);
  console.log('\n✓ 完成：' + setup + '（' + mb + ' MB）');
  console.log('  双击安装即可，安装器会建桌面与开始菜单快捷方式。');
} else {
  console.log('\n✓ 完成，但没找到安装包，检查 dist/ 目录');
}
