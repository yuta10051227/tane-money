#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Tane Money モンスター・ドット絵ジェネレーター（32x32・パーツ合成方式 v2）
--------------------------------------------------------------------
既存スプライトと同じ 32x32 論理グリッド（1ドット=4px / 出力128x128）で、
丸いチビ精霊をパーツ合成で生成する。段階が上がるほど大型化＋角/ヒレ/冠などで強そうに。

spec キー:
  body, light, belly, accent : 色 (RGBA)
  r                : 体の半径(7=赤ちゃん 〜 10=最終形)
  crest            : 頭の飾り "drop"/"dish"/"horns"/"crown"/"none"
  wings            : True で横ヒレ
  tentacles        : True で足を触手(4本)に
  whisker          : True でヒゲ(accent)
  fierce           : True で吊り目(強そう)

使い方:  python3 scripts/gen_monsters.py            # MONSTERS 全部
         python3 scripts/gen_monsters.py 1c 4c2     # 指定IDだけ
         python3 scripts/gen_monsters.py --sheet    # 一覧プレビューを/tmpに出力
"""
import os, sys
from PIL import Image, ImageDraw

G = 32
SCALE = 4
OUTLINE = (20, 20, 20, 255)
WHITE   = (255, 255, 255, 255)

def OE(d, box, fill, t=1):
    x0, y0, x1, y1 = box
    d.ellipse((x0 - t, y0 - t, x1 + t, y1 + t), fill=OUTLINE)
    d.ellipse(box, fill=fill)

def draw_creature(s, bob=0):
    img = Image.new("RGBA", (G, G), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx = 16; oy = bob
    body = s["body"]; light = s["light"]; belly = s.get("belly", WHITE); accent = s["accent"]
    r = s.get("r", 9)
    cy = 30 - r                      # 体の中心y（下端をそろえる）
    top = cy - r                     # 体の上端

    # --- 横ヒレ/ツバサ ---
    if s.get("wings"):
        for sgn in (-1, 1):
            bx = cx + sgn * (r - 1)
            pts = [(bx, cy - 2 + oy), (bx + sgn * 6, cy - 5 + oy), (bx + sgn * 5, cy + 3 + oy)]
            d.polygon(pts, fill=OUTLINE)
            pts2 = [(bx, cy - 2 + oy), (bx + sgn * 5, cy - 4 + oy), (bx + sgn * 4, cy + 2 + oy)]
            d.polygon(pts2, fill=light)

    # --- 頭の飾り ---
    cr = s.get("crest", "drop")
    if cr == "drop":
        cc = s.get("accent2", light)
        d.polygon([(cx, top - 7 + oy), (cx - 4, top + 0 + oy), (cx + 4, top + 0 + oy)], fill=OUTLINE)
        OE(d, (cx - 4, top - 3 + oy, cx + 4, top + 3 + oy), cc)
        d.ellipse((cx - 2, top - 1 + oy, cx, top + 1 + oy), fill=WHITE)
    elif cr == "dish":            # 河童の皿
        OE(d, (cx - 5, top - 3 + oy, cx + 5, top + 2 + oy), s.get("accent2", (180, 230, 200, 255)))
    elif cr == "horns":          # 角
        for sgn in (-1, 1):
            d.polygon([(cx + sgn * 3, top + 1 + oy), (cx + sgn * 7, top - 6 + oy), (cx + sgn * 5, top + 2 + oy)], fill=OUTLINE)
            d.polygon([(cx + sgn * 4, top + 1 + oy), (cx + sgn * 6, top - 4 + oy), (cx + sgn * 5, top + 1 + oy)], fill=accent)
    elif cr == "crown":          # 王冠
        for dx in (-5, 0, 5):
            d.polygon([(cx + dx - 2, top + 1 + oy), (cx + dx, top - 5 + oy), (cx + dx + 2, top + 1 + oy)], fill=OUTLINE)
        d.rectangle((cx - 6, top - 1 + oy, cx + 6, top + 2 + oy), fill=accent)
        for dx in (-5, 0, 5):
            d.point((cx + dx, top - 3 + oy), fill=WHITE)

    # --- 触手 or 足 ---
    if s.get("tentacles"):
        for fx in (cx - 7, cx - 3, cx + 1, cx + 5):
            OE(d, (fx, cy + r - 3 + oy, fx + 2, cy + r + 2 + oy), body)
    else:
        for fx in (cx - r + 2, cx + r - 4):
            OE(d, (fx, cy + r - 3 + oy, fx + 2, cy + r + 0 + oy), body)

    # --- 体 ---
    OE(d, (cx - r, cy - r + oy, cx + r, cy + r + oy), body)
    d.ellipse((cx - r + 3, cy + 1 + oy, cx + r - 3, cy + r - 1 + oy), fill=light)      # 下を明るく
    d.ellipse((cx - (r - 4), cy + 0 + oy, cx + (r - 4), cy + r - 1 + oy), fill=belly)  # おなか

    # --- ヒゲ ---
    if s.get("whisker"):
        for sgn in (-1, 1):
            d.line((cx + sgn * (r - 2), cy + oy, cx + sgn * (r + 3), cy - 2 + oy), fill=accent)

    # --- 目 ---
    ey = cy - 3
    for ex in (cx - 4, cx + 4):
        d.ellipse((ex - 2, ey - 2 + oy, ex + 2, ey + 2 + oy), fill=WHITE)
        d.ellipse((ex - 1, ey - 1 + oy, ex + 1, ey + 1 + oy), fill=OUTLINE)
        img.putpixel((ex, ey - 1 + oy), WHITE)
        if s.get("fierce"):        # 吊り目の上まぶた
            d.line((ex - 2, ey - 2 + oy, ex + 2, ey - 1 + oy), fill=OUTLINE)
            d.line((ex - 2, ey - 1 + oy, ex + 2, ey + 0 + oy), fill=OUTLINE)

    # --- ほっぺ ---
    d.point((cx - r + 1, cy + 0 + oy), fill=accent)
    d.point((cx + r - 1, cy + 0 + oy), fill=accent)
    return img

# 水パレット
BLU  = (52, 120, 212, 255); LBLU = (120, 190, 245, 255)
TEAL = (30, 110, 130, 255); LTEAL= (90, 180, 190, 255)
NAVY = (28, 70, 130, 255);  LNAV = (70, 120, 190, 255)
GRN  = (60, 160, 120, 255); LGRN = (150, 220, 180, 255)
PUR  = (90, 90, 180, 255);  LPUR = (150, 150, 230, 255)
GOLD = (232, 184, 62, 255)

MONSTERS = {
    # 水ライン（新設）
    "1c":  dict(body=BLU,  light=LBLU,  accent=GOLD, r=7,  crest="drop"),
    "2c1": dict(body=GRN,  light=LGRN,  accent=(220,90,90,255), r=8, crest="dish"),                 # 河童
    "2c2": dict(body=TEAL, light=LTEAL, accent=GOLD, r=8,  crest="drop", wings=True, fierce=True),  # 大海蛇
    "3c1": dict(body=NAVY, light=LNAV,  accent=GOLD, r=9,  crest="horns", wings=True, fierce=True),  # リヴァイアサン
    "3c2": dict(body=PUR,  light=LPUR,  accent=GOLD, r=9,  crest="drop", tentacles=True, fierce=True),# クラーケン
    "4c1": dict(body=BLU,  light=LBLU,  accent=GOLD, r=10, crest="crown", wings=True, fierce=True),   # ポセイドン
    "4c2": dict(body=NAVY, light=LNAV,  accent=GOLD, r=10, crest="horns", whisker=True, wings=True, fierce=True), # 龍神
    # サンプル
    "mizuryu": dict(body=BLU, light=LBLU, accent=GOLD, r=8, crest="drop"),
}

def render(spec, path, bob=0):
    draw_creature(spec, bob).resize((G*SCALE, G*SCALE), Image.NEAREST).save(path)

def sheet():
    ids = ["1c","2c1","2c2","3c1","3c2","4c1","4c2"]
    sh = Image.new("RGBA", (128*len(ids), 140), (240,240,240,255))
    for i,mid in enumerate(ids):
        sp = draw_creature(MONSTERS[mid]).resize((128,128), Image.NEAREST)
        sh.paste(sp, (i*128, 6), sp)
    sh.save("/tmp/water_sheet.png"); print("sheet -> /tmp/water_sheet.png")

def main():
    if "--sheet" in sys.argv:
        sheet(); return
    os.makedirs("assets", exist_ok=True)
    targets = [a for a in sys.argv[1:] if not a.startswith("-")] or list(MONSTERS.keys())
    for mid in targets:
        if mid not in MONSTERS: print(f"skip {mid}"); continue
        render(MONSTERS[mid], f"assets/monster_{mid}_f0.png", 0)
        render(MONSTERS[mid], f"assets/monster_{mid}_f1.png", 1)
        print(f"generated monster_{mid}")

if __name__ == "__main__":
    main()
