#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
g系統「金竜ライン」全段階(オリジナル)。お金×成長×伝説を金で統一、かわいい→カッコいい。
maneta(卵)→sumi(幼I)→futaba(幼II)→koryu(成長/獣竜)→{grandrago(大地竜),soraryu(空竜)}→ogon(★5,別ファイル)
新品質バー準拠: 4トーン/色味のある輪郭/キャラ別の目/お金の刻印/左上光源。全て論理40x40で統一。
"""
import os, math
from PIL import Image, ImageDraw, ImageFilter, ImageChops

G = 40; SCALE = 6
OUT = (44, 34, 28, 255)        # 温かみのある暗色輪郭
W = (250, 248, 240, 255)
GD = (150, 100, 26, 255); GB = (214, 160, 42, 255); GL = (245, 206, 92, 255); GH = (255, 238, 172, 255)
ED = (96, 70, 42, 255);  EB = (146, 108, 64, 255); EL = (196, 160, 110, 255)   # 土
LF = (120, 190, 95, 255); LFD = (70, 150, 70, 255)
RKD = (92, 84, 78, 255); RKB = (140, 130, 120, 255)   # 岩
BLU = (90, 170, 240, 255); BLL = (170, 220, 255, 255) # 空
PINK = (240, 150, 160, 255)
EYE = (255, 210, 70, 255)


def outline(fill, col=OUT, t=1):
    a = fill.split()[3]
    ring = ImageChops.subtract(a.filter(ImageFilter.MaxFilter(2 * t + 1)), a)
    base = Image.new("RGBA", fill.size, (0, 0, 0, 0))
    base.paste(col, (0, 0), ring)
    base.alpha_composite(fill)
    return base


def cute_eye(d, ex, ey):
    d.ellipse((ex - 2, ey - 2, ex + 2, ey + 3), fill=W)
    d.ellipse((ex - 1, ey - 1, ex + 1, ey + 2), fill=OUT)
    d.point((ex, ey - 1), fill=W)


def fierce_eye(d, ex, ey, col=EYE):
    d.polygon([(ex - 2, ey - 1), (ex + 2, ey), (ex - 1, ey + 2)], fill=OUT)
    d.point((ex, ey), fill=col); d.point((ex - 1, ey), fill=W)
    d.line((ex - 2, ey - 2, ex + 2, ey - 1), fill=OUT)


def coin(d, cx, cy, r):
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=GH)
    d.ellipse((cx - r + 1, cy - r + 1, cx + r - 1, cy + r - 1), fill=GD)
    d.line((cx, cy - r + 1, cx, cy + r - 1), fill=GH)
    d.line((cx - r + 2, cy, cx + r - 2, cy), fill=GH)


# ───── 卵 マネタマ ─────
def m_maneta():
    f = Image.new("RGBA", (G, G), (0, 0, 0, 0)); d = ImageDraw.Draw(f)
    d.ellipse((12, 7, 28, 33), fill=(236, 228, 204, 255))
    d.ellipse((12, 19, 28, 33), fill=(206, 196, 168, 255))
    d.ellipse((13, 8, 24, 18), fill=(248, 242, 222, 255))     # 左上の光
    for p in [(12, 12), (15, 9), (18, 12), (21, 9), (25, 12), (28, 10)]:  # ヒビ
        d.point(p, fill=OUT)
    img = outline(f); dd = ImageDraw.Draw(img)
    coin(dd, 20, 20, 4)
    return img


# ───── 幼I スミっち(土の芽) ─────
def m_sumi():
    f = Image.new("RGBA", (G, G), (0, 0, 0, 0)); d = ImageDraw.Draw(f)
    d.rectangle((19, 11, 20, 18), fill=LFD)                    # 茎
    d.polygon([(20, 12), (26, 9), (22, 16)], fill=LF)          # 葉
    coin_leaf = True
    d.ellipse((13, 17, 27, 31), fill=EB)                       # 体
    d.ellipse((13, 17, 22, 27), fill=EL)                       # 左上光
    d.ellipse((15, 24, 25, 32), fill=ED)                       # 下影
    d.ellipse((14, 18, 26, 30), fill=EB)
    for fx in (15, 22):                                        # ちび足
        d.ellipse((fx, 29, fx + 3, 32), fill=ED)
    img = outline(f); dd = ImageDraw.Draw(img)
    cute_eye(dd, 18, 23); cute_eye(dd, 23, 23)
    dd.point((15, 26), fill=PINK); dd.point((16, 26), fill=PINK)
    dd.point((25, 26), fill=PINK); dd.point((26, 26), fill=PINK)
    dd.arc((19, 25, 22, 28), 20, 160, fill=OUT)
    coin(dd, 23, 9, 2)                                         # 葉先の小判
    return img


# ───── 幼II フタバ(双葉) ─────
def m_futaba():
    f = Image.new("RGBA", (G, G), (0, 0, 0, 0)); d = ImageDraw.Draw(f)
    for sgn in (-1, 1):                                        # 双葉
        d.polygon([(20, 11), (20 + sgn * 9, 5), (20 + sgn * 10, 12), (20, 14)], fill=LF)
        d.line((20, 12, 20 + sgn * 8, 7), fill=GL)             # 金の葉脈
    d.ellipse((12, 13, 28, 32), fill=EL)
    d.ellipse((12, 13, 22, 25), fill=(220, 196, 150, 255))
    d.ellipse((14, 22, 26, 33), fill=EB)
    d.ellipse((13, 14, 27, 31), fill=EL)
    for fx in (16, 21):
        d.ellipse((fx, 30, fx + 3, 33), fill=ED)
    img = outline(f); dd = ImageDraw.Draw(img)
    cute_eye(dd, 17, 20); cute_eye(dd, 23, 20)
    dd.point((14, 23), fill=PINK); dd.point((15, 23), fill=PINK)
    dd.point((25, 23), fill=PINK); dd.point((26, 23), fill=PINK)
    dd.arc((18, 22, 22, 26), 20, 160, fill=OUT)
    return img


# ───── 成長 コリュウ(獣竜) ─────
def m_koryu():
    f = Image.new("RGBA", (G, G), (0, 0, 0, 0)); d = ImageDraw.Draw(f)
    d.polygon([(26, 24), (34, 28), (30, 21)], fill=GD)         # しっぽ
    d.ellipse((12, 17, 30, 33), fill=GB)                       # 胴
    d.ellipse((12, 17, 23, 28), fill=GD)
    d.ellipse((14, 24, 28, 33), fill=GL)                       # 腹
    d.ellipse((5, 11, 17, 23), fill=GB)                        # 頭(左)
    d.ellipse((5, 16, 15, 23), fill=GD)
    d.polygon([(5, 16), (0, 17), (6, 19)], fill=GB)            # 口先
    for sgn, bx in ((-1, 8), (1, 12)):                         # 小角
        d.polygon([(bx, 11), (bx + sgn, 6), (bx + sgn * 2, 11)], fill=GL)
    for fx in (14, 22):                                        # 足+爪
        d.rectangle((fx, 31, fx + 3, 34), fill=GD)
        d.polygon([(fx - 1, 34), (fx, 31), (fx + 1, 34)], fill=W)
    for sx, sy in [(18, 22), (22, 25), (16, 26), (24, 21)]:    # 小判のうろこ
        d.point((sx, sy), fill=GL)
    img = outline(f); dd = ImageDraw.Draw(img)
    fierce_eye(dd, 9, 15); fierce_eye(dd, 13, 15)
    return img


# ───── 成熟 グランドラゴ(大地竜) ─────
def m_grandrago():
    f = Image.new("RGBA", (G, G), (0, 0, 0, 0)); d = ImageDraw.Draw(f)
    d.polygon([(28, 30), (39, 36), (33, 26)], fill=GD)         # しっぽ
    # 背の岩稜
    for bx in range(12, 28, 4):
        d.polygon([(bx, 16), (bx + 2, 8), (bx + 5, 17)], fill=RKB)
        d.polygon([(bx + 1, 14), (bx + 2, 9), (bx + 3, 14)], fill=RKD)
    d.ellipse((10, 16, 34, 38), fill=GB)                       # 胴(大)
    d.ellipse((10, 16, 26, 32), fill=GD)
    d.ellipse((13, 26, 31, 38), fill=GL)                       # 腹
    d.ellipse((3, 11, 18, 26), fill=GB)                        # 頭
    d.ellipse((3, 18, 16, 26), fill=GD)
    d.polygon([(3, 18), (-2, 20), (5, 22)], fill=GB)
    for sgn, bx in ((-1, 7), (1, 13)):                         # 角(岩)
        d.polygon([(bx, 11), (bx + sgn * 2, 4), (bx + sgn * 3, 11)], fill=RKB)
    for fx in (13, 25):                                        # 太い足
        d.rectangle((fx, 35, fx + 4, 39), fill=GD)
        for cx in range(fx, fx + 5, 2):
            d.point((cx, 39), fill=W)
    coin(d, 22, 30, 3)                                         # 腹の小判
    img = outline(f); dd = ImageDraw.Draw(img)
    fierce_eye(dd, 7, 16); fierce_eye(dd, 12, 16)
    dd.line((5, 13, 14, 15), fill=OUT)
    return img


# ───── 成熟 ソラリュウ(空竜) ─────
def m_soraryu():
    f = Image.new("RGBA", (G, G), (0, 0, 0, 0)); d = ImageDraw.Draw(f)
    # 大翼(金貨の膜) 右上
    d.polygon([(22, 16), (39, 4), (37, 12), (39, 17), (33, 16), (35, 24), (27, 19)], fill=GL)
    d.polygon([(24, 16), (36, 7), (35, 13), (25, 18)], fill=GB)
    for tip in [(39, 4), (39, 17), (35, 24)]:
        d.line((23, 16) + tip, fill=GD)
    coin(d, 33, 11, 2)                                         # 翼の小判
    d.polygon([(24, 28), (34, 37), (36, 31)], fill=GB)         # しっぽ
    d.ellipse((14, 18, 30, 36), fill=GB)                       # 胴
    d.ellipse((14, 18, 25, 30), fill=GD)
    d.ellipse((16, 26, 28, 36), fill=GL)
    # 長い首→頭(左上)
    d.polygon([(11, 30), (8, 14), (17, 13), (18, 28)], fill=GB)
    d.ellipse((4, 8, 16, 19), fill=GB); d.ellipse((4, 13, 14, 19), fill=GD)
    d.polygon([(4, 13), (-1, 14), (5, 16)], fill=GB)
    for sgn, bx in ((-1, 7), (1, 11)):
        d.polygon([(bx, 8), (bx + sgn, 3), (bx + sgn * 2, 8)], fill=GL)
    for fx in (16, 22):
        d.rectangle((fx, 34, fx + 2, 37), fill=GD)
    img = outline(f); dd = ImageDraw.Draw(img)
    fierce_eye(dd, 8, 12); fierce_eye(dd, 12, 12)
    return img


LINE = [("maneta", m_maneta, "マネタマ/卵"), ("sumi", m_sumi, "スミっち/幼I"),
        ("futaba", m_futaba, "フタバ/幼II"), ("koryu", m_koryu, "コリュウ/成長"),
        ("grandrago", m_grandrago, "グランドラゴ/成熟"), ("soraryu", m_soraryu, "ソラリュウ/成熟")]

if __name__ == "__main__":
    os.makedirs("/tmp/spike", exist_ok=True)
    cell = G * SCALE
    sheet = Image.new("RGBA", (cell * len(LINE), cell + 28), (238, 236, 232, 255))
    sd = ImageDraw.Draw(sheet)
    for i, (mid, fn, lbl) in enumerate(LINE):
        sheet.alpha_composite(fn().resize((cell, cell), Image.NEAREST), (i * cell, 0))
        sd.text((i * cell + 6, cell + 9), lbl, fill=(40, 40, 40))
    sheet.save("/tmp/spike/gline.png")
    print("gline -> /tmp/spike/gline.png")
