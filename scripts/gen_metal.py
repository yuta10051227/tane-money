#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
新cool枠 第1号: 機械竜ギアドレイク(オリジナル/h系統★5想定)。
UIデザイナー仕様準拠: 鋼4トーン+色味のある輪郭(純黒禁止)/左上45度光源/
シアンの縦スリット目/胸のコイン紋章(お金刻印)/肩の歯車/非対称翼(片翼展開)。
黄金竜(legend.png)とは別タイプのカッコよさを出す。
"""
import os
from PIL import Image, ImageDraw, ImageFilter, ImageChops

G = 48; SCALE = 7
OUT = (30, 40, 55, 255)       # 色味のある暗色アウトライン(純黒でない)
W = (240, 248, 252, 255)
# 鋼4トーン
SD = (60, 75, 92, 255)
SB = (122, 138, 152, 255)
SL = (182, 196, 208, 255)
SH = (226, 236, 243, 255)
# アクセント
GD = (170, 122, 30, 255); GB = (230, 176, 52, 255)
RED = (208, 64, 50, 255); RDK = (150, 36, 32, 255)
CY = (96, 226, 206, 255)


def outline(fill, col=OUT, t=1):
    a = fill.split()[3]
    ring = ImageChops.subtract(a.filter(ImageFilter.MaxFilter(2 * t + 1)), a)
    base = Image.new("RGBA", fill.size, (0, 0, 0, 0))
    base.paste(col, (0, 0), ring)
    base.alpha_composite(fill)
    return base


def cog(d, cx, cy, r, col, col2):
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=col)
    for ang in range(0, 360, 45):
        import math
        x = cx + int((r + 1) * math.cos(math.radians(ang)))
        y = cy + int((r + 1) * math.sin(math.radians(ang)))
        d.rectangle((x - 1, y - 1, x + 1, y + 1), fill=col)
    d.ellipse((cx - r + 2, cy - r + 2, cx + r - 2, cy + r - 2), fill=col2)


def draw():
    f = Image.new("RGBA", (G, G), (0, 0, 0, 0))
    d = ImageDraw.Draw(f)

    # ── 右翼(展開・金属膜+赤い排気) 右上に大きく ──
    wing = [(27, 17), (47, 6), (45, 14), (47, 20), (40, 19), (42, 28), (33, 22), (30, 23)]
    d.polygon(wing, fill=SB)
    d.polygon([(29, 18), (44, 9), (44, 14), (31, 20)], fill=SD)
    for tip in [(47, 6), (47, 20), (42, 28)]:           # 翼の骨(鋼)
        d.line((28, 18) + tip, fill=SL)
    for ry in (10, 14, 18):                              # 赤い排気スリット
        d.line((38, ry, 44, ry - 1), fill=RED)

    # ── しっぽ(右下・金属棘) ──
    d.polygon([(30, 35), (45, 45), (47, 39), (38, 32)], fill=SB)
    d.polygon([(30, 36), (40, 42), (36, 34)], fill=SD)
    d.polygon([(44, 38), (47, 33), (46, 40)], fill=SL)   # 棘
    d.polygon([(40, 41), (43, 37), (43, 43)], fill=SL)

    # ── 後脚 ──
    d.ellipse((28, 34, 38, 46), fill=SD)
    d.rectangle((29, 41, 34, 47), fill=SD)
    for cx in (29, 31, 33):
        d.polygon([(cx, 47), (cx + 1, 44), (cx + 2, 47)], fill=SL)

    # ── 胴(鋼4トーン) ──
    d.ellipse((14, 20, 38, 46), fill=SB)
    d.ellipse((14, 20, 31, 40), fill=SD)                 # 背側影
    d.ellipse((16, 19, 30, 33), fill=SL)                 # 左上の光当たり
    d.ellipse((18, 34, 33, 47), fill=SB)
    d.ellipse((19, 37, 31, 47), fill=SL)                 # 腹の明
    # 継ぎ目ライン(装甲)
    d.line((16, 33, 36, 35), fill=SD)
    d.line((22, 21, 24, 45), fill=SD)
    # 左翼(畳んで胴に密着=非対称・質量感)
    d.polygon([(20, 22), (14, 16), (16, 26), (22, 28)], fill=SD)
    d.line((15, 18, 20, 25), fill=OUT)

    # ── 胸のコイン紋章(お金の刻印) ──
    cog(d, 25, 30, 3, GB, GD)
    d.point((25, 30), fill=SH)

    # ── 背びれ(鋼の連なり) ──
    for bx in range(16, 34, 3):
        d.polygon([(bx, 22), (bx + 1, 15), (bx + 4, 23)], fill=SL)
        d.polygon([(bx, 22), (bx + 1, 18), (bx + 3, 22)], fill=SD)

    # ── 前脚＋かぎ爪(前に突き出す) ──
    d.ellipse((15, 36, 25, 47), fill=SB)
    d.rectangle((14, 42, 22, 47), fill=SD)
    for cx in (14, 17, 20):
        d.polygon([(cx, 47), (cx + 1, 42), (cx + 2, 47)], fill=W)

    # ── 首(短く太く) → 竜頭(左上に上げる) ──
    d.polygon([(13, 33), (11, 17), (23, 15), (24, 31)], fill=SB)
    d.polygon([(13, 32), (12, 19), (18, 18), (19, 30)], fill=SD)
    for ny in (18, 22, 26):                              # 頸部リブ
        d.line((14, ny, 22, ny - 1), fill=SD)
    d.polygon([(20, 16), (26, 15), (22, 19)], fill=RED)  # うなじの排気

    d.ellipse((4, 11, 20, 27), fill=SB)                  # 頭
    d.ellipse((4, 18, 17, 27), fill=SD)
    d.ellipse((5, 11, 17, 20), fill=SL)                  # 頭の光
    # あご(開く)＋金属牙
    d.polygon([(4, 19), (-2, 21), (6, 23)], fill=SB)
    d.polygon([(4, 23), (0, 26), (8, 25)], fill=SD)
    d.polygon([(1, 21), (6, 21), (4, 25), (2, 25)], fill=RDK)  # 口内(赤熱)
    d.polygon([(2, 21), (3, 24), (4, 21)], fill=W)
    d.polygon([(5, 21), (6, 23), (7, 21)], fill=W)
    # 角(後方へ2本・段付き/金属)
    for off in (0, 4):
        d.polygon([(12 + off, 11), (22 + off, 2), (16 + off, 12)], fill=SL)
        d.polygon([(17 + off, 5), (22 + off, 2), (18 + off, 7)], fill=SD)
    # 鼻孔・リベット
    d.point((2, 20), fill=OUT)
    for sx, sy in [(10, 15), (14, 14), (8, 22)]:
        d.point((sx, sy), fill=SH)

    img = outline(f)
    dd = ImageDraw.Draw(img)
    # ── 冷たいシアンの縦スリット目＋赤いリング＋重い半眼 ──
    dd.polygon([(7, 16), (15, 17), (13, 20), (8, 19)], fill=OUT)   # 眼窩(深い)
    dd.polygon([(9, 17), (13, 18), (12, 19), (9, 19)], fill=CY)    # シアン虹彩
    dd.line((11, 17, 11, 19), fill=OUT)                            # 縦スリット瞳孔
    dd.point((10, 17), fill=W)                                     # きらめき
    dd.point((14, 18), fill=RED)                                   # 赤いリング点
    dd.line((6, 14, 15, 16), fill=OUT)                            # 重いまぶた/眉
    dd.line((6, 15, 14, 17), fill=SD)
    return img


if __name__ == "__main__":
    os.makedirs("/tmp/spike", exist_ok=True)
    img = draw().resize((G * SCALE, G * SCALE), Image.NEAREST)
    pad = 20
    sheet = Image.new("RGBA", (G * SCALE + pad * 2, G * SCALE + pad * 2 + 24), (40, 42, 48, 255))
    sheet.alpha_composite(img, (pad, pad))
    ImageDraw.Draw(sheet).text((pad, G * SCALE + pad + 6), "GearDrake - metal dragon (h-line, cool)", fill=(210, 220, 230))
    sheet.save("/tmp/spike/metal.png")
    print("metal -> /tmp/spike/metal.png")
