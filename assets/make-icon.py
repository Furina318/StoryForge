# -*- coding: utf-8 -*-
"""生成 StoryForge 图标：assets/icon.ico（多尺寸）+ assets/icon.png（512）

图案：深墨绿圆角方块 + 纸色竖条骨架 + 白色「补」字 + 一枚朱砂色印章点。
只用 Pillow 的标准绘制，不依赖外部素材。
"""
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
BG_TOP = (58, 118, 105)
BG_BOTTOM = (32, 74, 66)
PAPER = (247, 243, 233)
INK = (28, 26, 22)
SEAL = (176, 62, 44)

FONT_BOLD = r"C:\Windows\Fonts\msyhbd.ttc"


def rounded(size, radius, color):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=color)
    return img


def gradient(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    px = img.load()
    for y in range(size):
        t = y / max(1, size - 1)
        r = int(BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t)
        g = int(BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t)
        b = int(BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t)
        for x in range(size):
            px[x, y] = (r, g, b, 255)
    return img


def render(size):
    scale = 4  # 超采样后缩小，边缘更干净
    s = size * scale
    base = gradient(s)
    mask = rounded(s, int(s * 0.22), (255, 255, 255, 255))
    canvas = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    canvas.paste(base, (0, 0), mask)

    d = ImageDraw.Draw(canvas)

    # 纸色书页：略微内缩的圆角矩形
    pad = int(s * 0.155)
    page_box = [pad, int(s * 0.115), s - pad, s - int(s * 0.115)]
    d.rounded_rectangle(page_box, radius=int(s * 0.055), fill=PAPER)

    # 书页左侧装订线
    spine_x = page_box[0] + int(s * 0.052)
    d.line([spine_x, page_box[1] + int(s * 0.05), spine_x, page_box[3] - int(s * 0.05)],
           fill=(214, 205, 188), width=max(1, int(s * 0.012)))

    # 「补」字
    glyph = "补"
    fs = int(s * 0.46)
    font = ImageFont.truetype(FONT_BOLD, fs)
    bbox = d.textbbox((0, 0), glyph, font=font)
    gw, gh = bbox[2] - bbox[0], bbox[3] - bbox[1]
    cx = page_box[0] + (page_box[2] - page_box[0]) / 2 + int(s * 0.012)
    cy = (page_box[1] + page_box[3]) / 2
    d.text((cx - gw / 2 - bbox[0], cy - gh / 2 - bbox[1]), glyph, font=font, fill=INK)

    # 朱砂印章点（漏字处的红笔）
    r = int(s * 0.042)
    sx, sy = page_box[2] - int(s * 0.075), page_box[3] - int(s * 0.085)
    d.ellipse([sx - r, sy - r, sx + r, sy + r], fill=SEAL)

    return canvas.resize((size, size), Image.LANCZOS)


def main():
    sizes = [256, 128, 64, 48, 40, 32, 24, 20, 16]
    imgs = [render(n) for n in sizes]
    png_path = os.path.join(HERE, "icon.png")
    ico_path = os.path.join(HERE, "icon.ico")
    imgs[0].save(png_path)
    imgs[0].save(ico_path, format="ICO", sizes=[(n, n) for n in sizes])
    print("wrote", png_path, os.path.getsize(png_path))
    print("wrote", ico_path, os.path.getsize(ico_path))


if __name__ == "__main__":
    main()
