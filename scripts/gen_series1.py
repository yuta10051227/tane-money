#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
シリーズ1「タネの章」モンスター制作エンジン（オリジナル）。
お金×成長×自然界×伝説×歴史。色付き・3トーン陰影・鋭い造形・特徴パーツ。
参照チャートは段階構造のみ借用し、絵/名は完全オリジナル。

第1バッチ: maneta(卵) sumi(幼I) futaba(幼II) koryu(成長A) mizuchi(成長B) hinokami(人型/成熟)
"""
import os, sys
from PIL import Image, ImageDraw, ImageFilter, ImageChops

G = 32; SCALE = 8
K = (24, 22, 28, 255)
WHT = (250, 250, 252, 255)


def outline(fill, t=1):
    a = fill.split()[3]
    ring = ImageChops.subtract(a.filter(ImageFilter.MaxFilter(2 * t + 1)), a)
    base = Image.new("RGBA", fill.size, (0, 0, 0, 0))
    base.paste(K, (0, 0), ring)
    base.alpha_composite(fill)
    return base


def eye(d, ex, ey, style="cute", col=K):
    if style == "cute":
        d.ellipse((ex - 2, ey - 2, ex + 2, ey + 2), fill=WHT)
        d.ellipse((ex - 1, ey - 1, ex + 1, ey + 1), fill=col)
        d.point((ex, ey - 1), fill=WHT)
    else:  # fierce: 鋭い吊り目
        d.polygon([(ex - 2, ey - 1), (ex + 2, ey), (ex - 1, ey + 2)], fill=K)
        d.point((ex, ey), fill=col)
        d.point((ex - 1, ey), fill=WHT)
        d.line((ex - 2, ey - 2, ex + 2, ey - 1), fill=K)  # 眉


# ───────────────── モンスター(各 fill を描く→eye指定を返す) ─────────────────
def m_maneta(d):  # マネタマ(卵・お金)
    shell = (236, 228, 204, 255); sh = (206, 196, 168, 255)
    gold = (240, 198, 76, 255); goldd = (190, 140, 36, 255)
    d.ellipse((8, 6, 24, 30), fill=shell)
    d.ellipse((9, 16, 23, 30), fill=sh)              # 下の影
    # コイン紋章
    d.ellipse((12, 13, 20, 22), fill=gold)
    d.ellipse((13, 14, 19, 21), fill=goldd)
    d.line((16, 15, 16, 20), fill=gold); d.line((14, 17, 18, 17), fill=gold)  # ¥っぽい
    # ヒビ
    for p in [(11, 9), (13, 7), (15, 9), (17, 7), (20, 9)]:
        d.point(p, fill=K)
    return []  # 目なし


def m_sumi(d):  # スミっち(幼I・黒い土の芽精霊)
    body = (66, 78, 70, 255); lite = (100, 116, 104, 255)
    stem = (90, 170, 90, 255); leaf = (130, 205, 120, 255)
    d.ellipse((9, 15, 23, 29), fill=body)            # 丸い体
    d.ellipse((12, 21, 20, 28), fill=lite)
    d.rectangle((15, 10, 16, 16), fill=stem)         # 芽の茎
    d.polygon([(16, 11), (21, 9), (18, 14)], fill=leaf)   # 葉
    for fx in (11, 18):                              # ちび足
        d.ellipse((fx, 27, fx + 3, 30), fill=body)
    return [(13, 22, "cute"), (19, 22, "cute")]


def m_futaba(d):  # フタバ(幼II・双葉の芽)
    body = (150, 205, 120, 255); lite = (200, 235, 175, 255)
    leaf = (110, 190, 95, 255); leafd = (70, 150, 70, 255)
    # 双葉
    for sgn in (-1, 1):
        d.polygon([(16, 9), (16 + sgn * 8, 4), (16 + sgn * 9, 10), (16, 12)], fill=leaf)
        d.line((16, 10, 16 + sgn * 7, 6), fill=leafd)
    d.ellipse((9, 11, 23, 29), fill=body)
    d.ellipse((12, 18, 20, 28), fill=lite)
    for fx in (12, 17):
        d.ellipse((fx, 27, fx + 3, 31), fill=body)
    d.point((11, 20), fill=(230, 150, 150, 255)); d.point((21, 20), fill=(230, 150, 150, 255))  # ほほ
    return [(13, 18, "cute"), (19, 18, "cute")]


def m_koryu(d):  # コリュウ(成長A・小さな獣竜)
    body = (110, 170, 95, 255); dark = (70, 130, 70, 255); belly = (215, 225, 170, 255)
    acc = (240, 198, 76, 255)
    d.polygon([(22, 22), (29, 26), (27, 20)], fill=dark)      # しっぽ
    d.ellipse((9, 14, 24, 30), fill=body)                    # 胴
    d.ellipse((9, 14, 19, 25), fill=dark)
    d.ellipse((12, 21, 23, 30), fill=belly)                  # 腹
    d.ellipse((4, 8, 15, 19), fill=body)                     # 頭(左)
    d.ellipse((4, 12, 13, 19), fill=dark)
    d.polygon([(4, 13), (0, 14), (5, 16)], fill=body)        # 口先
    for sgn, bx in ((-1, 7), (1, 11)):                       # 小さい角
        d.polygon([(bx, 8), (bx + sgn, 4), (bx + sgn * 2, 8)], fill=acc)
    for fx in (12, 18):                                      # 足+爪
        d.rectangle((fx, 28, fx + 3, 31), fill=dark)
        d.polygon([(fx - 1, 31), (fx, 29), (fx + 1, 31)], fill=WHT)
    return [(8, 12, "fierce", (255, 220, 90, 255)), (12, 12, "fierce", (255, 220, 90, 255))]


def m_mizuchi(d):  # ミズチ(成長B・水生の小竜)
    body = (70, 150, 205, 255); dark = (44, 100, 165, 255); belly = (200, 230, 245, 255)
    fin = (120, 200, 235, 255)
    # 背びれ(連なり)
    for bx in range(11, 24, 3):
        d.polygon([(bx, 13), (bx + 1, 7), (bx + 3, 14)], fill=fin)
    d.polygon([(22, 22), (31, 20), (28, 27)], fill=fin)      # 尾びれ
    d.ellipse((9, 13, 25, 30), fill=body)
    d.ellipse((9, 13, 19, 24), fill=dark)
    d.ellipse((12, 20, 24, 30), fill=belly)
    d.ellipse((4, 9, 15, 19), fill=body)                     # 頭
    d.polygon([(4, 13), (0, 14), (5, 16)], fill=body)
    for sgn in (-1, 1):                                      # ほおびれ
        d.polygon([(8, 17), (8 + sgn * 4, 21), (10, 18)], fill=fin)
    for fx in (13, 18):
        d.ellipse((fx, 28, fx + 3, 31), fill=dark)
    return [(8, 13, "fierce", (255, 255, 255, 255)), (12, 13, "fierce", (255, 255, 255, 255))]


def m_hinokami(d):  # ヒノカミ(成熟・炎の戦士＝カッコいい人型/激レア候補)
    base = (235, 110, 40, 255); lite = (255, 190, 70, 255); dark = (180, 60, 30, 255)
    # 炎の髪(上にめらめら)
    for bx, h in [(11, 2), (14, -1), (16, 0), (18, -2), (21, 2)]:
        d.polygon([(bx, 8), (bx + 1, h), (bx + 3, 8)], fill=lite)
    # 体(人型)
    d.rectangle((12, 14, 20, 26), fill=base)                 # 胴
    d.polygon([(12, 14), (12, 26), (16, 26), (16, 14)], fill=dark)  # 左半身影
    d.rectangle((8, 15, 11, 24), fill=base)                  # 左腕
    d.rectangle((21, 15, 24, 24), fill=base)                 # 右腕
    d.ellipse((7, 22, 11, 26), fill=lite)                    # こぶし
    d.ellipse((21, 22, 25, 26), fill=lite)
    d.rectangle((12, 26, 15, 31), fill=dark)                 # 脚
    d.rectangle((17, 26, 20, 31), fill=dark)
    d.ellipse((11, 7, 21, 17), fill=base)                    # 頭
    d.ellipse((11, 11, 21, 17), fill=dark)                   # あご影
    d.rectangle((13, 17, 19, 23), fill=lite)                 # 胸の炎核
    return [(13, 12, "fierce", (255, 245, 120, 255)), (18, 12, "fierce", (255, 245, 120, 255))]


MONS = {
    "maneta": (m_maneta, "マネタマ/卵"),
    "sumi":   (m_sumi,   "スミっち/幼I"),
    "futaba": (m_futaba, "フタバ/幼II"),
    "koryu":  (m_koryu,  "コリュウ/成長"),
    "mizuchi":(m_mizuchi,"ミズチ/成長"),
    "hinokami":(m_hinokami,"ヒノカミ/人型"),
}


def render(mid):
    fill = Image.new("RGBA", (G, G), (0, 0, 0, 0))
    d = ImageDraw.Draw(fill)
    eyes = MONS[mid][0](d)
    img = outline(fill)
    dd = ImageDraw.Draw(img)
    for e in eyes:
        if len(e) == 3:
            eye(dd, e[0], e[1], e[2])
        else:
            eye(dd, e[0], e[1], e[2], e[3])
    return img


if __name__ == "__main__":
    os.makedirs("/tmp/spike", exist_ok=True)
    order = ["maneta", "sumi", "futaba", "koryu", "mizuchi", "hinokami"]
    cell = G * SCALE
    sheet = Image.new("RGBA", (cell * len(order), cell + 30), (236, 236, 234, 255))
    sd = ImageDraw.Draw(sheet)
    for i, mid in enumerate(order):
        sheet.alpha_composite(render(mid).resize((cell, cell), Image.NEAREST), (i * cell, 0))
        sd.text((i * cell + 6, cell + 10), MONS[mid][1], fill=(40, 40, 40))
    sheet.save("/tmp/spike/series1_batch1.png")
    print("batch1 -> /tmp/spike/series1_batch1.png")
