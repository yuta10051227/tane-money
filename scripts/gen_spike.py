#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
アーキタイプ(体型)スパイク — 色付きのままシルエットを多彩にできるか検証する試作。
32x32論理グリッド/出力128x128。本番gen_monsters.pyとは独立(承認後に統合)。

方式: 各アーキタイプは「色つきの塗りパーツ」だけを描く。輪郭線はアルファのマスクを
1px膨張して差分を取り、全形状に均一な黒フチを後付けする(MaskOutline)。
目/ハイライトはフチの上に重ねる。
"""
import os, sys
from PIL import Image, ImageDraw, ImageFilter, ImageChops

G = 32; SCALE = 8
OUT = (24, 26, 24, 255)      # 輪郭色
WHT = (255, 255, 255, 255)

def newlayer():
    img = Image.new("RGBA", (G, G), (0, 0, 0, 0))
    return img, ImageDraw.Draw(img)

def outline(fill_img, t=1):
    """塗りレイヤのアルファを膨張させて外側に黒フチを付けたRGBAを返す"""
    a = fill_img.split()[3]
    dil = a.filter(ImageFilter.MaxFilter(2 * t + 1))
    ring = ImageChops.subtract(dil, a)
    base = Image.new("RGBA", fill_img.size, (0, 0, 0, 0))
    base.paste(OUT, (0, 0), ring)          # フチ
    base.alpha_composite(fill_img)         # 塗りを上に
    return base

def eyes(d, ex_list, ey, fierce=False):
    for ex in ex_list:
        d.ellipse((ex - 2, ey - 2, ex + 2, ey + 2), fill=WHT)
        d.ellipse((ex - 1, ey - 1, ex + 1, ey + 1), fill=OUT)
        d.point((ex, ey - 1), fill=WHT)
        if fierce:
            d.line((ex - 2, ey - 2, ex + 2, ey - 1), fill=OUT)

def belly(d, box, col):
    d.ellipse(box, fill=col)

# ───────────────────────── アーキタイプ ─────────────────────────
# 各関数は (fill_draw) に色パーツだけ描く。返り値: (eye_xs, eye_y, fierce)

def a_slime(d, c):
    body, light, acc = c
    d.ellipse((9, 14, 23, 29), fill=body)        # 丸い下半身
    d.polygon([(16, 6), (10, 18), (22, 18)], fill=body)  # とんがり頭
    d.ellipse((9, 14, 23, 29), fill=body)
    belly(d, (12, 20, 20, 28), light)
    return [13, 19], 18, False

def a_bird(d, c):
    body, light, acc = c
    # つばさ(左右に広げる)
    for sgn in (-1, 1):
        bx = 16 + sgn * 7
        d.polygon([(bx, 16), (bx + sgn * 7, 12), (bx + sgn * 6, 23), (bx, 22)], fill=light)
    d.ellipse((9, 12, 23, 28), fill=body)        # まる胴
    belly(d, (12, 18, 20, 27), light)
    d.polygon([(16, 5), (13, 11), (19, 11)], fill=acc)   # あたまの羽
    d.polygon([(16, 16), (16, 20), (21, 18)], fill=acc)  # くちばし(右向き)
    for fx in (13, 19):                                   # あし
        d.rectangle((fx, 28, fx + 1, 30), fill=acc)
    return [13, 19], 15, False

def a_beast(d, c):  # 四足獣(横向き)
    body, light, acc = c
    d.ellipse((6, 16, 26, 27), fill=body)        # 横長胴
    for fx in (8, 13, 18, 23):                    # 4本足
        d.rectangle((fx, 25, fx + 2, 30), fill=body)
    d.polygon([(24, 22), (30, 18), (29, 25)], fill=body)  # しっぽ
    d.ellipse((3, 11, 14, 22), fill=body)        # あたま(左)
    d.polygon([(4, 11), (3, 5), (8, 10)], fill=body)      # 耳
    d.polygon([(11, 11), (12, 5), (14, 11)], fill=body)
    belly(d, (8, 20, 22, 26), light)
    d.point((4, 17), fill=acc)                    # はな
    return [6, 11], 15, True

def a_dragon(d, c):
    body, light, acc = c
    for sgn in (-1, 1):                            # つばさ
        bx = 16 + sgn * 7
        d.polygon([(bx, 13), (bx + sgn * 9, 7), (bx + sgn * 8, 20)], fill=light)
    d.polygon([(20, 24), (30, 26), (24, 19)], fill=body)  # しっぽ
    d.ellipse((8, 14, 24, 30), fill=body)         # 胴
    d.ellipse((12, 4, 24, 16), fill=body)         # あたま(やや右)
    d.polygon([(22, 9), (27, 8), (23, 13)], fill=light)   # 口先
    for sgn, bx in ((-1, 14), (1, 22)):           # 角
        d.polygon([(bx, 6), (bx + sgn, 1), (bx + sgn * 2, 6)], fill=acc)
    belly(d, (11, 20, 21, 29), light)
    for fx in (12, 19):
        d.rectangle((fx, 28, fx + 2, 31), fill=body)
    return [15, 21], 9, True

def a_serpent(d, c):  # 大蛇(縦のうねり)
    body, light, acc = c
    d.ellipse((6, 22, 20, 31), fill=body)         # 下のとぐろ
    d.ellipse((14, 16, 27, 26), fill=body)
    d.ellipse((7, 10, 19, 20), fill=body)         # 上へS字
    d.ellipse((11, 3, 24, 14), fill=body)         # あたま(上)
    for sgn, bx in ((-1, 13), (1, 21)):           # 角
        d.polygon([(bx, 5), (bx + sgn, 1), (bx + sgn * 2, 5)], fill=acc)
    belly(d, (9, 24, 17, 30), light)
    return [15, 20], 8, True

def a_golem(d, c):  # ゴーレム/騎士(角ばった人型)
    body, light, acc = c
    d.rectangle((10, 14, 22, 27), fill=body)      # 胴(四角)
    d.rectangle((6, 15, 9, 25), fill=body)        # 左腕
    d.rectangle((23, 15, 26, 25), fill=body)      # 右腕
    d.rectangle((11, 27, 15, 31), fill=body)      # 左足
    d.rectangle((17, 27, 21, 31), fill=body)      # 右足
    d.rectangle((11, 4, 21, 14), fill=body)       # あたま(四角)
    d.rectangle((13, 17, 19, 24), fill=light)     # 胸板
    d.polygon([(11, 4), (16, 0), (21, 4)], fill=acc)  # かぶと飾り
    return [13, 19], 9, True

ARCHS = {
    "slime": a_slime, "bird": a_bird, "beast": a_beast,
    "dragon": a_dragon, "serpent": a_serpent, "golem": a_golem,
}

def render(arch, palette, fierce_override=None):
    fill, d = newlayer()
    exs, ey, fierce = ARCHS[arch](d, palette)
    img = outline(fill)
    dd = ImageDraw.Draw(img)
    eyes(dd, exs, ey, fierce if fierce_override is None else fierce_override)
    return img.resize((G * SCALE, G * SCALE), Image.NEAREST)

# パレット例(色つき・かわいい)
PALETTES = {
    "slime":   ((90, 200, 150, 255),  (180, 240, 210, 255), (60, 150, 110, 255)),
    "bird":    ((240, 180, 70, 255),  (255, 225, 150, 255), (230, 120, 60, 255)),
    "beast":   ((120, 150, 90, 255),  (190, 215, 150, 255), (210, 90, 80, 255)),
    "dragon":  ((90, 130, 220, 255),  (160, 200, 245, 255), (240, 200, 80, 255)),
    "serpent": ((150, 110, 200, 255), (205, 180, 240, 255), (240, 200, 80, 255)),
    "golem":   ((150, 140, 120, 255), (200, 195, 180, 255), (230, 200, 90, 255)),
}

if __name__ == "__main__":
    os.makedirs("/tmp/spike", exist_ok=True)
    order = ["slime", "bird", "beast", "dragon", "serpent", "golem"]
    labels = {"slime": "スライム(幼)", "bird": "鳥", "beast": "四足獣",
              "dragon": "ドラゴン", "serpent": "大蛇", "golem": "ゴーレム"}
    cell = G * SCALE
    sheet = Image.new("RGBA", (cell * len(order), cell + 28), (238, 238, 236, 255))
    sd = ImageDraw.Draw(sheet)
    for i, a in enumerate(order):
        im = render(a, PALETTES[a])
        sheet.alpha_composite(im, (i * cell, 0))
        sd.text((i * cell + 6, cell + 8), labels[a], fill=(40, 40, 40))
    sheet.save("/tmp/spike/sheet.png")
    print("spike -> /tmp/spike/sheet.png")
