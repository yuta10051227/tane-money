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
    # ── 隠しモンスター(マイルストーン解放) ──
    "niji":   dict(body=(214,64,150,255),  light=(96,206,232,255),  accent=GOLD,                r=10, crest="crown", wings=True, fierce=True),  # ニジドラゴン
    "kogane": dict(body=(232,184,62,255),  light=(255,232,150,255), accent=(255,255,255,255),   r=10, crest="crown", wings=True, fierce=True),  # コガネオウ
    "hoshi":  dict(body=(86,86,176,255),   light=(150,150,232,255), accent=GOLD,                r=10, crest="horns", wings=True, whisker=True, fierce=True),  # ホシリュウ
}
HIDDEN_IDS = ["niji", "kogane", "hoshi"]

def render(spec, path, bob=0):
    draw_creature(spec, bob).resize((G*SCALE, G*SCALE), Image.NEAREST).save(path)

# ════════════════════════════════════════════════════════════
# 横向き(側面)ビュー — デジモン風の歩く専用スプライト
# 既存15体は前向きPNGから主要色をサンプリングして色を合わせる
# ════════════════════════════════════════════════════════════
ALL_IDS = ["egg","1a","1b","1c","2a1","2a2","2b1","2b2","2c1","2c2",
           "3a1","3a2","3b1","3b2","3c1","3c2","4a1","4a2","4b1","4b2","4c1","4c2"]

def stage_of(mid):
    return 0 if mid == "egg" else int(mid[0])

def lighten(c, f=0.4):
    return tuple([min(255, int(c[i] + (255 - c[i]) * f)) for i in range(3)] + [255])

def sample_colors(mid):
    """前向きPNGから本体色を推定（外枠/白おなか/透明を除外して最頻色）"""
    import collections
    p = f"assets/monster_{mid}_f0.png"
    if not os.path.exists(p):
        return (90, 140, 200, 255)
    im = Image.open(p).convert("RGBA"); w, h = im.size; px = im.load()
    cnt = collections.Counter()
    for y in range(0, h, 4):
        for x in range(0, w, 4):
            c = px[x, y]
            if c[3] < 200: continue
            if max(c[:3]) < 45: continue          # 外枠(黒)を除外
            if min(c[:3]) > 225: continue         # 白(おなか/光)を除外
            cnt[c] += 1
    if not cnt:
        return (90, 140, 200, 255)
    return cnt.most_common(1)[0][0]

def build_side_spec(mid):
    """側面用スペック。水系/サンプルは定義済みパレット、他は色サンプリング"""
    st = stage_of(mid)
    r = {0: 7, 1: 7, 2: 8, 3: 9, 4: 10}[st]
    if mid in MONSTERS:
        base = dict(MONSTERS[mid]); base["r"] = r
        return base
    body = sample_colors(mid)
    spec = dict(body=body, light=lighten(body, 0.4), accent=GOLD, r=r)
    spec["wings"]  = st >= 3
    spec["horns"]  = st >= 4
    spec["fierce"] = st >= 3
    return spec

def draw_side(s, frame=0):
    """右向きの歩く側面チビ。frameで足を交互に動かす"""
    img = Image.new("RGBA", (G, G), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    body = s["body"]; light = s["light"]; belly = s.get("belly", WHITE); accent = s["accent"]
    r = s.get("r", 8)
    cx = 15; cy = 29 - r

    # しっぽ(後ろ=左)
    d.polygon([(cx - r + 1, cy), (cx - r - 5, cy - 4), (cx - r - 4, cy + 3)], fill=OUTLINE)
    d.polygon([(cx - r + 1, cy), (cx - r - 4, cy - 3), (cx - r - 3, cy + 2)], fill=body)

    # ツバサ/ヒレ(背中=上後ろ)
    if s.get("wings"):
        d.polygon([(cx - 2, cy - r + 2), (cx - 9, cy - r - 3), (cx - 8, cy + 1)], fill=OUTLINE)
        d.polygon([(cx - 3, cy - r + 2), (cx - 8, cy - r - 1), (cx - 7, cy + 0)], fill=light)

    # 足(2本・歩行で前後)
    sw = 2 if frame == 0 else -2
    for fx, dx in ((cx - 3, -sw), (cx + 3, sw)):
        OE(d, (fx + dx, cy + r - 3, fx + dx + 2, cy + r + 1), body)

    # 体
    OE(d, (cx - r, cy - r, cx + r, cy + r), body)
    d.ellipse((cx - r + 2, cy + 1, cx + r - 1, cy + r - 1), fill=light)        # 前下を明るく
    d.ellipse((cx + 0, cy + 1, cx + r - 1, cy + r - 1), fill=belly)            # おなか(前)

    # 角(頭の上=前寄り)
    if s.get("crest") == "horns" or s.get("horns"):
        for hx in (cx + 2, cx + r - 2):
            d.polygon([(hx, cy - r + 2), (hx + 2, cy - r - 4), (hx + 3, cy - r + 2)], fill=OUTLINE)
            d.polygon([(hx + 1, cy - r + 1), (hx + 2, cy - r - 2), (hx + 2, cy - r + 1)], fill=accent)
    elif s.get("crest") == "drop":
        d.polygon([(cx + 2, cy - r - 5), (cx - 1, cy - r + 1), (cx + 5, cy - r + 1)], fill=OUTLINE)
        OE(d, (cx + 0, cy - r - 2, cx + 5, cy - r + 3), s.get("accent2", light))
    elif s.get("crest") == "crown":
        for dx in (1, 4, 7):
            d.polygon([(cx + dx - 1, cy - r + 1), (cx + dx, cy - r - 4), (cx + dx + 1, cy - r + 1)], fill=OUTLINE)
        d.rectangle((cx + 0, cy - r - 1, cx + 8, cy - r + 1), fill=accent)

    # 鼻先(前=右に小さな出っぱり)
    d.ellipse((cx + r - 2, cy - 1, cx + r + 2, cy + 3), fill=body)
    d.ellipse((cx + r - 2, cy - 1, cx + r + 2, cy + 3), outline=OUTLINE)

    # 目(前寄り・1つ)
    ex, ey = cx + r - 4, cy - 3
    d.ellipse((ex - 1, ey - 1, ex + 3, ey + 3), fill=WHITE)
    d.ellipse((ex + 0, ey + 0, ex + 2, ey + 2), fill=OUTLINE)
    img.putpixel((ex + 1, ey + 0), WHITE)
    if s.get("fierce"):
        d.line((ex - 1, ey - 1, ex + 3, ey + 0), fill=OUTLINE)

    # ほっぺ
    d.point((cx + r - 2, cy + 2), fill=accent)
    return img

def render_side(spec, path, frame=0):
    draw_side(spec, frame).resize((G*SCALE, G*SCALE), Image.NEAREST).save(path)

def side_sheet():
    cols = 11; rows = 2
    sh = Image.new("RGBA", (96*cols, 110*rows + 8), (238,238,238,255))
    d = ImageDraw.Draw(sh)
    for i, mid in enumerate(ALL_IDS):
        sp = draw_side(build_side_spec(mid)).resize((96,96), Image.NEAREST)
        x = (i % cols) * 96; y = (i // cols) * 110 + 4
        sh.paste(sp, (x, y), sp)
        d.text((x + 2, y + 96), mid, fill=(40,40,40))
    sh.save("/tmp/side_sheet.png"); print("side sheet -> /tmp/side_sheet.png")

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
    if "--sidesheet" in sys.argv:
        side_sheet(); return
    os.makedirs("assets", exist_ok=True)
    if "--hidden" in sys.argv:                     # 隠しモンスター(前向き＋横向き)を生成
        for mid in HIDDEN_IDS:
            sp = MONSTERS[mid]
            render(sp, f"assets/monster_{mid}_f0.png", 0)
            render(sp, f"assets/monster_{mid}_f1.png", 1)
            render_side(sp, f"assets/monster_{mid}_side_f0.png", 0)
            render_side(sp, f"assets/monster_{mid}_side_f1.png", 1)
            print(f"generated hidden {mid} (front+side)")
        return
    if "--hiddensheet" in sys.argv:
        sh = Image.new("RGBA", (128*len(HIDDEN_IDS), 140), (238,238,238,255))
        for i,mid in enumerate(HIDDEN_IDS):
            sp = draw_creature(MONSTERS[mid]).resize((128,128), Image.NEAREST)
            sh.paste(sp, (i*128, 6), sp)
        sh.save("/tmp/hidden_sheet.png"); print("hidden sheet -> /tmp/hidden_sheet.png"); return
    if "--side" in sys.argv:                       # 全22体の横向きを生成
        for mid in ALL_IDS:
            sp = build_side_spec(mid)
            render_side(sp, f"assets/monster_{mid}_side_f0.png", 0)
            render_side(sp, f"assets/monster_{mid}_side_f1.png", 1)
            print(f"generated monster_{mid}_side")
        return
    targets = [a for a in sys.argv[1:] if not a.startswith("-")] or list(MONSTERS.keys())
    for mid in targets:
        if mid not in MONSTERS: print(f"skip {mid}"); continue
        render(MONSTERS[mid], f"assets/monster_{mid}_f0.png", 0)
        render(MONSTERS[mid], f"assets/monster_{mid}_f1.png", 1)
        print(f"generated monster_{mid}")

if __name__ == "__main__":
    main()
