# -*- coding: utf-8 -*-
"""把一张 PNG 变成 Windows 能用的多尺寸图标。

用法：
    python assets/icon-from-png.py 你的图.png
    python assets/icon-from-png.py 你的图.png --pad 8 --small 小尺寸版.png

产出：
    assets/icon.ico   多尺寸（16/20/24/32/40/48/64/128/256），exe / 安装包 / 快捷方式都用它
    assets/icon.png   256px，Electron 窗口图标用它

设计上的限制（脚本会按下面的规则处理，但改不了你的画）：
    1. 源图必须正方形；不是正方形时会居中裁切，不拉伸。
    2. Windows 不会替你加留白，所以默认 `--pad 6`：四周留 6% 边距，
       否则图标在任务栏上会顶到边，视觉上比旁边程序的图标大一圈。
    3. 16px 是真实使用尺寸（标题栏、任务栏列表、文件列表）。源图 ≤ 48px 的文字和细线
       在那一步一定糊，所以建议单独出一张小尺寸版，用 `--small` 传进来。
    4. 背景要自己负责：Windows 不做遮罩。想要圆角就画圆角，想要透明就存透明。
"""

import argparse
import os
import sys

from PIL import Image, ImageDraw

# 控制台可能是 GBK（中文 Windows 默认），直接 print "✓" 会 UnicodeEncodeError
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
SIZES = [256, 128, 64, 48, 40, 32, 24, 20, 16]
# 小于等于这个尺寸时，优先用 --small 提供的小尺寸专用图
SMALL_CUTOFF = 48


def rounded_mask(size, radius_percent, supersample=4):
    """生成圆角矩形 alpha 蒙版；supersample 后缩小，边缘更干净。"""
    s = size * supersample
    img = Image.new("L", (s, s), 0)
    d = ImageDraw.Draw(img)
    r = int(s * radius_percent / 100.0)
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=r, fill=255)
    return img.resize((size, size), Image.LANCZOS)


def load_square(path):
    img = Image.open(path).convert("RGBA")
    w, h = img.size
    if w != h:
        side = min(w, h)
        left = (w - side) // 2
        top = (h - side) // 2
        print("  源图 %dx%d 不是正方形，居中裁成 %dx%d" % (w, h, side, side))
        img = img.crop((left, top, left + side, top + side))
    if img.size[0] < 256:
        print("  ⚠ 源图只有 %dpx，放大到 256 会糊；建议至少 1024×1024" % img.size[0])
    return img


def with_padding(img, pad_percent):
    if pad_percent <= 0:
        return img
    side = img.size[0]
    inner = int(round(side * (100 - pad_percent * 2) / 100.0))
    scaled = img.resize((inner, inner), Image.LANCZOS)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    off = (side - inner) // 2
    canvas.paste(scaled, (off, off), scaled)
    return canvas


def center_zoom(img, percent):
    """裁中间一块再放大：细节多的插画在小尺寸上靠这招保住识别度。"""
    if percent >= 100:
        return img
    side = img.size[0]
    inner = int(round(side * percent / 100.0))
    off = (side - inner) // 2
    return img.crop((off, off, off + inner, off + inner))


def render(img, size, small=None, small_zoom=100, round_pct=0):
    src = small if (small is not None and size <= SMALL_CUTOFF) else img
    if size <= SMALL_CUTOFF and small_zoom < 100:
        src = center_zoom(src, small_zoom)
    out = src.resize((size, size), Image.LANCZOS)
    if round_pct > 0:
        out = out.copy()
        out.putalpha(rounded_mask(size, round_pct))
    return out


def main():
    ap = argparse.ArgumentParser(description="PNG → 多尺寸 .ico + 256px PNG")
    ap.add_argument("source", help="源图（PNG，建议 1024×1024 正方形，透明背景）")
    ap.add_argument("--pad", type=float, default=6.0, help="四周留白百分比，默认 6")
    ap.add_argument("--small", help="可选的 16–48px 专用图（细节更少的小尺寸版）")
    ap.add_argument("--small-zoom", type=float, default=100.0,
                    help="≤48px 那几档先裁中间再缩放，默认 100（不裁）；细节多的插画建议 60–75")
    ap.add_argument("--round", dest="round_pct", type=float, default=0.0,
                    help="给图标加圆角蒙版，值为半径占边长的百分比（Win11 常见 22）；默认 0 不加")
    ap.add_argument("--out-dir", default=HERE, help="输出目录，默认 assets/")
    args = ap.parse_args()

    if not os.path.isfile(args.source):
        sys.exit("找不到源图：" + args.source)

    print("读取 " + args.source)
    base = with_padding(load_square(args.source), args.pad)
    small = None
    if args.small:
        if not os.path.isfile(args.small):
            sys.exit("找不到小尺寸图：" + args.small)
        # 小尺寸图同样补齐留白，保证两版在任务栏上大小一致
        small = with_padding(load_square(args.small), args.pad)

    frames = [render(base, s, small, args.small_zoom, args.round_pct) for s in SIZES]
    os.makedirs(args.out_dir, exist_ok=True)
    ico_path = os.path.join(args.out_dir, "icon.ico")
    png_path = os.path.join(args.out_dir, "icon.png")

    # Pillow 的 ICO 写入：用最大一版当主图 + append_images 带上其余各档，
    # 这样每一档都是我们自己重采样过的（而不是让 Windows 从 256 硬缩）。
    frames[0].save(
        ico_path,
        format="ICO",
        sizes=[(s, s) for s in SIZES],
        append_images=frames[1:],
    )
    frames[0].save(png_path)

    print("✓ %s（%.1f KB，%d 档）" % (ico_path, os.path.getsize(ico_path) / 1024.0, len(SIZES)))
    print("✓ %s" % png_path)
    print("")
    print("下一步：npm run dist   # 重新打包，图标会写进 exe 与安装包")
    print("      npm start       # 只跑开发版的话，窗口图标已经换了")


if __name__ == "__main__":
    main()
