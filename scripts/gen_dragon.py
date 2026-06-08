#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
品質バー検証: 「カッコいい」デジモン寄りドラゴンを1体だけ本気で描く。
- くりくり目をやめ、鋭い吊り目+牙+爪+翼の骨+背びれ+3トーン陰影
- 32x32論理 / 出力 大きめ。色版とモノクロLCD版の両方を出す。
"""
import os
from PIL import Image, ImageDraw, ImageFilter, ImageChops

G = 32; SCALE = 10
K = (22, 20, 26, 255)     # 輪郭(ほぼ黒)
WHT = (250, 250, 252, 255)

# 色版パレット(青竜・3トーン)
DARK = (44, 70, 150, 255)
BASE = (70, 110, 210, 255)
LITE = (130, 175, 245, 255)
BELLY= (205, 225, 250, 255)
ACC  = (240, 196, 70, 255)   # 角/爪/背びれ(金)
ACCD = (180, 130, 30, 255)
MEMB = (90, 140, 225, 255)   # 翼膜
EYE  = (255, 220, 80, 255)
MOUTH= (150, 40, 50, 255)

def newlayer():
    img = Image.new("RGBA", (G, G), (0, 0, 0, 0))
    return img, ImageDraw.Draw(img)

def outline(fill, t=1):
    a = fill.split()[3]
    dil = a.filter(ImageFilter.MaxFilter(2 * t + 1))
    ring = ImageChops.subtract(dil, a)
    base = Image.new("RGBA", fill.size, (0, 0, 0, 0))
    base.paste(K, (0, 0), ring)
    base.alpha_composite(fill)
    return base

def draw_dragon():
    fill, d = newlayer()
    # ── 後方の翼(膜+骨) 右上に大きく ──
    wing = [(17, 12), (31, 2), (30, 9), (31, 14), (27, 13), (28, 19), (22, 16), (19, 18)]
    d.polygon(wing, fill=MEMB)
    # 翼の骨(ライン)
    for tip in [(31, 2), (31, 14), (28, 19)]:
        d.line((18, 13) + tip, fill=DARK)
    # ── しっぽ(右下・矢じり) ──
    d.polygon([(22, 24), (30, 30), (31, 25), (26, 22)], fill=BASE)
    d.polygon([(29, 31), (31, 23), (27, 27)], fill=ACC)   # 矢じり
    # ── 胴(3トーン) ──
    d.ellipse((11, 13, 27, 30), fill=BASE)
    d.ellipse((11, 13, 22, 26), fill=DARK)                # 背側を暗く
    d.ellipse((13, 19, 25, 30), fill=BASE)
    d.ellipse((14, 22, 23, 30), fill=BELLY)               # おなか
    # 背びれ(三角の連なり)
    for bx in range(13, 25, 3):
        d.polygon([(bx, 13), (bx + 1, 8), (bx + 3, 14)], fill=ACC)
        d.polygon([(bx, 13), (bx + 1, 10), (bx + 2, 13)], fill=ACCD)
    # ── 足+かぎ爪 ──
    for fx in (14, 21):
        d.rectangle((fx, 27, fx + 3, 31), fill=DARK)
        for cx in range(fx, fx + 4, 1):                   # 爪
            d.point((cx, 31), fill=ACC)
        d.polygon([(fx-1,31),(fx,29),(fx+1,31)], fill=WHT)
    # ── 首 → 頭(左向き) ──
    d.polygon([(9, 24), (8, 13), (15, 12), (16, 23)], fill=BASE)
    d.ellipse((8, 13, 15, 22), fill=DARK)                 # 首の影
    d.ellipse((2, 9, 13, 20), fill=BASE)                  # 頭
    d.ellipse((2, 13, 11, 20), fill=DARK)                 # 頭の下に影…逆: あご側
    d.ellipse((3, 9, 12, 16), fill=BASE)
    # ── あご/口(開いて牙) ──
    d.polygon([(2, 14), (-1, 15), (5, 16)], fill=BASE)    # 上あご(突き出る)
    d.polygon([(2, 17), (0, 19), (6, 18)], fill=DARK)     # 下あご
    d.polygon([(1, 15), (4, 15), (3, 18), (2, 18)], fill=MOUTH)  # 口の中
    # 牙
    d.polygon([(2, 15), (3, 17), (4, 15)], fill=WHT)
    d.polygon([(2, 18), (3, 17), (4, 18)], fill=WHT)
    # ── 角(後方へ2本・段付き) ──
    for off in (0, 3):
        d.polygon([(9 + off, 9), (15 + off, 2), (12 + off, 9)], fill=ACC)
        d.polygon([(13 + off, 5), (15 + off, 2), (13 + off, 6)], fill=ACCD)
    # ── ほほの棘(エラ) ──
    d.polygon([(6, 18), (3, 22), (9, 19)], fill=ACC)

    img = outline(fill)
    dd = ImageDraw.Draw(img)
    # ── 鋭い吊り目(くりくりにしない) ──
    # 目のくぼみ(黒の鋭角)＋光る瞳
    dd.polygon([(5, 12), (10, 13), (6, 15)], fill=K)
    dd.line((5, 12), fill=K)
    dd.point((7, 13), fill=EYE)
    dd.point((8, 13), fill=EYE)
    dd.point((8, 12), fill=WHT)
    # 眉(怒り)
    dd.line((5, 11) + (10, 12), fill=K)
    # 鼻孔
    dd.point((2, 14), fill=K)
    return img

def to_mono(img):
    """LCD風モノクロ(緑地に黒)。輝度しきい値でドット化。"""
    bg = (150, 170, 120, 255)   # 黄緑LCD
    ink = (28, 40, 30, 255)
    out = Image.new("RGBA", img.size, bg)
    px = img.load()
    for y in range(img.height):
        for x in range(img.width):
            r, g, b, a = px[x, y]
            if a < 80:
                continue
            lum = 0.299 * r + 0.587 * g + 0.114 * b
            # 暗い＝インク。明るいハイライトは抜く(LCDの白)。中間はディザ。
            if lum < 110:
                out.putpixel((x, y), ink)
            elif lum < 180:
                if (x + y) % 2 == 0:
                    out.putpixel((x, y), ink)
            # 明るい部分は地のまま(抜き)
    return out

if __name__ == "__main__":
    os.makedirs("/tmp/spike", exist_ok=True)
    color = draw_dragon().resize((G * SCALE, G * SCALE), Image.NEAREST)
    mono = to_mono(draw_dragon()).resize((G * SCALE, G * SCALE), Image.NEAREST)
    # 並べる
    pad = 16
    sheet = Image.new("RGBA", (G * SCALE * 2 + pad * 3, G * SCALE + pad * 2 + 24), (236, 236, 234, 255))
    sheet.alpha_composite(color, (pad, pad))
    sheet.alpha_composite(mono, (pad * 2 + G * SCALE, pad))
    dd = ImageDraw.Draw(sheet)
    dd.text((pad + 4, pad + G * SCALE + 6), "color (3-tone shaded)", fill=(40, 40, 40))
    dd.text((pad * 2 + G * SCALE + 4, pad + G * SCALE + 6), "mono LCD (Digivice look)", fill=(40, 40, 40))
    sheet.save("/tmp/spike/dragon.png")
    print("dragon -> /tmp/spike/dragon.png")
