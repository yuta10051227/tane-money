#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Monster Growth Chart -> ゲーム用スプライト書き出し
============================================================
「Monster Growth Chart」(m01-m14 / 3系統) の各セル(Front f0/f1, Side f0/f1)を
自動検出してスライスし、背景透過・整列して assets/monster_mXX_*.png を生成する。

使い方:
  python3 scripts/slice_monsters.py /path/to/MonsterGrowthChart.png
  （省略時は ~/Downloads/monster_growth_chart.png を探す）

仕組み:
  - 行(Front/Side)は彩度の高い帯で自動検出（緑のモンスター=高彩度, 黒文字=低彩度で分離）
  - 列(f0/f1中心)は各行で「最も右の2クラスタ=f0/f1」（ラベル/イラストは除外, 究極体の融合は2分割）
  - セルごとに白背景をフラッドフィル除去→枠線/ラベルを連結成分フィルタで除去→下端基準で整列
依存: Pillow, numpy  (pip3 install --user Pillow numpy)
"""
import os, sys
from collections import deque
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "assets")
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/Downloads/monster_growth_chart.png")
if not os.path.exists(SRC):
    sys.exit(f"source chart not found: {SRC}\nusage: python3 scripts/slice_monsters.py <chart.png>")

im = Image.open(SRC).convert("RGB"); W, H = im.size
A = np.array(im).astype(int); SAT = A.max(2) - A.min(2); COL = SAT > 55

# 行(Front,Side)の y帯。※チャートを描き直した場合はここを実測して調整する
ROWS = {
 "baby1":(318,337,371,390), "baby2":(496,516,548,568),
 "growth":(693,714,743,763), "mature":(850,875,906,930),
 "perfect":(1015,1040,1077,1100), "ultimate":(1200,1241,1274,1334),
}
MON = {
 "m01":("L","baby1"),"m02":("L","baby2"),
 "m03":("L","growth"),"m07":("M","growth"),"m11":("R","growth"),
 "m04":("L","mature"),"m08":("M","mature"),"m12":("R","mature"),
 "m05":("L","perfect"),"m09":("M","perfect"),"m13":("R","perfect"),
 "m06":("L","ultimate"),"m10":("M","ultimate"),"m14":("R","ultimate"),
}
REGION = {"L":(90,440), "M":(440,752), "R":(752,1055)}

def xclusters(y0,y1,thr=0.16,minlen=10,gap=14):
    p=COL[y0:y1,:].mean(0); xs=np.where(p>thr)[0]; out=[]
    if len(xs)==0: return out
    s=q=xs[0]
    for x in xs[1:]:
        if x-q>gap:
            if q-s>=minlen: out.append((int(s),int(q)))
            s=x
        q=x
    if q-s>=minlen: out.append((int(s),int(q)))
    return out

def centers_for_row(fy0,fy1):
    cl=xclusters(fy0,fy1); res={}
    for col,(rx0,rx1) in REGION.items():
        cs=[c for c in cl if rx0<=(c[0]+c[1])//2<rx1 and (c[1]-c[0])<=100]
        if not cs: continue
        last=cs[-1]
        if last[1]-last[0]>=40:                       # f0/f1融合 -> 2分割
            res[col]=((last[0]*3+last[1])//4,(last[0]+last[1]*3)//4)
        elif len(cs)>=2:
            a=cs[-2]; res[col]=((a[0]+a[1])//2,(last[0]+last[1])//2)
        else:
            res[col]=((last[0]+last[1])//2,(last[0]+last[1])//2+50)
    return res

ROWX={r:centers_for_row(v[0],v[1]) for r,v in ROWS.items()}

def slice_cell(cx,y0,y1,halfw,pad=5):
    box=(max(0,cx-halfw),max(0,y0-pad),min(W,cx+halfw),min(H,y1+pad))
    a=np.array(im.crop(box).convert("RGBA")); h,w=a.shape[:2]
    near=(a[:,:,0]>=222)&(a[:,:,1]>=222)&(a[:,:,2]>=222)
    vis=np.zeros((h,w),bool); q=deque()
    for x in range(w):
        for y in (0,h-1):
            if near[y,x] and not vis[y,x]: vis[y,x]=True; q.append((y,x))
    for y in range(h):
        for x in (0,w-1):
            if near[y,x] and not vis[y,x]: vis[y,x]=True; q.append((y,x))
    while q:
        y,x=q.popleft(); a[y,x,3]=0
        for dy,dx in((-1,0),(1,0),(0,-1),(0,1)):
            ny,nx=y+dy,x+dx
            if 0<=ny<h and 0<=nx<w and not vis[ny,nx] and near[ny,nx]: vis[ny,nx]=True; q.append((ny,nx))
    sat=a[:,:,:3].max(2).astype(int)-a[:,:,:3].min(2).astype(int); op=a[:,:,3]>0; g=op&(sat<28)
    for x in range(w):
        if g[:,x].sum()>=0.7*h: a[:,x,3]=0
    for y in range(h):
        if g[y,:].sum()>=0.7*w: a[y,:,3]=0
    op=a[:,:,3]>0; lab=np.zeros((h,w),int); cur=0; comps={}
    for sy in range(h):
        for sx in range(w):
            if op[sy,sx] and lab[sy,sx]==0:
                cur+=1; cells=[]; dq=deque([(sy,sx)]); lab[sy,sx]=cur
                while dq:
                    y,x=dq.popleft(); cells.append((y,x))
                    for dy,dx in((-1,0),(1,0),(0,-1),(0,1),(-1,-1),(-1,1),(1,-1),(1,1)):
                        ny,nx=y+dy,x+dx
                        if 0<=ny<h and 0<=nx<w and op[ny,nx] and lab[ny,nx]==0: lab[ny,nx]=cur; dq.append((ny,nx))
                comps[cur]=cells
    if comps:
        bx0,bx1=int(w*0.30),int(w*0.70); keep=set()
        for cid,cells in comps.items():
            if any(bx0<=c[1]<=bx1 for c in cells) and len(cells)>=6: keep.add(cid)
        if not keep: keep={max(comps,key=lambda c:len(comps[c]))}
        for cid,cells in comps.items():
            if cid not in keep:
                for (y,x) in cells: a[y,x,3]=0
    al=a[:,:,3]>0
    if not al.any(): return None
    ys,xs=np.where(al); return Image.fromarray(a[ys.min():ys.max()+1, xs.min():xs.max()+1])

def finalize(sp,size=128,boxsz=112,base_margin=9):
    out=Image.new("RGBA",(size,size),(0,0,0,0))
    if sp is None: return out
    w,h=sp.size; f=max(1,min(boxsz//max(1,w),boxsz//max(1,h)))
    if f>1: sp=sp.resize((w*f,h*f),Image.NEAREST)
    w,h=sp.size; out.alpha_composite(sp,((size-w)//2, size-base_margin-h)); return out

os.makedirs(ASSETS, exist_ok=True); n=0
for mid,(col,row) in MON.items():
    fy0,fy1,sy0,sy1=ROWS[row]; f0,f1=ROWX[row][col]
    halfw=max(15,min(24,(abs(f1-f0)//2)-1)) if f1!=f0 else 22
    for view,(y0,y1) in (("",(fy0,fy1)),("side_",(sy0,sy1))):
        for frame,cx in (("f0",f0),("f1",f1)):
            finalize(slice_cell(cx,y0,y1,halfw)).save(os.path.join(ASSETS,f"monster_{mid}_{view}{frame}.png")); n+=1
print(f"done: {n} sprites -> {ASSETS}")
