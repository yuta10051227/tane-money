#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
品質バー＆アニメ検証: カッコいいドラゴンを「特徴パーツ(翼)を動かす＋上下バウンド＋左右に歩く」。
- 翼を別レイヤーに分離し、パーツ単独で羽ばたかせる
- 出力: 静止1枚(/tmp/spike/dragon.png) と 歩行GIF(/tmp/spike/dragon_walk.gif)
"""
import os
from PIL import Image, ImageDraw, ImageFilter, ImageChops

G = 32; SCALE = 8
K = (22, 20, 26, 255)
WHT = (250, 250, 252, 255)
DARK = (44, 70, 150, 255); BASE = (70, 110, 210, 255); LITE = (130, 175, 245, 255)
BELLY = (205, 225, 250, 255)
ACC = (240, 196, 70, 255); ACCD = (180, 130, 30, 255)
MEMB = (90, 140, 225, 255); EYE = (255, 220, 80, 255); MOUTH = (150, 40, 50, 255)


def outline(fill, t=1):
    a = fill.split()[3]
    ring = ImageChops.subtract(a.filter(ImageFilter.MaxFilter(2 * t + 1)), a)
    base = Image.new("RGBA", fill.size, (0, 0, 0, 0))
    base.paste(K, (0, 0), ring)
    base.alpha_composite(fill)
    return base


def draw_wing(d, wf):
    """翼(特徴パーツ)。wf=羽ばたき量(-1=畳む/上, +1=広げ下げ)。"""
    dy = int(round(wf * 4))
    tip1 = (31, 2 + dy); tip2 = (31, 14 + dy // 2); tip3 = (28, 19 + dy // 3)
    wing = [(17, 12), tip1, (30, 9 + dy), tip2, (27, 13), tip3, (22, 16), (19, 18)]
    d.polygon(wing, fill=MEMB)
    for tip in (tip1, tip2, tip3):                 # 翼の骨
        d.line((18, 13) + tip, fill=DARK)


def draw_body(d):
    # しっぽ
    d.polygon([(22, 24), (30, 30), (31, 25), (26, 22)], fill=BASE)
    d.polygon([(29, 31), (31, 23), (27, 27)], fill=ACC)
    # 胴(3トーン)
    d.ellipse((11, 13, 27, 30), fill=BASE)
    d.ellipse((11, 13, 22, 26), fill=DARK)
    d.ellipse((13, 19, 25, 30), fill=BASE)
    d.ellipse((14, 22, 23, 30), fill=BELLY)
    # 背びれ
    for bx in range(13, 25, 3):
        d.polygon([(bx, 13), (bx + 1, 8), (bx + 3, 14)], fill=ACC)
        d.polygon([(bx, 13), (bx + 1, 10), (bx + 2, 13)], fill=ACCD)


def draw_legs(d, step):
    """step: 0/1 で前後の足を入れ替え(歩行)。"""
    fxs = (14, 21) if step == 0 else (15, 20)
    for i, fx in enumerate(fxs):
        ly = 27 + (1 if (i + step) % 2 == 0 else 0)
        d.rectangle((fx, ly, fx + 3, 31), fill=DARK)
        d.polygon([(fx - 1, 31), (fx, 29), (fx + 1, 31)], fill=WHT)
        for cx in range(fx, fx + 4):
            d.point((cx, 31), fill=ACC)


def draw_head(d):
    d.polygon([(9, 24), (8, 13), (15, 12), (16, 23)], fill=BASE)   # 首
    d.ellipse((8, 13, 15, 22), fill=DARK)
    d.ellipse((2, 9, 13, 20), fill=BASE)                           # 頭
    d.ellipse((3, 9, 12, 16), fill=BASE)
    d.polygon([(2, 14), (-1, 15), (5, 16)], fill=BASE)             # 上あご
    d.polygon([(2, 17), (0, 19), (6, 18)], fill=DARK)              # 下あご
    d.polygon([(1, 15), (4, 15), (3, 18), (2, 18)], fill=MOUTH)    # 口
    d.polygon([(2, 15), (3, 17), (4, 15)], fill=WHT)               # 牙
    d.polygon([(2, 18), (3, 17), (4, 18)], fill=WHT)
    for off in (0, 3):                                             # 角
        d.polygon([(9 + off, 9), (15 + off, 2), (12 + off, 9)], fill=ACC)
        d.polygon([(13 + off, 5), (15 + off, 2), (13 + off, 6)], fill=ACCD)
    d.polygon([(6, 18), (3, 22), (9, 19)], fill=ACC)              # エラ棘


def draw_eye(dd):
    dd.polygon([(5, 12), (10, 13), (6, 15)], fill=K)
    dd.point((7, 13), fill=EYE); dd.point((8, 13), fill=EYE); dd.point((8, 12), fill=WHT)
    dd.line((5, 11) + (10, 12), fill=K)                            # 怒り眉
    dd.point((2, 14), fill=K)                                      # 鼻孔


def frame(wf=0.0, step=0):
    fill = Image.new("RGBA", (G, G), (0, 0, 0, 0))
    d = ImageDraw.Draw(fill)
    draw_wing(d, wf)        # 翼(後ろ)
    draw_legs(d, step)
    draw_body(d)
    draw_head(d)
    img = outline(fill)
    draw_eye(ImageDraw.Draw(img))
    return img


if __name__ == "__main__":
    os.makedirs("/tmp/spike", exist_ok=True)
    frame(0.2, 0).resize((G * SCALE, G * SCALE), Image.NEAREST).save("/tmp/spike/dragon.png")

    # ── 歩行GIF: 翼パタパタ＋上下バウンド＋左右移動(進行方向を向く) ──
    import math
    W, H = 360, 200
    ground = 150
    spr = 5
    sw = G * spr
    flap = [-0.7, -0.2, 0.4, 0.9, 0.4, -0.2]   # 羽ばたきループ
    frames = []
    N = 48
    for i in range(N):
        # x位置: 左右往復
        phase = i / N
        tri = abs((phase * 2) % 2 - 1)            # 0..1..0 の三角波
        x = int(30 + tri * (W - sw - 60))
        going_right = ((phase * 2) % 2) < 1
        wf = flap[i % len(flap)]
        step = (i // 2) % 2
        bob = int(2 * spr * (0.5 - 0.5 * math.cos(i / len(flap) * math.pi)))  # 上下
        sp = frame(wf, step).resize((sw, sw), Image.NEAREST)
        if going_right:
            sp = sp.transpose(Image.FLIP_LEFT_RIGHT)  # 進行方向を向く(元は左向き)
        scene = Image.new("RGBA", (W, H), (228, 238, 226, 255))
        sd = ImageDraw.Draw(scene)
        sd.rectangle((0, ground + 4, W, H), fill=(200, 222, 198, 255))   # 地面
        sd.line((0, ground + 4, W, ground + 4), fill=(150, 180, 150, 255))
        # 影
        sd.ellipse((x + 10, ground - 2, x + sw - 10, ground + 8), fill=(180, 205, 178, 255))
        scene.alpha_composite(sp, (x, ground - sw + 6 - bob))
        frames.append(scene.convert("P", palette=Image.ADAPTIVE))
    frames[0].save("/tmp/spike/dragon_walk.gif", save_all=True,
                   append_images=frames[1:], duration=90, loop=0, disposal=2)
    print("walk -> /tmp/spike/dragon_walk.gif")
