#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
デザインシート(1122x1402/不透明・白背景)から、下部の4スプライト(Front f0/f1,Side f0/f1)を
自動抽出し、白い市松背景を透明化する。連結成分でヒーロー(最大塊)とその下の4体を検出。
出力: /tmp/spike/out/<tag>_{0..3}.png (透過) と検証シート slice_verify.png(マゼンタ地)。
"""
import os, sys
from collections import deque
from PIL import Image

UPDIR = "/root/.claude/uploads/493bc81e-3c57-5389-a43e-4e95436477d3"
FILES = ["d920638d-C09B58AEA2B24BFBA9BD140D3F37A56E.png","f22cbac2-F876BA9E09BC4733BB2CA947925BE633.png",
"02636a75-6458B1FE4F1946838080C5F7CAB7BFD8.png","3e1c10f7-2FB98DD5506E4DEBB41C4090706DF0B4.png",
"df6d8406-A73A21702016496BB268978FCB73E840.png","2e996f11-1DC386F2B85F4361A4438F64F6B1825C.png",
"ff8c3019-1BCE5A83C2D54F3EBAF73F1476BC84A2.png","b4b05e25-56DCEF7A69134BADA986FC3962AEA294.png",
"35660b03-EEFD8CA04F1D4209B1F4BE8EBE922929.png","eea2a846-4A88EE6574A54983A7F7A5ADEEABEFC8.png"]
K = 4               # ダウンスケール係数(成分検出用)
BG = 235            # これ以上明るい(min channel)=白背景


def fg_at(px, x, y):
    r, g, b, a = px[x, y]
    return min(r, g, b) < BG


def label_components(im):
    """K分の1のマスクで連結成分。返り: list of (area, x0,y0,x1,y1) in FULL coords"""
    W, H = im.size
    sw, sh = W // K, H // K
    px = im.load()
    mask = bytearray(sw * sh)
    for sy in range(sh):
        for sx in range(sw):
            if fg_at(px, sx * K, sy * K):
                mask[sy * sw + sx] = 1
    seen = bytearray(sw * sh)
    comps = []
    for sy in range(sh):
        for sx in range(sw):
            i = sy * sw + sx
            if mask[i] and not seen[i]:
                q = deque([(sx, sy)]); seen[i] = 1
                x0 = x1 = sx; y0 = y1 = sy; area = 0
                while q:
                    cx, cy = q.popleft(); area += 1
                    if cx < x0: x0 = cx
                    if cx > x1: x1 = cx
                    if cy < y0: y0 = cy
                    if cy > y1: y1 = cy
                    for dx, dy in ((1,0),(-1,0),(0,1),(0,-1),(1,1),(1,-1),(-1,1),(-1,-1)):
                        nx, ny = cx + dx, cy + dy
                        if 0 <= nx < sw and 0 <= ny < sh:
                            j = ny * sw + nx
                            if mask[j] and not seen[j]:
                                seen[j] = 1; q.append((nx, ny))
                comps.append((area, x0*K, y0*K, (x1+1)*K, (y1+1)*K))
    return comps


def key_bg(crop):
    """縁から白背景を塗りつぶして透明化(内部の白は輪郭に守られ残る)"""
    crop = crop.convert("RGBA")
    w, h = crop.size; px = crop.load()
    seen = [[False]*w for _ in range(h)]
    q = deque()
    for x in range(w):
        for y in (0, h-1):
            q.append((x, y))
    for y in range(h):
        for x in (0, w-1):
            q.append((x, y))
    while q:
        x, y = q.popleft()
        if x < 0 or y < 0 or x >= w or y >= h or seen[y][x]:
            continue
        seen[y][x] = True
        r, g, b, a = px[x, y]
        if min(r, g, b) >= BG:                 # 白背景→透明にして伝播
            px[x, y] = (r, g, b, 0)
            for dx, dy in ((1,0),(-1,0),(0,1),(0,-1)):
                q.append((x+dx, y+dy))
    return crop


def trim(im):
    bb = im.split()[3].getbbox()
    return im.crop(bb) if bb else im


def extract(path):
    im = Image.open(path).convert("RGBA")
    W, H = im.size
    comps = label_components(im)
    # ノイズ除去(小さすぎ)
    big = [c for c in comps if c[0] > 200]
    if not big: return None, None
    big.sort(key=lambda c: -c[0])
    hero = big[0]
    hero_bottom = hero[4]
    # スプライト候補: 下部40%・十分大きく・ほぼ正方形(バッジ/ラベル/区切り線を除外)
    def ok(c):
        a, x0, y0, x1, y1 = c
        w, h = x1 - x0, y1 - y0
        if y0 < H * 0.58: return False          # 下部のみ
        if h < 150 or w < 120: return False      # 小さい/薄い帯を除外
        ar = w / h
        if ar < 0.55 or ar > 1.8: return False   # 横長バッジ(18×18等)を除外
        return True
    cands = [c for c in big if c is not hero and ok(c)]
    ycen = lambda c: (c[2] + c[4]) / 2
    xcen = lambda c: (c[1] + c[3]) / 2
    # 同一行(y中心が近い)の連続4つを選ぶ
    cands.sort(key=ycen)
    if len(cands) >= 4:
        best = None
        for i in range(len(cands) - 3):
            w4 = cands[i:i+4]
            spread = ycen(w4[-1]) - ycen(w4[0])
            if best is None or spread < best[0]: best = (spread, w4)
        sprites = best[1]
    else:
        sprites = cands
    sprites.sort(key=xcen)                           # x順
    outs=[]
    for (area,x0,y0,x1,y1) in sprites[:4]:
        pad=6
        c=im.crop((max(0,x0-pad),max(0,y0-pad),min(W,x1+pad),min(H,y1+pad)))
        outs.append(trim(key_bg(c)))
    # タイトル帯(ヒーロー下〜スプライト上)
    sp_top = min(c[2] for c in sprites) if sprites else H
    title = im.crop((40, hero_bottom, W-40, min(H, sp_top)))
    return outs, title


if __name__ == "__main__":
    os.makedirs("/tmp/spike/out", exist_ok=True)
    rows=[]
    for fn in FILES:
        tag=fn[:8]
        outs,title=extract(os.path.join(UPDIR,fn))
        if outs is None: print(tag,"FAIL"); continue
        for i,s in enumerate(outs):
            s.save(f"/tmp/spike/out/{tag}_{i}.png")
        print(tag, "->", len(outs), "sprites", [s.size for s in outs])
        rows.append((tag,outs,title))
    # 検証シート(マゼンタ地で透過確認)
    cellw=140; th=120
    sheet=Image.new("RGBA",(360+cellw*4, th*len(rows)),(255,0,255,255))
    from PIL import ImageDraw; d=ImageDraw.Draw(sheet)
    for r,(tag,outs,title) in enumerate(rows):
        y=r*th
        if title and title.width>2 and title.height>2:
            t=title.copy(); t.thumbnail((340,th-8),Image.LANCZOS)
            sheet.alpha_composite(t.convert("RGBA"),(4,y+4))
        for i,s in enumerate(outs):
            t=s.copy(); t.thumbnail((cellw-12,th-12),Image.NEAREST)
            sheet.alpha_composite(t,(360+i*cellw+6,y+6))
    sheet.save("/tmp/spike/slice_verify.png"); print("verify -> /tmp/spike/slice_verify.png", sheet.size)
