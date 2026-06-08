#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
新cool枠 人型: 黄金神将ゴルド・パラディン(オリジナル/k系統★5・カッコいい人型)。
UIデザイナー神将仕様準拠: 5頭身/3/4立ち/剣を右上に掲げ盾を左に引く非対称/
逆三角の肩張り/兜の前立てにコイン紋章(お金刻印)/横長細目+鋭い眉/紺マント。
黄金鎧4トーン+鋼の剣+紺アクセント。
"""
import os
from PIL import Image, ImageDraw, ImageFilter, ImageChops

G = 48; SCALE = 7
OUT = (28, 26, 44, 255)        # 色味のある暗色アウトライン
W = (245, 248, 252, 255)
# 黄金鎧4トーン
GD = (150, 100, 26, 255); GB = (214, 160, 42, 255); GL = (245, 206, 92, 255); GH = (255, 236, 170, 255)
# 鋼(剣)
TD = (70, 80, 100, 255); TB = (150, 162, 178, 255); TL = (218, 226, 236, 255)
# 紺マント
ND = (20, 34, 78, 255); NB = (40, 64, 140, 255)
RED = (200, 52, 60, 255)       # 前立ての羽根
EYE = (130, 222, 255, 255)


def outline(fill, col=OUT, t=1):
    a = fill.split()[3]
    ring = ImageChops.subtract(a.filter(ImageFilter.MaxFilter(2 * t + 1)), a)
    base = Image.new("RGBA", fill.size, (0, 0, 0, 0))
    base.paste(col, (0, 0), ring)
    base.alpha_composite(fill)
    return base


def draw():
    f = Image.new("RGBA", (G, G), (0, 0, 0, 0))
    d = ImageDraw.Draw(f)

    # ── マント(背後・紺/右下に流れる) ──
    d.polygon([(16, 17), (30, 18), (34, 44), (24, 47), (12, 45), (14, 26)], fill=NB)
    d.polygon([(24, 19), (32, 22), (34, 44), (26, 46)], fill=ND)   # 影側
    for fy in (28, 34, 40):                                         # 布のひだ
        d.line((16, fy, 32, fy + 1), fill=ND)

    # ── 剣(右上11時に掲げる・鋼) ──
    d.polygon([(34, 4), (37, 5), (33, 24), (31, 23)], fill=TB)      # 刀身
    d.polygon([(34, 4), (35, 5), (32, 23), (31, 23)], fill=TL)      # 刃の光
    d.line((33, 8, 34, 20), fill=TD)                                # 血溝
    d.rectangle((29, 22, 38, 24), fill=GB)                          # 鍔(金)
    d.rectangle((29, 22, 38, 24), fill=GL); d.line((29, 24, 38, 24), fill=GD)

    # ── 脚(右足前・黄金鎧) ──
    d.rectangle((18, 37, 23, 47), fill=GB); d.rectangle((18, 37, 20, 47), fill=GL)  # 左脚
    d.rectangle((24, 36, 29, 46), fill=GB); d.rectangle((24, 36, 26, 46), fill=GL)  # 右脚(前)
    for lx in (18, 24):                                             # 膝当て
        d.ellipse((lx - 1, 40, lx + 4, 44), fill=GD)
    d.rectangle((17, 46, 24, 48), fill=GD); d.rectangle((23, 45, 30, 47), fill=GD)  # 具足

    # ── 胴(黄金鎧・逆三角) ──
    d.polygon([(15, 23), (31, 23), (29, 38), (17, 38)], fill=GB)
    d.polygon([(23, 23), (31, 23), (29, 38), (23, 38)], fill=GD)    # 右半身影
    d.rectangle((20, 25, 26, 36), fill=GL)                          # 胸板の光
    d.line((18, 31, 28, 32), fill=GD)                               # 腹のプレート段
    # 胸紋章(盾形・金銀)
    d.polygon([(21, 26), (25, 26), (25, 30), (23, 32), (21, 30)], fill=GH)
    d.polygon([(23, 26), (25, 26), (25, 30), (23, 32)], fill=TL)

    # ── 肩アーマー(右が大きい=非対称) ──
    d.ellipse((10, 19, 18, 26), fill=GB); d.ellipse((10, 19, 15, 24), fill=GL)   # 左肩
    d.ellipse((27, 17, 37, 26), fill=GB); d.ellipse((27, 17, 33, 24), fill=GL)   # 右肩(大)
    d.point((31, 20), fill=GH)

    # ── 右腕(剣を掲げる・上へ) ──
    d.polygon([(31, 20), (35, 21), (33, 8), (30, 9)], fill=GB)
    d.polygon([(31, 20), (32, 20), (31, 10), (30, 9)], fill=GL)
    d.ellipse((30, 6, 36, 12), fill=GD)                            # こぶし(籠手)

    # ── 左腕＋盾(下に引く) ──
    d.rectangle((11, 24, 15, 34), fill=GB); d.rectangle((11, 24, 13, 34), fill=GL)
    d.ellipse((6, 28, 16, 40), fill=TB)                            # 盾(鋼)
    d.ellipse((7, 29, 15, 39), fill=TD)
    d.ellipse((9, 31, 13, 36), fill=GL)                            # 盾の金ボス
    d.line((11, 28, 11, 40), fill=TL); d.line((6, 34, 16, 34), fill=TL)  # 十字

    # ── 兜(ビショップ型・前立て) ──
    d.ellipse((16, 6, 28, 19), fill=GB)                            # 兜
    d.ellipse((16, 12, 27, 19), fill=GD)                           # 面頬の影
    d.ellipse((17, 6, 26, 13), fill=GL)                            # 兜の光
    d.rectangle((18, 13, 26, 15), fill=OUT)                        # バイザーの隙間
    # 前立て(羽根・右に靡く=非対称)
    for sx, h in [(21, 2), (23, -1), (25, 1)]:
        d.polygon([(sx, 7), (sx + 4, h), (sx + 2, 8)], fill=RED)
    # 前立てのコイン紋章(お金の刻印)
    d.ellipse((20, 8, 24, 12), fill=GH); d.ellipse((21, 9, 23, 11), fill=GD)

    img = outline(f)
    dd = ImageDraw.Draw(img)
    # ── バイザー越しの横長細目＋鋭い眉 ──
    dd.line((19, 14, 22, 14), fill=EYE); dd.line((24, 14, 26, 14), fill=EYE)
    dd.point((20, 14), fill=W); dd.point((25, 14), fill=W)
    dd.line((18, 12, 22, 13), fill=OUT)                            # 左眉(逆ハの字)
    dd.line((23, 13, 27, 12), fill=OUT)                            # 右眉
    return img


if __name__ == "__main__":
    os.makedirs("/tmp/spike", exist_ok=True)
    img = draw().resize((G * SCALE, G * SCALE), Image.NEAREST)
    pad = 20
    sheet = Image.new("RGBA", (G * SCALE + pad * 2, G * SCALE + pad * 2 + 24), (40, 42, 48, 255))
    sheet.alpha_composite(img, (pad, pad))
    ImageDraw.Draw(sheet).text((pad, G * SCALE + pad + 6), "Gold Paladin - humanoid (k-line, cool, rare)", fill=(220, 210, 180))
    sheet.save("/tmp/spike/paladin.png")
    print("paladin -> /tmp/spike/paladin.png")
