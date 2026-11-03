from PIL import Image, ImageDraw, ImageFilter
import numpy as np, math

BASE = Image.open('/home/hatch/workspace/rangmanch-ar/assets/packs/swapnil/talk/base.png').convert('RGBA')
W,H = BASE.size
arr = np.array(BASE).astype(np.float32)

def seg_mask(shape, p1, p2, r):
    yy, xx = np.mgrid[0:shape[0], 0:shape[1]]
    vx, vy = p2[0]-p1[0], p2[1]-p1[1]
    L2 = vx*vx+vy*vy
    t = np.clip(((xx-p1[0])*vx + (yy-p1[1])*vy)/L2, 0, 1)
    dx = xx-(p1[0]+t*vx); dy = yy-(p1[1]+t*vy)
    return (np.hypot(dx,dy) <= r).astype(np.float32)

# arm bones (image px)
ARMS = {
 'R': {'sho':(243,400),'elb':(210,604),'wri':(176,772)},
 'L': {'sho':(502,400),'elb':(538,604),'wri':(578,772)},
}
R = 34
masks = {}
for side, J in ARMS.items():
    m = np.maximum(seg_mask((H,W), J['sho'], J['elb'], R), seg_mask((H,W), J['elb'], J['wri'], R))
    masks[side] = m

# --- erased underlayer: smear pixels horizontally away from body centre (x=372) ---
erased = arr.copy()
for side, m in masks.items():
    ys, xs = np.where(m>0)
    shift = -46 if side=='R' else 46   # sample from outside (hair/bg side)
    sx = np.clip(xs+shift, 0, W-1)
    erased[ys, xs] = arr[ys, sx]
erased_img = Image.fromarray(erased.astype(np.uint8), 'RGBA')
# soften erased region slightly
soft = erased_img.filter(ImageFilter.GaussianBlur(1.2))
m_all = np.maximum(masks['R'], masks['L'])
erased_img = Image.composite(soft, erased_img, Image.fromarray((m_all*255).astype(np.uint8)))
erased_img.save('/tmp/proto_erased.png')

# --- arm strip images (masked crops per segment) ---
def strip(p1, p2, r=R, pad=14):
    m = seg_mask((H,W), p1, p2, r)
    mimg = Image.fromarray((m*255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(3))
    out = BASE.copy(); out.putalpha(Image.fromarray(np.minimum(np.array(BASE)[:,:,3], np.array(mimg)).astype(np.uint8)))
    x0 = max(0, min(p1[0],p2[0])-r-pad); x1 = min(W, max(p1[0],p2[0])+r+pad)
    y0 = max(0, min(p1[1],p2[1])-r-pad); y1 = min(H, max(p1[1],p2[1])+r+pad)
    return out.crop((x0,y0,x1,y1)), (x0,y0)

def draw_seg(canvas, strip_img, origin, rest_from, rest_to, live_from, live_to):
    ra = math.atan2(rest_to[1]-rest_from[1], rest_to[0]-rest_from[0])
    la = math.atan2(live_to[1]-live_from[1], live_to[0]-live_from[0])
    rl = math.hypot(rest_to[0]-rest_from[0], rest_to[1]-rest_from[1]); ll = math.hypot(live_to[0]-live_from[0], live_to[1]-live_from[1])
    s = ll/rl
    img = strip_img.resize((max(1,round(strip_img.width*s)), max(1,round(strip_img.height*s))), Image.LANCZOS)
    piv = ((rest_from[0]-origin[0])*s, (rest_from[1]-origin[1])*s)
    P = max(img.width, img.height)
    padded = Image.new('RGBA', (img.width+2*P, img.height+2*P), (0,0,0,0))
    padded.alpha_composite(img, (P,P))
    pivP = (piv[0]+P, piv[1]+P)
    rot = padded.rotate(-math.degrees(la-ra), resample=Image.BICUBIC, center=pivP, fillcolor=(0,0,0,0))
    canvas.alpha_composite(rot, (round(live_from[0]-pivP[0]), round(live_from[1]-pivP[1])))

def render(pose, label):
    stage = Image.new('RGBA', (W,H), (43,18,21,255))
    stage.alpha_composite(erased_img, (0,0))
    J = {s: dict(ARMS[s]) for s in ARMS}
    for k,v in pose.items():
        side, joint = k[0], k[1:]
        J[side][joint] = v
    for side in ('R','L'):
        for a,b in (('sho','elb'),('elb','wri')):
            st, org = strip(ARMS[side][a], ARMS[side][b])
            draw_seg(stage, st, org, ARMS[side][a], ARMS[side][b], J[side][a], J[side][b])
    stage.convert('RGB').save(f'/tmp/arm_{label}.png')
    print('saved', label)

render({}, 'rest')
render({'Relb':(168,330), 'Rwri':(205,168)}, 'wave')
imgs=[Image.open(f'/tmp/arm_{n}.png') for n in ('rest','wave')]
er=Image.open('/tmp/proto_erased.png').convert('RGB')
sheet=Image.new('RGB',(W*3,H))
sheet.paste(er,(0,0))
for i,im in enumerate(imgs): sheet.paste(im,((i+1)*W,0))
sheet.save('/tmp/arm_sheet.png'); print('sheet ok')
