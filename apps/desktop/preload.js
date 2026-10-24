'use strict';
/**
 * preload：渲染进程能看到的唯一桥面。
 * 只暴露三样东西，不暴露 fs、child_process、ipcRenderer 原始对象：
 *   1. Key 的存 / 取 / 清（主进程 safeStorage）
 *   2. 数据库读写（主进程 better-sqlite3），仅在主进程成功打开数据库时挂上——
 *      没挂上时 apps/ui/store.js 会自动退回 localStorage 快照，UI 不需要分支。
 *   3. 模型调用（主进程 fetch，绕开渲染进程的 CORS 与 Key 暴露问题）。
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const hasDb = process.argv.indexOf('--sf-db=1') >= 0;

const api = {
  saveKey: (key) => ipcRenderer.invoke('sf:key:save', key),
  loadKey: () => ipcRenderer.invoke('sf:key:load'),
  clearKey: () => ipcRenderer.invoke('sf:key:clear'),
  platform: process.platform,
  dbEnabled: hasDb
};

if (hasDb) {
  api.db = {
    invoke: (op, payload) => ipcRenderer.invoke('sf:db', op, payload)
  };
}

/* 模型通道与数据库独立：没有数据库也要能测 Key、能生成草稿 */
api.llm = {
  invoke: (op, payload) => ipcRenderer.invoke('sf:llm', op, payload),
  onEvent: (fn) => {
    const h = (_e, msg) => fn(msg);
    ipcRenderer.on('sf:llm:event', h);
    return () => ipcRenderer.removeListener('sf:llm:event', h);
  }
};

/* 书库通道（阅读器模式）：选文件、读任意磁盘、开 PDF 窗口、在资源管理器定位，
   都只有主进程能做。这里只暴露 op 名 + payload，具体实现见 apps/desktop/library.js。
   就算数据库起不来（sfBridge.db 不存在）这条通道也照样挂着——
   至少"选文件 → 导入"能给出准确的错误信息，而不是一个 undefined。 */
api.library = {
  invoke: (op, payload) => ipcRenderer.invoke('sf:library', op, payload),
  onEvent: (fn) => {
    const h = (_e, msg) => fn(msg);
    ipcRenderer.on('sf:lib:event', h);
    return () => ipcRenderer.removeListener('sf:lib:event', h);
  }
};

/* Electron 32 之后 File.path 没了，拖拽进来的文件要用 webUtils.getPathForFile 换真实路径。
   给渲染进程一个"把 File 换成路径"的函数，别的什么都不给。 */
api.pathFor = (file) => {
  try { return webUtils.getPathForFile(file) || ''; } catch (e) { return ''; }
};

contextBridge.exposeInMainWorld('sfBridge', api);
