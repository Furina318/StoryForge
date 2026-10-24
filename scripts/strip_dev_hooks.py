# -*- coding: utf-8 -*-
"""开源前把 apps/desktop/main.js 里的临时探针块删掉。

为什么单独写脚本而不是直接改：本机 shell 被沙箱 ACL 挡住（pwsh 不能用），
没法在执行后跑 node --check 验证；这个脚本会自己跑校验，失败就自动回滚。

删什么：--wk1973 / --wkdl / --wksession / --wkindex / --wkbook / --wkpro
这几段都是开发期的一次性诊断（会把 JSON / 截图写到 dist/），与产品功能无关。
保留：--selftest / --selftest-ui / --selftest-llm / --selftest-lib（README 里有说明，测试用）。

用法：
    python scripts/strip_dev_hooks.py --dry-run
    python scripts/strip_dev_hooks.py
"""
import argparse
import io
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAIN = os.path.join(ROOT, "apps", "desktop", "main.js")

START = "        if (process.argv.indexOf('--wk1973') >= 0) {"
END = "        let report;"


def node_check(path):
    node = shutil.which("node")
    if not node:
        return None, "没找到 node，跳过语法校验"
    p = subprocess.run([node, "--check", path], capture_output=True, text=True)
    return p.returncode == 0, (p.stderr or "").strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    src = io.open(MAIN, encoding="utf-8").read()
    if START not in src:
        print("没找到探针块起点，可能已经清理过了。")
        return 0
    i = src.index(START)
    j = src.find(END, i)
    if j < 0:
        print("没找到块终点（let report;），中止。")
        return 1

    removed = src[i:j]
    lines = removed.count("\n")
    print("将删除 %d 行（%.1f KB）：" % (lines, len(removed.encode("utf-8")) / 1024.0))
    for ln in removed.split("\n"):
        s = ln.strip()
        if s.startswith("if (process.argv.indexOf("):
            print("  - " + s[:70])
    if args.dry_run:
        print("\n(dry-run，未写文件)")
        return 0

    backup = MAIN + ".bak"
    io.open(backup, "w", encoding="utf-8", newline="\n").write(src)

    out = src[:i] + src[j:]
    io.open(MAIN, "w", encoding="utf-8", newline="\n").write(out)

    ok, msg = node_check(MAIN)
    if ok is None:
        print("已写入，但无法校验：%s" % msg)
        return 0
    if not ok:
        io.open(MAIN, "w", encoding="utf-8", newline="\n").write(src)
        os.remove(backup)
        print("语法校验失败，已回滚。错误：\n%s" % msg)
        return 1

    os.remove(backup)
    print("已删除探针块，node --check 通过。")
    print("下一步：npm test 跑一遍六套测试，再 npm run dist 确认能打包。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
