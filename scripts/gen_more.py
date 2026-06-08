#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
看板ラスト＋cute基準。
- garuda: 天空神鳥テンガ・ガルダ(r系統★5/cool) 黄金の大翼＋雷の尾
- mameko: コインの妖精マメコ(激レア★4/cute人型) かわいい基準を新バーで確定
"""
import os
from PIL import Image, ImageDraw, ImageFilter, ImageChops

SCALE = 7
OUT = (32, 28, 40, 255)
W = (248, 250, 252, 255)
GD = (170, 120, 30, 255); GB = (232, 182, 54, 255); GL = (250, 214, 96, 255); GH = (255, 240, 176, 255)
BLU = (70, 160, 245, 255); BLL = (150, 215, 255, 255)   # 雷
RED = (208, 70, 56, 255)
PINK = (240, 150, 160, 255)


def outline(fill, col=OUT, t=1):
    a = fill.split()[3]
    ring = ImageChops.subtract(a.filter(ImageFilter.MaxFilter(2 * t + 1)), a)
    base = Image.new("RGBA", fill.size, (0, 0, 0, 0))
    base.paste(col, (0, 0), ring)
    base.alpha_composite(fill)
    return base


# ───────── 天空神鳥テンガ・ガルダ (48x48) ─────────
def draw_garuda():
    G = 48
    f = Image.new("RGBA", (G, G), (0, 0, 0, 0))
    d = ImageDraw.Draw(f)
    cx = 24
    # 大翼(左右に大きく展開・羽根のスカラップ)
    for sgn in (-1, 1):
        base = cx + sgn * 3
        d.polygon([(base, 18), (cx + sgn * 23, 6), (cx + sgn * 22, 16),
                   (cx + sgn * 20, 14), (cx + sgn * 19, 22), (cx + sgn * 15, 19),
                   (cx + sgn * 14, 27), (cx + sgn * 8, 22), (base, 26)], fill=GB)
        # 羽根の段(明)
        d.polygon([(base, 18), (cx + sgn * 18, 9), (cx + sgn * 9, 19)], fill=GL)
        d.line((base, 19, cx + sgn * 20, 9), fill=GD)
        d.point((cx + sgn * 20, 8), fill=BLL)   # 翼端に雷
    # 尾(雷のジグザグ・下へ)
    d.polygon([(20, 34), (22, 44), (19, 42), (24, 48), (26, 40), (28, 46), (28, 36)], fill=GB)
    d.polygon([(23, 38), (24, 47), (26, 41)], fill=BLU)   # 雷の芯
    # 胴
    d.ellipse((17, 17, 31, 36), fill=GB)
    d.ellipse((17, 17, 27, 30), fill=GD)        # 背の影
    d.ellipse((19, 24, 29, 36), fill=GL)        # 胸の明
    for ty in (26, 29, 32):                     # 胸の羽根列
        d.line((20, ty, 28, ty + 1), fill=GD)
    # 脚＋鉤爪
    for lx in (19, 26):
        d.rectangle((lx, 35, lx + 2, 40), fill=GD)
        for cxx in range(lx - 1, lx + 3):
            d.point((cxx, 41), fill=GL)
    # 頭(やや右へ向ける)＋くちばし
    d.ellipse((20, 8, 31, 20), fill=GB)
    d.ellipse((20, 14, 31, 20), fill=GD)
    d.ellipse((21, 8, 29, 15), fill=GL)
    d.polygon([(30, 14), (36, 15), (30, 18)], fill=(235, 170, 60, 255))  # くちばし(右)
    d.line((30, 16, 35, 16), fill=GD)
    # 冠羽(雷の前立て・非対称)
    for sx, h in [(22, 3), (24, 0), (26, 2)]:
        d.polygon([(sx, 8), (sx + 2, h), (sx + 3, 9)], fill=BLU)
    img = outline(f)
    dd = ImageDraw.Draw(img)
    # 鋭い目(縦長・金/白)
    dd.polygon([(24, 12), (29, 13), (27, 16), (24, 15)], fill=OUT)
    dd.point((26, 13), fill=W); dd.point((26, 14), fill=BLL)
    dd.line((23, 11, 28, 12), fill=OUT)
    return img.resize((G * SCALE, G * SCALE), Image.NEAREST)


# ───────── コインの妖精マメコ (32x32) cute ─────────
def draw_mameko():
    G = 32
    f = Image.new("RGBA", (G, G), (0, 0, 0, 0))
    d = ImageDraw.Draw(f)
    # 頭のコイン飾り
    d.ellipse((13, 2, 19, 8), fill=GL); d.ellipse((14, 3, 18, 7), fill=GD)
    d.rectangle((15, 4, 16, 6), fill=GL)
    # ちび腕
    d.ellipse((5, 16, 10, 21), fill=GB); d.ellipse((22, 16, 27, 21), fill=GB)
    # 体(まるい金貨)
    d.ellipse((7, 8, 25, 28), fill=GB)
    d.ellipse((7, 8, 21, 22), fill=GL)          # 左上の光(cute=やわらか)
    d.ellipse((9, 18, 23, 29), fill=GD)         # 下の影(色相シフト)
    d.ellipse((8, 9, 24, 27), fill=GB)          # 中央ベース戻し
    d.ellipse((9, 10, 20, 20), fill=GL)
    # おなかのコイン紋(¥)
    d.ellipse((12, 16, 20, 24), fill=GH); d.ellipse((13, 17, 19, 23), fill=GD)
    d.line((16, 18, 16, 22), fill=GH); d.line((14, 19, 18, 19), fill=GH); d.line((14, 20, 18, 20), fill=GH)
    # ちび足
    d.ellipse((11, 26, 15, 30), fill=GD); d.ellipse((17, 26, 21, 30), fill=GD)
    img = outline(f)
    dd = ImageDraw.Draw(img)
    # 大きめのまるい目(cute・感情あり)＋ハイライト
    for ex in (12, 20):
        dd.ellipse((ex - 2, 11, ex + 2, 16), fill=W)
        dd.ellipse((ex - 1, 12, ex + 1, 15), fill=OUT)
        dd.point((ex, 12), fill=W); dd.point((ex - 1, 13), fill=BLL)
    # ほっぺ＋にこ口
    dd.point((9, 16), fill=PINK); dd.point((10, 16), fill=PINK)
    dd.point((22, 16), fill=PINK); dd.point((23, 16), fill=PINK)
    dd.arc((14, 15, 18, 19), 20, 160, fill=OUT)
    return img.resize((G * SCALE, G * SCALE), Image.NEAREST)


if __name__ == "__main__":
    os.makedirs("/tmp/spike", exist_ok=True)
    g = draw_garuda(); m = draw_mameko()
    pad = 18; h = max(g.height, m.height)
    sheet = Image.new("RGBA", (g.width + m.width + pad * 3, h + pad + 24), (40, 42, 48, 255))
    sheet.alpha_composite(g, (pad, pad))
    sheet.alpha_composite(m, (g.width + pad * 2, pad + (h - m.height)))
    dd = ImageDraw.Draw(sheet)
    dd.text((pad, h + pad + 4), "Tenga-Garuda (r, cool, legendary)", fill=(220, 210, 180))
    dd.text((g.width + pad * 2, h + pad + 4), "Mameko (cute, coin fairy)", fill=(220, 210, 180))
    sheet.save("/tmp/spike/more.png")
    print("more -> /tmp/spike/more.png")
