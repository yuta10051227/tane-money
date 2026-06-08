#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
さらにシンプル(オリジナル)。極小解像度14px・フラット単色・点目だけの素朴アイコン級。
引き算を徹底: 内部の陰影をほぼ無くし、シルエット+目+最小の特徴だけで成立させる。
"""
import os
from PIL import Image, ImageDraw, ImageFilter, ImageChops

SCALE = 20
OUT = (58, 50, 54, 255)
W = (255, 255, 255, 255)


def outline(fill, col=OUT, t=1):
    a = fill.split()[3]
    ring = ImageChops.subtract(a.filter(ImageFilter.MaxFilter(2 * t + 1)), a)
    base = Image.new("RGBA", fill.size, (0, 0, 0, 0))
    base.paste(col, (0, 0), ring)
    base.alpha_composite(fill)
    return base


def eyes(d, pts):
    for (ex, ey) in pts:                 # 1ドットの点目(超シンプル)
        d.rectangle((ex, ey, ex + 1, ey + 1), fill=OUT)


# ── タネ坊(芽) 14x14 ──
def m_tane():
    G = 14; f = Image.new("RGBA", (G, G), (0, 0, 0, 0)); d = ImageDraw.Draw(f)
    d.line((7, 1, 7, 4), fill=(96, 170, 96, 255))            # 茎
    d.polygon([(7, 2), (4, 1), (7, 4)], fill=(130, 205, 110, 255))   # 葉
    d.polygon([(7, 2), (10, 1), (7, 4)], fill=(130, 205, 110, 255))
    d.ellipse((3, 4, 11, 12), fill=(250, 235, 195, 255))     # 体(単色)
    img = outline(f); dd = ImageDraw.Draw(img)
    eyes(dd, [(5, 7), (8, 7)])
    dd.point((4, 9), fill=(245, 150, 165, 255)); dd.point((9, 9), fill=(245, 150, 165, 255))  # ほっぺ
    return img, G


# ── マメ(コインの子) 14x14 ──
def m_mame():
    G = 14; f = Image.new("RGBA", (G, G), (0, 0, 0, 0)); d = ImageDraw.Draw(f)
    d.ellipse((2, 3, 11, 12), fill=(247, 204, 88, 255))      # 体(単色)
    img = outline(f); dd = ImageDraw.Draw(img)
    eyes(dd, [(5, 6), (8, 6)])
    dd.point((4, 8), fill=(245, 150, 165, 255)); dd.point((9, 8), fill=(245, 150, 165, 255))
    dd.point((6, 9), fill=OUT); dd.point((7, 9), fill=OUT)   # 小さな口
    return img, G


# ── コリ(小竜) 15x15 ──
def m_kori():
    G = 15; f = Image.new("RGBA", (G, G), (0, 0, 0, 0)); d = ImageDraw.Draw(f)
    body = (245, 196, 80, 255)
    d.ellipse((4, 5, 12, 13), fill=body)                     # 体(単色)
    d.ellipse((1, 3, 7, 9), fill=body)                       # 頭
    d.polygon([(2, 3), (2, 1), (4, 3)], fill=body)           # ちび角
    d.rectangle((5, 12, 6, 14), fill=body); d.rectangle((9, 12, 10, 14), fill=body)  # 足
    d.polygon([(11, 8), (14, 9), (11, 11)], fill=body)       # しっぽ
    img = outline(f); dd = ImageDraw.Draw(img)
    eyes(dd, [(3, 5), (5, 5)])
    return img, G


MONS = [("tane", m_tane, "タネ坊"), ("mame", m_mame, "マメ"), ("kori", m_kori, "コリ")]

if __name__ == "__main__":
    os.makedirs("/tmp/spike", exist_ok=True)
    cell = 15 * SCALE
    sheet = Image.new("RGBA", (cell * len(MONS), cell + 26), (244, 244, 240, 255))
    sd = ImageDraw.Draw(sheet)
    for i, (mid, fn, lbl) in enumerate(MONS):
        im, g = fn(); im = im.resize((g * SCALE, g * SCALE), Image.NEAREST)
        sheet.alpha_composite(im, (i * cell + (cell - im.width) // 2, (cell - im.height) // 2))
        sd.text((i * cell + 8, cell + 8), lbl, fill=(50, 50, 50))
    sheet.save("/tmp/spike/simpler.png")
    print("simpler -> /tmp/spike/simpler.png")
