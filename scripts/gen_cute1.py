#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
かわいい再挑戦 第1号「メブキ」(タネの芽の精霊/g系統 幼I想定)。
ペルソナ全指摘を反映:
- 目を大きく丸く・顔の上半分へ(黄金比)+白目+大きなハイライト(最重要)
- 配色は金茶をやめ明るい3色(クリーム/緑/ほっぺピンク)、色数を絞る
- 牙爪ゼロ・丸いシルエット・口は小さく・色味のある暗色輪郭(純黒禁止)
"""
import os
from PIL import Image, ImageDraw, ImageFilter, ImageChops

G = 32; SCALE = 8
OUT = (92, 72, 64, 255)          # 温かい茶系の輪郭(純黒でない)
W = (255, 255, 255, 255)
# 体(クリーム3トーン)
CD = (228, 206, 162, 255); CB = (252, 238, 205, 255); CL = (255, 251, 234, 255)
# 芽(緑)
LFD = (86, 170, 96, 255); LF = (140, 208, 120, 255); LFL = (190, 232, 160, 255)
PK = (248, 158, 170, 255)        # ほっぺ
ED = (70, 56, 62, 255)           # 瞳(やわらかい黒)
GB = (245, 206, 92, 255)         # 小さな金の差し色


def outline(fill, col=OUT, t=1):
    a = fill.split()[3]
    ring = ImageChops.subtract(a.filter(ImageFilter.MaxFilter(2 * t + 1)), a)
    base = Image.new("RGBA", fill.size, (0, 0, 0, 0))
    base.paste(col, (0, 0), ring)
    base.alpha_composite(fill)
    return base


def draw():
    f = Image.new("RGBA", (G, G), (0, 0, 0, 0)); d = ImageDraw.Draw(f)
    # ── 芽(頭のふた葉) ──
    d.line((16, 4, 16, 11), fill=LFD)
    for sgn in (-1, 1):
        d.polygon([(16, 7), (16 + sgn * 6, 3), (16 + sgn * 7, 8), (16, 10)], fill=LF)
        d.polygon([(16, 8), (16 + sgn * 4, 5), (16 + sgn * 5, 8)], fill=LFL)
    d.ellipse((14, 8, 18, 12), fill=GB)              # 芽元の小さな金の実
    d.ellipse((15, 9, 17, 11), fill=LFD)
    # ── 体(まんまる) ──
    d.ellipse((6, 11, 26, 30), fill=CB)
    d.ellipse((6, 11, 20, 24), fill=CL)              # 左上の光
    d.ellipse((8, 21, 24, 31), fill=CD)              # 下の影
    d.ellipse((7, 12, 25, 29), fill=CB)              # ベース戻し(中央)
    d.ellipse((9, 13, 22, 23), fill=CL)              # 上半分を明るく
    # ── ちび足 ──
    d.ellipse((10, 27, 15, 31), fill=CD)
    d.ellipse((17, 27, 22, 31), fill=CD)
    img = outline(f); dd = ImageDraw.Draw(img)
    # ── 大きな丸い目(顔の上半分・離して配置) ── 最重要
    for ex in (12, 20):
        dd.ellipse((ex - 3, 14, ex + 3, 22), fill=W)          # 大きな白目(縦長)
        dd.ellipse((ex - 3, 14, ex + 3, 22), outline=OUT)
        dd.ellipse((ex - 2, 16, ex + 2, 21), fill=ED)         # 大きな瞳
        dd.ellipse((ex - 1, 16, ex + 1, 18), fill=W)          # 大きなハイライト
        dd.point((ex + 1, 19), fill=(150, 140, 150, 255))     # 下の小さな反射
    # ── ほっぺ(目の下・外側) ──
    dd.ellipse((7, 21, 10, 23), fill=PK)
    dd.ellipse((22, 21, 25, 23), fill=PK)
    # ── 小さな口(にっこり・控えめ) ──
    dd.arc((14, 22, 18, 26), 10, 170, fill=OUT)
    return img


if __name__ == "__main__":
    os.makedirs("/tmp/spike", exist_ok=True)
    img = draw().resize((G * SCALE, G * SCALE), Image.NEAREST)
    pad = 18
    sheet = Image.new("RGBA", (G * SCALE + pad * 2, G * SCALE + pad * 2 + 22), (245, 245, 242, 255))
    sheet.alpha_composite(img, (pad, pad))
    ImageDraw.Draw(sheet).text((pad, G * SCALE + pad + 5), "Mebuki - cute remake (big eyes / bright / soft)", fill=(60, 60, 60))
    # 8x8シルエットテストも併記
    sil = draw().resize((8, 8), Image.LANCZOS).point(lambda p: 0 if p < 128 else 255).resize((64, 64), Image.NEAREST)
    sheet.alpha_composite(sil.convert("RGBA"), (G * SCALE + pad - 70, pad))
    sheet.save("/tmp/spike/cute1.png")
    print("cute1 -> /tmp/spike/cute1.png")
