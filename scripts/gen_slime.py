#!/usr/bin/env python3
# スラリル系統(隠し・転スラ風)の ピクセルアート スプライト生成。
# 320x320 RGBA。論理40x40を8倍NEARESTで描く=チャンキーかわいいピクセル風。
# 各ステージ: front f0..f3(ぴょこぴょこ4コマ) + side_f0,side_f1。
import os, math
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(__file__), "..", "assets")
S = 40            # 論理グリッド
SCALE = 8         # ×8 = 320
W = S * SCALE

def newimg():
    return Image.new("RGBA", (S, S), (0,0,0,0))

def up(im):
    return im.resize((W, W), Image.NEAREST)

def blob(d, cx, cy, rw, rh, col, line=None):
    d.ellipse([cx-rw, cy-rh, cx+rw, cy+rh], fill=col, outline=line)

def slime_body(d, cx, baseY, rw, rh, body, shade, hi, line):
    # スライムらしい「下がぷっくり・上がドーム」のブロブ
    top = baseY - 2*rh
    # 影(下)
    d.ellipse([cx-rw, top, cx+rw, baseY], fill=body, outline=line)
    d.ellipse([cx-rw, top+rh, cx+rw, baseY], fill=shade)
    d.ellipse([cx-rw, top, cx+rw, baseY-rh], fill=body)
    # ふちライン再描画
    d.ellipse([cx-rw, top, cx+rw, baseY], outline=line)
    # ハイライト(左上のつや)
    d.ellipse([cx-rw+2, top+1, cx-rw+2+int(rw*0.7), top+1+int(rh*0.7)], fill=hi)

def eyes(d, cx, cy, body_line, blink=False, dx=0, big=True, ew=None, eh=None, sp=None):
    if sp is None: sp = 5 if big else 4
    if ew is None: ew = 3 if big else 2
    if eh is None: eh = 4 if big else 3
    for sx in (-1, 1):
        ox = cx + sx*sp + dx
        if blink:
            d.line([ox-2, cy, ox+2, cy], fill=body_line, width=1)
        else:
            d.ellipse([ox-ew, cy-eh, ox+ew, cy+eh], fill=(20,28,60,255))
            d.ellipse([ox-ew, cy-eh, ox+ew-1, cy], fill=(255,255,255,255))  # きらきら上半分
            d.point((ox+1, cy+1), fill=(255,255,255,255))

def mouth(d, cx, cy, col=(30,40,80,255)):
    d.arc([cx-3, cy-2, cx+3, cy+3], 20, 160, fill=col)

def sparkle(d, x, y, col=(255,240,150,255), r=2):
    d.line([x-r, y, x+r, y], fill=col)
    d.line([x, y-r, x, y+r], fill=col)

def horns(d, cx, topY, col=(245,238,220,255), line=(120,110,90,255)):
    for sx in (-1,1):
        bx = cx + sx*6
        d.polygon([(bx, topY+3),(bx+sx*1, topY-4),(bx+sx*4, topY+1)], fill=col, outline=line)

def wings(d, cx, cy, col, line):
    for sx in (-1,1):
        bx = cx + sx*9
        d.polygon([(bx, cy),(bx+sx*9, cy-6),(bx+sx*8, cy+1),(bx+sx*10, cy+5),(bx+sx*5, cy+4)],
                  fill=col, outline=line)

def crown(d, cx, topY, col=(255,205,70,255), line=(180,130,20,255)):
    pts = [(cx-6, topY+3),(cx-6, topY-2),(cx-3, topY+1),(cx, topY-4),(cx+3, topY+1),(cx+6, topY-2),(cx+6, topY+3)]
    d.polygon(pts, fill=col, outline=line)
    for gx,gy in [(cx-6,topY-2),(cx,topY-4),(cx+6,topY-2)]:
        d.point((gx,gy), fill=(255,255,255,255))

def aura(d, cx, cy, r, col):
    for i,rr in enumerate(range(r, r-6, -2)):
        a = 40 + i*22
        d.ellipse([cx-rr, cy-rr, cx+rr, cy+rr], outline=col[:3]+(a,))

# ステージ定義: body/shade/hi/line + アクセサリflags
STAGES = {
 "srimu_egg": dict(kind="egg", body=(150,210,255,255), shade=(110,180,240,255), line=(70,120,190,255), hi=(235,250,255,255)),
 "srimu1":    dict(kind="slime", rw=10, rh=9,  body=(120,205,255,255), shade=(70,165,235,255), line=(40,110,185,255), hi=(240,252,255,255), eye=dict(ew=4,eh=5,sp=6)),
 "srimu2":    dict(kind="slime", rw=10, rh=8,  body=(110,200,255,255), shade=(60,160,230,255), line=(35,105,180,255), hi=(240,252,255,255), copy=True),
 "srimu3":    dict(kind="slime", rw=11, rh=9,  body=(105,195,255,255), shade=(55,155,225,255), line=(30,100,175,255), hi=(240,252,255,255), name=True, halo=True),
 "srimu4":    dict(kind="slime", rw=12, rh=9,  body=(95,210,225,255),  shade=(45,165,185,255), line=(25,110,135,255), hi=(235,255,255,255), horns=True, wings=True, storm=True),
 "srimu5":    dict(kind="mage",  body=(120,170,255,255), cloak=(60,80,170,255), cloakL=(35,50,120,255), hair=(220,228,245,255), line=(30,40,95,255)),
 "srimu_u":   dict(kind="king",  body=(150,180,255,255), shade=(95,130,235,255), line=(40,55,120,255), hi=(245,250,255,255), aura=(180,140,255,255)),
}

def draw(stage_id, frame=0, side=False):
    cfg = STAGES[stage_id]
    im = newimg(); d = ImageDraw.Draw(im, "RGBA")
    cx = 20
    sq = [0,1,0,-1][frame % 4]          # ぷにょ squash
    dx = 4 if side else 0
    kind = cfg["kind"]
    blink = (frame % 4 == 2)
    baseY = 31

    if kind == "egg":
        rw, rh = 11, 12   # まんまる寄りの ぷっくり卵
        wob = [0,-1,0,1][frame%4]
        top = baseY-2*rh
        d.ellipse([cx-rw, top+wob, cx+rw, baseY], fill=cfg["body"], outline=cfg["line"])
        d.ellipse([cx-rw, top+rh+wob, cx+rw, baseY], fill=cfg["shade"])
        d.ellipse([cx-rw, top+wob, cx+rw, baseY-rh], fill=cfg["body"])
        d.ellipse([cx-rw, top+wob, cx+rw, baseY], outline=cfg["line"])
        d.ellipse([cx-rw+2, top+2+wob, cx-2, top+2+rh+wob], fill=cfg["hi"])
        # 水玉
        for px,py in [(cx-3,baseY-7),(cx+3,baseY-12),(cx,baseY-4)]:
            d.ellipse([px-2,py-2,px+2,py+2], fill=(70,140,210,255))
        sparkle(d, cx+7, top+3, (255,255,255,255))
        return up(im)

    if kind == "mage":
        # 人型の魔人すがた(フードのローブ+スライム顔)
        # ローブ
        d.polygon([(cx-9,baseY),(cx+9,baseY),(cx+6,baseY-16),(cx-6,baseY-16)], fill=cfg["cloak"], outline=cfg["line"])
        d.polygon([(cx-9,baseY),(cx-2,baseY),(cx-5,baseY-16),(cx-6,baseY-16)], fill=cfg["cloakL"])
        # 顔(青いスライム肌)
        fy = baseY-18-sq
        d.ellipse([cx-6, fy-7, cx+6, fy+6], fill=cfg["body"], outline=cfg["line"])
        # 髪(銀のたれ前髪)
        d.polygon([(cx-6,fy-6),(cx+6,fy-6),(cx+6,fy-2),(cx+3,fy-4),(cx,fy-1),(cx-3,fy-4),(cx-6,fy-2)], fill=cfg["hair"], outline=cfg["line"])
        eyes(d, cx, fy, cfg["line"], blink=blink, dx=dx, big=True)
        mouth(d, cx, fy+3)
        sparkle(d, cx+10, fy-6, (200,220,255,255))
        return up(im)

    if kind == "king":
        # 竜魔王(究極体): オーラ+翼+ツノ+王冠
        cyb = baseY-2-sq
        aura(d, cx, cyb-6, 17, cfg["aura"])
        wings(d, cx, cyb-4, (120,90,200,255), (70,50,130,255))
        rw, rh = 12, 10
        slime_body(d, cx, baseY-sq, rw, rh, cfg["body"], cfg["shade"], cfg["hi"], cfg["line"])
        cyf = baseY-2*rh+rh-sq
        horns(d, cx, baseY-2*rh-sq, (255,230,140,255), (180,140,30,255))
        eyes(d, cx, cyf+1, cfg["line"], blink=blink, dx=dx, big=True)
        mouth(d, cx, cyf+5)
        crown(d, cx, baseY-2*rh-3-sq)
        for sx,sy in [(cx-15,cyb-8),(cx+15,cyb-10),(cx+13,cyb+6),(cx-13,cyb+4)]:
            sparkle(d, sx, sy, (255,240,160,255))
        return up(im)

    # 通常スライム系
    rw = cfg["rw"] + (1 if sq>0 else 0)
    rh = cfg["rh"] - (1 if sq>0 else 0) + (1 if sq<0 else 0)
    cyb = baseY - max(0,sq)
    if cfg.get("storm"):
        aura(d, cx, cyb-rh, rw+5, (140,230,255,255))
    if cfg.get("wings"):
        wings(d, cx, cyb-rh, (130,235,250,200), (40,150,180,255))
    slime_body(d, cx, cyb, rw, rh, cfg["body"], cfg["shade"], cfg["hi"], cfg["line"])
    cyf = cyb - rh   # 顔の中心
    if cfg.get("horns"):
        horns(d, cx, cyb-2*rh)
    eyes(d, cx, cyf, cfg["line"], blink=blink, dx=dx, big=True, **cfg.get("eye",{}))
    mouth(d, cx, cyf+4)
    if cfg.get("halo"):
        d.arc([cx-5, cyb-2*rh-4, cx+5, cyb-2*rh], 0, 180, fill=(255,235,150,255))
    if cfg.get("name"):
        d.rectangle([cx+rw-1, cyf-2, cx+rw+5, cyf+2], fill=(255,230,120,255), outline=(180,140,30,255))
    if cfg.get("copy"):
        sparkle(d, cx+rw+2, cyf-3, (255,255,255,255))
        sparkle(d, cx-rw-2, cyf+2, (180,230,255,255))
    if cfg.get("storm"):
        d.line([(cx+rw+1,cyf-6),(cx+rw+4,cyf-2),(cx+rw,cyf-1),(cx+rw+3,cyf+4)], fill=(255,245,140,255))
    return up(im)

def main():
    n = 0
    for sid in STAGES:
        for f in range(4):
            draw(sid, f, False).save(os.path.join(OUT, f"monster_{sid}_f{f}.png")); n+=1
        for f in range(2):
            draw(sid, f, True).save(os.path.join(OUT, f"monster_{sid}_side_f{f}.png")); n+=1
    print(f"generated {n} sprites for {len(STAGES)} stages")

if __name__ == "__main__":
    main()
