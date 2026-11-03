from PIL import Image
import numpy as np
BASE = Image.open('/home/hatch/workspace/rangmanch-ar/assets/packs/swapnil/talk/base.png').convert('RGBA')
W,H = BASE.size
arr = np.array(BASE).astype(np.float32)
NL, FH = 351, 14
head = arr.copy()
yy = np.arange(H)[:,None].repeat(W, axis=1)
f = np.clip((NL+FH-yy)/(2*FH), 0, 1)
head[:,:,3] = head[:,:,3]*f
head_img = Image.fromarray(head.astype(np.uint8)).crop((120,0,630,392))
er = arr.copy(); snap = arr.copy()
for y in range(0, NL+FH):
    ff = np.clip((NL+FH-y)/(2*FH), 0, 1)
    if ff<=0.02: continue
    for x in range(W):
        px = snap[y,x]
        if px[3] < 30: continue
        r,g,b = px[0], px[1], px[2]
        if not (r>120 and r>b+18): continue  # only skin/face tones get erased
        sxp = x-70 if x<372 else x+70
        sxp = max(0, min(W-1, sxp))
        src = snap[y, sxp]
        if src[3] < 30:
            sxp2 = x+70 if x<372 else x-70
            src = snap[y, max(0, min(W-1, sxp2))]
        if src[3] < 30: src = np.array([58,44,40,255], dtype=np.float32)
        er[y,x,0:3] = src[0:3]*ff + px[0:3]*(1-ff)
        er[y,x,3] = max(px[3], src[3]*ff)
er_img = Image.fromarray(er.astype(np.uint8))
def render(yaw, roll_deg, label):
    stage = Image.new('RGBA', (W,H), (43,18,21,255))
    stage.alpha_composite(er_img, (0,0))
    piv=(372,338); sq = 1-0.35*abs(yaw)
    h2 = head_img.resize((max(1,int(head_img.width*sq)), head_img.height), Image.LANCZOS)
    piv2 = ((piv[0]-120)*sq, piv[1])
    P = max(h2.width, h2.height)
    pad = Image.new('RGBA', (h2.width+2*P, h2.height+2*P), (0,0,0,0))
    pad.alpha_composite(h2, (P,P))
    rot = pad.rotate(-roll_deg, resample=Image.BICUBIC, center=(piv2[0]+P, piv2[1]+P), fillcolor=(0,0,0,0))
    stage.alpha_composite(rot, (round(piv[0]-(piv2[0]+P)), round(piv[1]-(piv2[1]+P))))
    stage.convert('RGB').save(f'/tmp/h2_{label}.png'); print(label)
render(0.9, -7, 'look')
render(-0.9, 6, 'lookL')
a=Image.open('/tmp/h2_look.png'); b=Image.open('/tmp/h2_lookL.png')
s=Image.new('RGB',(W*2,H)); s.paste(a,(0,0)); s.paste(b,(W,0)); s.save('/tmp/h2_sheet.png'); print('sheet')
