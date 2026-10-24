'use strict';
/**
 * 数据/备份的存放位置，以及"搬家"。
 *
 * 为什么指针放在 userData 下的 config.json 而不是库里：
 *   用户可能把数据目录搬到 D 盘，这时候"库在哪"这件事不能再写在库里——否则搬完就找不到库了。
 *   所以 userData（Electron 固定位置）只放一份小配置，真正的东西（库、书、备份）跟着用户走。
 *
 * 目录形状（默认值，全部可改）：
 *   <dataRoot>/storyforge.db      主库（含 -wal / -shm）
 *   <dataRoot>/library/books/…    书库副本与图片
 *   <backupRoot>/storyforge-*.db  自动备份，留 20 份
 */
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const CONFIG = () => path.join(app.getPath('userData'), 'config.json');

function read() {
  try {
    const j = JSON.parse(fs.readFileSync(CONFIG(), 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch (e) {
    return {};
  }
}

function write(patch) {
  const cur = read();
  const next = Object.assign({}, cur, patch || {});
  fs.mkdirSync(path.dirname(CONFIG()), { recursive: true });
  fs.writeFileSync(CONFIG(), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

const userData = () => app.getPath('userData');

function dataRoot() {
  const c = read();
  return (c.dataRoot && String(c.dataRoot)) || path.join(userData(), 'workspace');
}

function backupRoot() {
  const c = read();
  return (c.backupRoot && String(c.backupRoot)) || path.join(userData(), 'backups');
}

function libraryRoot() {
  return path.join(dataRoot(), 'library');
}

function dbFile() {
  return path.join(dataRoot(), 'storyforge.db');
}

/** 当前配置 + 每个目录里实际有多大、多少文件（给设置页显示） */
function info() {
  const c = read();
  const sizeOf = (dir) => {
    let bytes = 0;
    let files = 0;
    const walk = (d) => {
      let list = [];
      try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
      list.forEach((it) => {
        const p = path.join(d, it.name);
        if (it.isDirectory()) walk(p);
        else {
          try { bytes += fs.statSync(p).size; files++; } catch (e) { /* 跳过 */ }
        }
      });
    };
    walk(dir);
    return { bytes, files, dir };
  };
  return {
    userData: userData(),
    dataRoot: dataRoot(),
    backupRoot: backupRoot(),
    libraryRoot: libraryRoot(),
    dbFile: dbFile(),
    configFile: CONFIG(),
    data: sizeOf(dataRoot()),
    backup: sizeOf(backupRoot()),
    backups: (() => {
      try {
        return fs.readdirSync(backupRoot()).filter((f) => /^storyforge-.*\.db$/.test(f))
          .map((f) => {
            const p = path.join(backupRoot(), f);
            const st = fs.statSync(p);
            return { name: f, bytes: st.size, at: st.mtimeMs };
          })
          .sort((a, b) => b.at - a.at)
          .slice(0, 20);
      } catch (e) { return []; }
    })(),
    custom: !!(c.dataRoot || c.backupRoot)
  };
}

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  fs.readdirSync(from, { withFileTypes: true }).forEach((it) => {
    const a = path.join(from, it.name);
    const b = path.join(to, it.name);
    if (it.isDirectory()) copyTree(a, b);
    else {
      try { fs.copyFileSync(a, b); } catch (e) { /* 单个文件失败不中断整次搬家 */ }
    }
  });
}

/**
 * 把数据搬到新目录。
 * - 只复制，不删旧目录（用户自己决定什么时候清），搬完把指针改过去；
 * - 目标目录里已经有 storyforge.db 就拒绝（避免把别人的库冲掉）。
 */
function moveData(newRoot) {
  const from = dataRoot();
  const to = String(newRoot || '').trim();
  if (!to) throw new Error('没选目录');
  if (path.resolve(from) === path.resolve(to)) throw new Error('和现在的位置一样，不用搬');
  if (!fs.existsSync(from)) throw new Error('当前数据目录不存在：' + from);
  if (fs.existsSync(path.join(to, 'storyforge.db'))) {
    throw new Error('目标目录里已经有一个 storyforge.db，换个空目录，或者先把那个文件挪走');
  }
  copyTree(from, to);
  const ok = fs.existsSync(path.join(to, 'storyforge.db'));
  if (!ok) throw new Error('复制完没看到 storyforge.db，搬家中止（旧数据没动）');
  write({ dataRoot: to });
  return { from, to, dbFile: path.join(to, 'storyforge.db'), oldKept: true };
}

function moveBackups(newRoot) {
  const from = backupRoot();
  const to = String(newRoot || '').trim();
  if (!to) throw new Error('没选目录');
  if (path.resolve(from) === path.resolve(to)) throw new Error('和现在的位置一样，不用搬');
  if (fs.existsSync(from)) copyTree(from, to);
  else fs.mkdirSync(to, { recursive: true });
  write({ backupRoot: to });
  return { from, to, oldKept: true };
}

function reset() {
  write({ dataRoot: '', backupRoot: '' });
  return info();
}

module.exports = {
  dataRoot, backupRoot, libraryRoot, dbFile, info, read, write, moveData, moveBackups, reset, CONFIG
};
