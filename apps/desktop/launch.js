'use strict';
/**
 * 用 node 启动 Electron 的薄包装。
 *
 * 为什么不直接 `electron .`：
 *   有些环境（CI、部分 IDE、本仓库的开发沙箱）会全局注入 ELECTRON_RUN_AS_NODE=1，
 *   这时 electron.exe 会退化成普通 Node，`require('electron')` 返回的是二进制路径，
 *   ipcMain / app 全是 undefined，主进程第 60 行就崩了。症状很像代码 bug，其实是环境变量。
 *
 * 这个脚本只做两件事：把 ELECTRON_RUN_AS_NODE 摘掉、把参数原样转发给 electron。
 * 用法：node apps/desktop/launch.js [--enable-logging]
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

// 在普通 node 下 require('electron') 拿到的就是 electron.exe 的绝对路径
const electronPath = require('electron');

const root = path.join(__dirname, '..', '..');
const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE; // 关键：不清掉它，Electron 会以 Node 模式运行

const args = ['.'].concat(process.argv.slice(2));
const child = spawn(electronPath, args, { stdio: 'inherit', env, cwd: root });

child.on('error', (err) => {
  console.error('[launch] 启动 Electron 失败：', err.message);
  console.error('[launch] 如果提示找不到 electron，先跑 npm install');
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) console.error('[launch] Electron 被信号终止：', signal);
  process.exit(code == null ? 0 : code);
});
