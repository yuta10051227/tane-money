#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
シンプル路線(オリジナル)。低解像度のチャンキードット/少色フラット/太い輪郭/強いシルエット。
作り込みすぎ=ださい を引き算で解消。参照は"シンプルさの作り"のみ流用、絵は完全オリジナル。
"""
import os
from PIL import Image, ImageDraw, ImageFilter, ImageChops

SCALE = 14
OUT = (54, 46, 50, 255)
W = (255, 255, 255, 255)


def outline(fill, col=OUT, t=1):
    a = fill.split()[3]
    ring = ImageChops.subtract(a.filter(ImageFilter.MaxFilter(2 * t + 1)), a)
    base = Image.new("RGBA", fill.size, (0, 0, 0, 0))
    base.paste(col, (0, 0), ring)
    base.alpha_composite(fill)
    return base


def dot_eyes(d, pts, r=1):
    for (ex, ey) in pts:
        d.ellipse((ex - r, ey - r, ex + r, ey + r), fill=OUT)
        d.point((ex - 1, ey - 1), fill=W)


# ───── タネ坊(芽の赤ちゃん/cute) 18x18 ─────
def m_tane():
    G = 18; f = Image.new("RGBA", (G, G), (0, 0, 0, 0)); d = ImageDraw.Draw(f)
    body = (250, 236, 196, 255); sh = (228, 206, 158, 255)
    leaf = (120, 198, 110, 255)
    d.line((9, 2, 9, 6), fill=(86, 162, 86, 255))             # 茎
    d.polygon([(9, 4), (5, 2), (8, 6)], fill=leaf)            # 葉
    d.polygon([(9, 4), (13, 2), (10, 6)], fill=leaf)
    d.ellipse((3, 6, 15, 16), fill=body)                      # まる体
    d.ellipse((4, 11, 14, 16), fill=sh)                       # 下だけ影(2トーン)
    img = outline(f); dd = ImageDraw.Draw(img)
    # シンプルな目(白+点)＋ほっぺ＋小さい口
    for ex in (7, 11):
        dd.ellipse((ex - 1, 9, ex + 1, 12), fill=W)
        dd.point((ex, 10), fill=OUT); dd.point((ex, 11), fill=OUT)
    dd.point((5, 12), fill=(245, 150, 165, 255)); dd.point((13, 12), fill=(245, 150, 165, 255))
    dd.point((9, 13), fill=OUT)
    return img, G


# ───── コリ(小竜/cute-cool) 20x20 ─────
def m_kori():
    G = 20; f = Image.new("RGBA", (G, G), (0, 0, 0, 0)); d = ImageDraw.Draw(f)
    body = (245, 196, 80, 255); sh = (210, 156, 50, 255); belly = (252, 232, 170, 255)
    d.polygon([(15, 12), (19, 14), (16, 16)], fill=sh)        # しっぽ
    d.ellipse((6, 8, 17, 18), fill=body)                      # 体
    d.ellipse((7, 13, 16, 18), fill=sh)
    d.ellipse((9, 13, 15, 18), fill=belly)                    # 腹
    d.ellipse((2, 5, 11, 14), fill=body)                      # 頭(左)
    d.polygon([(3, 5), (3, 2), (5, 5)], fill=sh)              # ちび角
    d.polygon([(8, 5), (8, 2), (10, 5)], fill=sh)
    d.rectangle((7, 17, 8, 19), fill=sh); d.rectangle((12, 17, 13, 19), fill=sh)  # 足
    img = outline(f); dd = ImageDraw.Draw(img)
    for ex in (4, 8):                                         # シンプルな目
        dd.ellipse((ex - 1, 8, ex + 1, 10), fill=W); dd.point((ex, 9), fill=OUT)
    return img, G


# ───── マメ(コインの子/cute) 18x18 ─────
def m_mame():
    G = 18; f = Image.new("RGBA", (G, G), (0, 0, 0, 0)); d = ImageDraw.Draw(f)
    body = (247, 206, 92, 255); sh = (214, 166, 56, 255)
    d.ellipse((3, 4, 15, 16), fill=body)
    d.ellipse((4, 10, 14, 16), fill=sh)
    d.ellipse((6, 7, 12, 13), fill=(255, 232, 150, 255))      # 真ん中の明
    img = outline(f); dd = ImageDraw.Draw(img)
    for ex in (7, 11):
        dd.ellipse((ex - 1, 8, ex + 1, 11), fill=W)
        dd.point((ex, 9), fill=OUT); dd.point((ex, 10), fill=OUT)
    dd.point((5, 11), fill=(245, 150, 165, 255)); dd.point((13, 11), fill=(245, 150, 165, 255))
    dd.point((9, 12), fill=OUT)
    dd.line((9, 6, 9, 8), fill=sh); dd.line((8, 7, 10, 7), fill=sh)   # ¥っぽい
    return img, G


MONS = [("tane", m_tane, "タネ坊"), ("kori", m_kori, "コリ"), ("mame", m_mame, "マメ")]

if __name__ == "__main__":
    os.makedirs("/tmp/spike", exist_ok=True)
    cell = 20 * SCALE
    sheet = Image.new("RGBA", (cell * len(MONS), cell + 26), (244, 244, 240, 255))
    sd = ImageDraw.Draw(sheet)
    for i, (mid, fn, lbl) in enumerate(MONS):
        im, g = fn()
        im = im.resize((g * SCALE, g * SCALE), Image.NEAREST)
        sheet.alpha_composite(im, (i * cell + (cell - im.width) // 2, (cell - im.height) // 2))
        sd.text((i * cell + 8, cell + 8), lbl, fill=(50, 50, 50))
    sheet.save("/tmp/spike/simple.png")
    print("simple -> /tmp/spike/simple.png")
