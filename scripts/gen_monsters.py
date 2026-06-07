#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Tane Money モンスター・ドット絵ジェネレーター（32x32・パーツ合成方式）
--------------------------------------------------------------------
既存スプライトと同じ 32x32 論理グリッド（1ドット=4px / 出力128x128）で、
丸いチビ精霊キャラをパーツ（体・おなか・目・トサカ・足）から合成生成する。
パレットとトサカ形状を変えるだけで火/水/森…のバリエーションを量産できる。

使い方:  python3 scripts/gen_monsters.py            # MONSTERS 全部
         python3 scripts/gen_monsters.py mizuryu    # 指定IDだけ
出力:    assets/monster_<id>_f0.png / _f1.png
"""
import os, sys
from PIL import Image, ImageDraw

G = 32          # 論理グリッド
SCALE = 4       # 1ドット=4px -> 128x128
OUTLINE = (20, 20, 20, 255)
WHITE   = (255, 255, 255, 255)

# 各モンスター: パレット＋トサカ種別
MONSTERS = {
    # 新規サンプル: 水の精霊「みずりゅう」
    "mizuryu": dict(
        body=(52, 120, 212, 255), light=(120, 190, 245, 255),
        crest="drop", crest_col=(120, 190, 245, 255), accent=(232, 184, 62, 255),
    ),
}

def ellipse(d, box, fill):
    d.ellipse(box, fill=fill)

def outlined_ellipse(d, box, fill, outline=OUTLINE, t=1):
    x0, y0, x1, y1 = box
    d.ellipse((x0 - t, y0 - t, x1 + t, y1 + t), fill=outline)
    d.ellipse(box, fill=fill)

def draw_creature(spec, bob=0):
    img = Image.new("RGBA", (G, G), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx = 16
    oy = bob  # f1用の上下ゆれ

    body = spec["body"]; light = spec["light"]; accent = spec["accent"]

    # --- トサカ（頭の上の飾り） ---
    if spec["crest"] == "drop":  # 水のしずく
        cc = spec["crest_col"]
        # しずく形: 上が細く下が丸い
        d.polygon([(cx, 3 + oy), (cx - 4, 9 + oy), (cx + 4, 9 + oy)], fill=OUTLINE)
        outlined_ellipse(d, (cx - 4, 7 + oy, cx + 4, 13 + oy), cc)
        d.ellipse((cx - 2, 9 + oy, cx, 11 + oy), fill=WHITE)  # ハイライト

    # --- 体（丸） ---
    outlined_ellipse(d, (cx - 9, 11 + oy, cx + 9, 28 + oy), body)
    # 体の陰影（下半分を少し明るく）
    d.ellipse((cx - 6, 21 + oy, cx + 6, 27 + oy), fill=light)
    # おなか（白）
    d.ellipse((cx - 4, 20 + oy, cx + 4, 27 + oy), fill=WHITE)

    # --- 目 ---
    for ex in (cx - 4, cx + 4):
        d.ellipse((ex - 2, 15 + oy, ex + 2, 19 + oy), fill=WHITE)
        d.ellipse((ex - 1, 16 + oy, ex + 1, 18 + oy), fill=OUTLINE)
        img.putpixel((ex, 16 + oy), WHITE)  # 目の光

    # --- ほっぺ ---
    d.point((cx - 7, 19 + oy), fill=accent)
    d.point((cx + 7, 19 + oy), fill=accent)

    # --- 足 ---
    for fx in (cx - 5, cx + 3):
        outlined_ellipse(d, (fx, 27 + oy, fx + 2, 30 + oy), body)

    return img

def render(spec, path, bob=0):
    img = draw_creature(spec, bob=bob)
    img.resize((G * SCALE, G * SCALE), Image.NEAREST).save(path)

def main():
    out = "assets"
    os.makedirs(out, exist_ok=True)
    targets = sys.argv[1:] or list(MONSTERS.keys())
    for mid in targets:
        if mid not in MONSTERS:
            print(f"skip: {mid} (未定義)"); continue
        spec = MONSTERS[mid]
        render(spec, f"{out}/monster_{mid}_f0.png", bob=0)
        render(spec, f"{out}/monster_{mid}_f1.png", bob=1)  # 1ドット沈む呼吸アニメ
        print(f"generated: monster_{mid}_f0.png / _f1.png")

if __name__ == "__main__":
    main()
