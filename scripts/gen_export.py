#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
完成した看板/cute(オリジナル)をアプリ用ゲームアセットに書き出す。
HIDDEN_MONSTERS(ひみつのなかま=スキン)用に front(f0/f1) + side(side_f0/side_f1) を生成。
f1は1論理px上にバウンドさせた簡易アニメ。sideは前向きを流用(v1)。
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from PIL import Image
import gen_legend, gen_metal, gen_paladin, gen_more

# id -> (描画関数, 論理サイズ)
SPRITES = {
    "ogon":   (gen_legend.draw,        48),   # オウゴンリュウ
    "gear":   (gen_metal.draw,         48),   # ギアドレイク
    "palad":  (gen_paladin.draw,       48),   # ゴルド・パラディン
    "garuda": (gen_more.draw_garuda,   48),   # テンガ・ガルダ
    "mameko": (gen_more.draw_mameko,   32),   # マメコ
}
FACTOR = 4   # 論理px -> 出力px


def export(mid, drawfn, gsize):
    base = drawfn().convert("RGBA")                     # 論理 gsize x gsize
    out = gsize * FACTOR
    f0 = base.resize((out, out), Image.NEAREST)
    # f1: 1論理px(=FACTOR px)上にバウンド
    f1 = Image.new("RGBA", (out, out), (0, 0, 0, 0))
    f1.alpha_composite(f0, (0, -FACTOR))
    for suffix, im in [("f0", f0), ("f1", f1), ("side_f0", f0), ("side_f1", f1)]:
        im.save(f"assets/monster_{mid}_{suffix}.png")
    print(f"exported {mid} ({out}x{out})")


if __name__ == "__main__":
    os.makedirs("assets", exist_ok=True)
    for mid, (fn, gs) in SPRITES.items():
        export(mid, fn, gs)
