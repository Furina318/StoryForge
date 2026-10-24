# -*- coding: utf-8 -*-
"""开源前的仓库清理：删掉一次性探针、临时截图、打包产物、私有材料。

用法（在仓库根目录）：
    python scripts/cleanup_repo.py --dry-run   # 先看会删什么
    python scripts/cleanup_repo.py             # 真删

设计原则：
- 只删"可再生成"或"一次性"的东西；正文、测试、源码、文档一张不动；
- dist/ 整个删掉（打包产物 + 几十个临时补丁脚本 + 临时截图），
  文档用的截图已经在 docs/img/ 里；
- recovered/ 是数据事故时捞回来的私人文本，不进开源仓库；
- 想保留 dist/ 里的安装包，先手动拷出来。
"""
import argparse
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 整个目录删
DIRS = [
    "dist",           # 打包产物 + 一次性补丁脚本 + 临时截图
    "recovered",      # 数据事故捞回的私人文本
    "docs/proto",     # 早期 UI 方案对照页（已在 docs/img/ 留了截图）
]

# 单个文件删（相对路径）
FILES = [
    ".dsh-write-test",
    "electron-run.log",
]

# 内部策略文档：开源仓库里不需要
DOCS_PRIVATE = [
    "docs/StoryForge-受众评估与实现建议.md",
]


def size_of(path):
    if os.path.isfile(path):
        return os.path.getsize(path)
    total = 0
    for base, _dirs, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(base, f))
            except OSError:
                pass
    return total


def human(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return "%.1f %s" % (n, unit)
        n /= 1024.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--keep-docs", action="store_true", help="保留 docs 里的内部策略文档")
    args = ap.parse_args()

    targets = []
    for d in DIRS:
        p = os.path.join(ROOT, d)
        if os.path.exists(p):
            targets.append(("dir", p))
    for f in FILES:
        p = os.path.join(ROOT, f)
        if os.path.exists(p):
            targets.append(("file", p))
    if not args.keep_docs:
        for f in DOCS_PRIVATE:
            p = os.path.join(ROOT, f)
            if os.path.exists(p):
                targets.append(("file", p))

    if not targets:
        print("没有需要清理的东西。")
        return 0

    total = 0
    for kind, p in targets:
        n = size_of(p)
        total += n
        rel = os.path.relpath(p, ROOT)
        if args.dry_run:
            print("[dry] %-4s %-46s %s" % (kind, rel, human(n)))
            continue
        # 安全闸：只允许删仓库内的东西
        if not os.path.abspath(p).startswith(os.path.abspath(ROOT) + os.sep):
            print("跳过（不在仓库内）：%s" % p)
            continue
        try:
            if kind == "dir":
                shutil.rmtree(p)
            else:
                os.remove(p)
            print("删除 %-46s %s" % (rel, human(n)))
        except Exception as e:                     # noqa: BLE001
            print("失败 %-46s %s" % (rel, e))

    print("\n合计 %s%s" % (human(total), "（dry-run，未实际删除）" if args.dry_run else ""))
    if not args.dry_run:
        print("下一步：git status 看一眼，然后改 README / 打 tag。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
