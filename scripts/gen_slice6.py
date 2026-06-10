#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
6フレーム版デザインシート(1122x1402)から FRAME1..6 を自動抽出し
assets/monster_mXX_f0..f5.png として保存する(白背景キーイング・360px中央配置)。
レイアウト: 上部=参照ポーズ(最大成分), 下部=2行x3列の6フレーム。
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from PIL import Image, ImageDraw
import gen_slice as gs   # label_components / key_bg / trim を再利用

UPDIR = gs.UPDIR
SHEETS = {  # tag -> mID
    "96660d5f-426F037F76FC44A3975C0947FEFD1479.png": "m01",
    "163889ee-3345F208AF9044D6A715A2AE3AFE166B.png": "m02",
    "56e2e726-7AAAE8B6AB044FEFBE611582036190E1.png": "m03",
    "a045e290-A6E2632E16CE466F8508D7307DA0F5F9.png": "m04",
    "72f996bd-0F927E0E5E254A258DEA09A5A8CB1DBE.png": "m05",
    "64e1100c-4162C1A282544EFC9536533EA6DB2AC2.png": "m06",
    "88f0b1d8-D11CADFDEB994B43B8D57068CBD68005.png": "m07",
    "6a0708af-DFD2AAB52ADB4619AC7E2B8A954B2FD4.png": "m08",
    "e24d5641-889C1E40C788470E86889DD178630861.png": "m09",
    "60f3917d-CBA92E608A174E51A4276B5135C8C66C.png": "m10",
}
CAN = 360


def center(im, can=CAN):
    c = Image.new("RGBA", (can, can), (0, 0, 0, 0))
    s = im.copy()
    if s.width > can or s.height > can:
        s.thumbnail((can, can), Image.LANCZOS)
    c.alpha_composite(s, ((can - s.width) // 2, (can - s.height) // 2))
    return c


def extract6(path):
    im = Image.open(path).convert("RGBA")
    W, H = im.size
    comps = [c for c in gs.label_components(im) if c[0] > 250]
    comps.sort(key=lambda c: -c[0])
    # スプライト候補: 正方形寄り・十分な高さ(ラベル文字/バッジ除外)
    sprites = []
    for (a, x0, y0, x1, y1) in comps:
        w, h = x1 - x0, y1 - y0
        if h < 130 or w < 110:
            continue
        if w / h > 2.1 or h / w > 2.1:
            continue
        sprites.append((a, x0, y0, x1, y1))
    if len(sprites) < 7:
        return None
    # 参照ポーズ=最も上にある大成分(タイトル直下)。残りから6個
    sprites.sort(key=lambda c: c[2])          # y0順
    hero = sprites[0]
    rest = [s for s in sprites[1:]]
    rest.sort(key=lambda c: -c[0])
    six = rest[:6]
    # 2行に分けて行内をx順
    six.sort(key=lambda c: (c[2] + c[4]) / 2)
    rows = [six[:3], six[3:]]
    for r in rows:
        r.sort(key=lambda c: (c[1] + c[3]) / 2)
    ordered = rows[0] + rows[1]
    outs = []
    for (a, x0, y0, x1, y1) in ordered:
        pad = 6
        crop = im.crop((max(0, x0 - pad), max(0, y0 - pad), min(W, x1 + pad), min(H, y1 + pad)))
        outs.append(gs.trim(gs.key_bg(crop)))
    return outs


if __name__ == "__main__":
    os.makedirs("/tmp/spike", exist_ok=True)
    results = []
    for fn, mid in sorted(SHEETS.items(), key=lambda kv: kv[1]):
        outs = extract6(os.path.join(UPDIR, fn))
        if not outs:
            print(mid, "FAIL"); continue
        for i, s in enumerate(outs):
            center(s).save(f"assets/monster_{mid}_f{i}.png")
        print(mid, "->", [s.size for s in outs])
        results.append((mid, outs))
    # 検証シート(マゼンタ地・6列)
    cw, rh = 96, 104
    sheet = Image.new("RGBA", (40 + cw * 6, rh * len(results) + 14), (255, 0, 255, 255))
    d = ImageDraw.Draw(sheet)
    for r, (mid, outs) in enumerate(results):
        d.text((2, 14 + r * rh + 40), mid, fill=(255, 255, 255))
        for c, s in enumerate(outs):
            t = s.copy(); t.thumbnail((cw - 10, rh - 10), Image.NEAREST)
            sheet.alpha_composite(t, (40 + c * cw + (cw - 10 - t.width) // 2, 14 + r * rh + (rh - 10 - t.height) // 2))
    for c in range(6):
        d.text((44 + c * cw, 2), f"f{c}", fill=(255, 255, 255))
    sheet.save("/tmp/spike/six_verify.png")
    print("verify -> /tmp/spike/six_verify.png")
