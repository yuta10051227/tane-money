#!/usr/bin/env python3
# ユーザー自作のスライム・アート(マゼンタ背景・横3コマ)を取り込み、
# 背景透過→3コマ分割→320x320中央寄せ(接地そろえ)で assets/monster_<id>_f*.png に書き出す。
import os, numpy as np
from PIL import Image

UP = "/root/.claude/uploads/5e0b2bd8-409a-56fc-8b2f-46badf680226"
OUT = os.path.join(os.path.dirname(__file__), "..", "assets")
CANVAS = 320
BASE_Y = 300        # 接地ライン(下20pxは影マージン)
BOX = 296           # 収める最大の箱(幅・高さ)

# 画像ファイル → ステージID（オリジナルのスライムのみ。人型(リムル複製)は対象外）
JOBS = [
    ("2271910a-56E15F03643743C4B3AD15C68D00BF4B", "srimu_egg"),
    ("a595dd7e-E54FEBBACD0B46F0B6D9AA819AD03901", "srimu1"),
    ("278c9176-A90E5567D176424D8B1D38059ADA815E", "srimu2"),
    ("cf7cd0de-0439B174D7244A22AF65594888B72D42", "srimu3"),
    ("8403b011-AA9A5D750C49447193C2947EE79D22CD", "srimu4"),
]

def key_magenta(im):
    """マゼンタ背景を透過。返り値: RGBA np配列"""
    arr = np.array(im.convert("RGB")).astype(int)
    r, g, b = arr[..., 0], arr[..., 1], arr[..., 2]
    mag = (r > 165) & (b > 165) & (g < 105) & ((r - g) > 80) & ((b - g) > 80)
    alpha = np.where(mag, 0, 255).astype("uint8")
    return np.dstack([arr.astype("uint8"), alpha])

def bbox_of(a):
    ys, xs = np.where(a[..., 3] > 16)
    if len(xs) == 0:
        return None
    return xs.min(), ys.min(), xs.max() + 1, ys.max() + 1

def main():
    n = 0
    for fname, sid in JOBS:
        im = Image.open(os.path.join(UP, fname + ".png"))
        rgba = key_magenta(im)
        h, w, _ = rgba.shape
        fw = w // 3
        frames = [rgba[:, i * fw:(i + 1) * fw] for i in range(3)]
        boxes = [bbox_of(f) for f in frames]
        # 3コマ共通のスケール(最大の幅/高さ基準)＝コマ間でサイズが跳ねないように
        maxw = max(bx[2] - bx[0] for bx in boxes if bx)
        maxh = max(bx[3] - bx[1] for bx in boxes if bx)
        scale = min(BOX / maxw, BOX / maxh)
        out_imgs = []
        for f, bx in zip(frames, boxes):
            canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
            if bx:
                x0, y0, x1, y1 = bx
                crop = Image.fromarray(f[y0:y1, x0:x1], "RGBA")
                nw, nh = max(1, round((x1 - x0) * scale)), max(1, round((y1 - y0) * scale))
                crop = crop.resize((nw, nh), Image.NEAREST)
                px = (CANVAS - nw) // 2            # 横中央
                py = BASE_Y - nh                   # 下そろえ(接地)
                canvas.alpha_composite(crop, (px, max(0, py)))
            out_imgs.append(canvas)
        f0, f1, f2 = out_imgs
        f0.save(os.path.join(OUT, f"monster_{sid}_f0.png"))
        f1.save(os.path.join(OUT, f"monster_{sid}_f1.png"))
        f2.save(os.path.join(OUT, f"monster_{sid}_f2.png"))
        f0.save(os.path.join(OUT, f"monster_{sid}_f3.png"))        # 4コマ目=f0でループ
        f0.save(os.path.join(OUT, f"monster_{sid}_side_f0.png"))
        f1.save(os.path.join(OUT, f"monster_{sid}_side_f1.png"))
        n += 1
        print(f"{sid}: scale={scale:.2f} from {fname[:8]}")
    print(f"done: {n} stages")

if __name__ == "__main__":
    main()
