#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
本気の1体: 伝説の黄金竜（オリジナル）。お金×伝説×歴史を体に刻印。
レビュー反映: 強いシルエット / 表情のある鋭い目 / 4トーン陰影 / コイン装甲(コンセプト刻印) / 牙・爪・鱗のディテール。
48x48の大きめキャンバスで作り込む。
"""
import os
from PIL import Image, ImageDraw, ImageFilter, ImageChops

G = 48; SCALE = 7
K = (26, 22, 30, 255)
W = (252, 250, 245, 255)
# 黄金パレット(4トーン)
GD = (150, 100, 26, 255)   # dark gold
GB = (214, 160, 42, 255)   # base gold
GL = (245, 206, 92, 255)   # light gold
GH = (255, 240, 176, 255)  # highlight
# 赤いたてがみ/翼膜
RD = (150, 40, 38, 255)
RB = (200, 64, 52, 255)
RL = (235, 110, 80, 255)
EYE = (255, 196, 60, 255)
COIN = (250, 222, 120, 255)


def outline(fill, t=1):
    a = fill.split()[3]
    ring = ImageChops.subtract(a.filter(ImageFilter.MaxFilter(2 * t + 1)), a)
    base = Image.new("RGBA", fill.size, (0, 0, 0, 0))
    base.paste(K, (0, 0), ring)
    base.alpha_composite(fill)
    return base


def draw():
    f = Image.new("RGBA", (G, G), (0, 0, 0, 0))
    d = ImageDraw.Draw(f)

    # ── 翼(後方・赤膜＋金の骨) 右奥に大きく ──
    wing = [(26, 18), (47, 4), (44, 13), (47, 18), (40, 18), (43, 27), (34, 22), (29, 24)]
    d.polygon(wing, fill=RB)
    d.polygon([(28, 19), (44, 7), (43, 13), (29, 21)], fill=RD)   # 膜の影
    for tip in [(47, 4), (47, 18), (43, 27)]:                     # 翼の骨(金)
        d.line((27, 19) + tip, fill=GB)

    # ── しっぽ(右下) ──
    d.polygon([(30, 34), (45, 44), (47, 38), (38, 31)], fill=GB)
    d.polygon([(30, 35), (40, 41), (36, 33)], fill=GD)
    d.polygon([(44, 46), (47, 35), (41, 40)], fill=GL)            # 矢じり

    # ── 後脚 ──
    d.ellipse((28, 33, 38, 45), fill=GD)
    d.rectangle((29, 40, 34, 47), fill=GD)
    for cx in (29, 31, 33):
        d.polygon([(cx, 47), (cx + 1, 44), (cx + 2, 47)], fill=GL)

    # ── 胴(4トーン) ──
    d.ellipse((14, 20, 38, 46), fill=GB)
    d.ellipse((14, 20, 31, 40), fill=GD)            # 背側の影
    d.ellipse((17, 30, 35, 46), fill=GB)
    d.ellipse((18, 34, 32, 47), fill=GL)            # 腹の明
    # コイン装甲(お金の刻印): 腹に金貨プレート3段
    for i, cy in enumerate((35, 39, 43)):
        d.ellipse((20 + i, cy, 30 - i, cy + 3), fill=COIN)
        d.ellipse((22 + i, cy, 28 - i, cy + 3), fill=GD)
        d.point(((25), cy + 1), fill=GH)

    # ── 背びれ(金の連なり) ──
    for bx in range(16, 34, 3):
        d.polygon([(bx, 22), (bx + 1, 14), (bx + 4, 23)], fill=GL)
        d.polygon([(bx, 22), (bx + 1, 17), (bx + 3, 22)], fill=GD)

    # ── 前脚＋かぎ爪 ──
    d.ellipse((16, 36, 25, 47), fill=GB)
    d.rectangle((17, 42, 23, 47), fill=GD)
    for cx in (17, 19, 21):
        d.polygon([(cx, 47), (cx + 1, 43), (cx + 2, 47)], fill=W)

    # ── 首(太く) → 頭 ──
    d.polygon([(13, 34), (12, 18), (22, 16), (24, 32)], fill=GB)
    d.polygon([(13, 33), (13, 20), (18, 19), (19, 31)], fill=GD)
    # 赤いたてがみ(首の後ろ)
    for ny in range(17, 32, 3):
        d.polygon([(20, ny), (26, ny - 1), (22, ny + 3)], fill=RB)

    d.ellipse((4, 12, 20, 28), fill=GB)             # 頭
    d.ellipse((4, 19, 17, 28), fill=GD)             # あご影
    d.ellipse((5, 12, 17, 22), fill=GB)
    # 口(開く)＋牙
    d.polygon([(4, 20), (-2, 22), (6, 24)], fill=GB)      # 上あご
    d.polygon([(4, 24), (0, 27), (8, 26)], fill=GD)       # 下あご
    d.polygon([(1, 22), (6, 22), (4, 26), (2, 26)], fill=(120, 30, 36, 255))  # 口内
    d.polygon([(2, 22), (3, 25), (4, 22)], fill=W)        # 牙上
    d.polygon([(5, 22), (6, 24), (7, 22)], fill=W)
    d.polygon([(2, 26), (3, 24), (4, 26)], fill=W)        # 牙下
    # 角(2本・後方へ・段付き)
    for off in (0, 4):
        d.polygon([(12 + off, 12), (22 + off, 2), (16 + off, 13)], fill=GL)
        d.polygon([(17 + off, 6), (22 + off, 2), (18 + off, 8)], fill=GD)
    # エラの棘
    d.polygon([(8, 26), (3, 31), (12, 27)], fill=GL)
    # 鼻孔・鱗の点
    d.point((2, 21), fill=K)
    for sx, sy in [(10, 16), (13, 18), (8, 15), (15, 16)]:
        d.point((sx, sy), fill=GL)

    img = outline(f)
    dd = ImageDraw.Draw(img)
    # ── 表情のある鋭い目(白目なし・睨み) ──
    # 目のくぼみ(黒)→金の虹彩→白いきらめき→怒り眉
    dd.polygon([(7, 17), (15, 18), (13, 21), (8, 20)], fill=K)
    dd.polygon([(9, 18), (13, 19), (12, 20), (9, 20)], fill=EYE)
    dd.point((11, 19), fill=K)                       # 瞳孔
    dd.point((10, 18), fill=W)                       # きらめき
    dd.line((6, 15, 15, 17), fill=K)                 # 太い怒り眉
    dd.line((6, 16, 14, 18), fill=K)
    return img


if __name__ == "__main__":
    os.makedirs("/tmp/spike", exist_ok=True)
    img = draw().resize((G * SCALE, G * SCALE), Image.NEAREST)
    pad = 20
    sheet = Image.new("RGBA", (G * SCALE + pad * 2, G * SCALE + pad * 2 + 24), (40, 42, 48, 255))
    sheet.alpha_composite(img, (pad, pad))
    ImageDraw.Draw(sheet).text((pad, G * SCALE + pad + 6), "Legendary Gold Dragon (concept: money/legend)", fill=(220, 220, 220))
    sheet.save("/tmp/spike/legend.png")
    print("legend -> /tmp/spike/legend.png")
