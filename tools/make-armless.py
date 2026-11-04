"""Free arms (v2.3): erase the arms from Doodle Swapnil's base talk drawing.

Writes talk/torso.png — the same 720x936 canvas with both arms (sleeves,
forearms, hands) removed, the torso side lines redrawn as clean bold outlines
and hand remnants over the trousers repainted in the trouser green — plus the
character's arm rig (shoulder points, limb lengths, sleeve/skin colours) into
character.rigpop.json as talk.freeArms.

usage: python3 tools/make-armless.py [pack_dir]
"""
import json, sys
from PIL import Image, ImageDraw

PACK = sys.argv[1] if len(sys.argv) > 1 else 'assets/packs/doodle-swapnil'
im = Image.open(f'{PACK}/talk/base.png').convert('RGBA')
W, H = im.size
px = im.load()
INK = (26, 26, 25, 255)
isK = lambda p: p[3] > 128 and sum(p[:3]) < 150
isSkin = lambda p: p[3] > 128 and p[0] > 170 and 100 < p[1] < 170 and p[2] < 140
SHO_Y = 372  # everything above stays (head, hair, neck, shoulder tops)

def lerp(pts, y):
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        if y0 <= y <= y1:
            return x0 + (x1 - x0) * (y - y0) / max(1, y1 - y0)
    return pts[0][0] if y < pts[0][1] else pts[-1][0]

# torso side lines, measured on the drawing (x at y)
L_SIDE = [(SHO_Y, 186), (420, 200), (470, 208), (560, 214), (780, 207), (815, 207), (936, 216)]
R_SIDE = [(SHO_Y, 540), (420, 520), (468, 497), (560, 503), (700, 512), (815, 521), (936, 522)]
L_SIDE = [(x, y) for y, x in L_SIDE]
R_SIDE = [(x, y) for y, x in R_SIDE]

def hair_left(y):
    """Leftmost x of the long black hair run crossing the left shoulder."""
    x = 170
    while x < 260:
        if isK(px[x, y]):
            x2 = x
            while x2 < W and isK(px[x2, y]): x2 += 1
            return x if x2 - x >= 18 else None
        x += 1
    return None

lb, rb, hair_rows = {}, {}, set()
for y in range(SHO_Y, H):
    side = lerp(L_SIDE, y)
    h = hair_left(y) if y < 640 else None
    if h is not None and h < side + 26:
        lb[y] = h; hair_rows.add(y)
    else:
        lb[y] = side
        if 560 <= y <= 812:  # snap to the drawn side line
            xs = [x for x in range(int(side) - 8, int(side) + 9) if isK(px[x, y])]
            if xs: lb[y] = min(xs)
    # right: snap to the drawn side line where it exists
    exp = lerp(R_SIDE, y)
    r = exp
    if 470 <= y <= 812:
        xs = [x for x in range(int(exp) - 8, int(exp) + 9) if isK(px[x, y])]
        if xs: r = max(xs)
    rb[y] = r

# a long sleeve-hem line can pass for hair on one row: median over ±7 rows
ys = sorted(lb)
lb_s = {}
for y in ys:
    win = sorted(lb[k] for k in range(y - 7, y + 8) if k in lb)
    lb_s[y] = win[len(win) // 2]
    if y in hair_rows and sum(1 for k in range(y - 7, y + 8) if k in hair_rows) < 8: hair_rows.discard(y)
lb = lb_s
out = im.copy()
op = out.load()
GREEN = (92, 151, 111, 255)
for y in range(SHO_Y, H):
    a, b = lb[y], rb[y]
    for x in range(W):
        if x < a - 0.5 or x > b + 0.5:
            op[x, y] = (0, 0, 0, 0)
    if y >= 838:  # hands overlapped the trouser legs: repaint the leg edge
        notG = lambda q: not (q[1] > q[0] + 30 and q[1] > q[2] + 15)
        for x in range(int(a) + 4, int(a) + 32):
            if notG(op[x, y]): op[x, y] = GREEN
        for x in range(int(b) - 32, int(b) - 3):
            if notG(op[x, y]): op[x, y] = GREEN
    # stray skin anywhere below the neck V is arm
    if y > 480:
        for x in range(int(a), int(b) + 1):
            if isSkin(op[x, y]): op[x, y] = GREEN

# redraw the cut edges as bold outlines (2x supersampled for clean edges)
S = 2
big = out.resize((W * S, H * S), Image.NEAREST)
d = ImageDraw.Draw(big)
def stroke(pts, w=5.5):
    pts = [(x * S + S / 2, y * S + S / 2) for x, y in pts]
    d.line(pts, fill=INK, width=int(w * S), joint='curve')
    for p in (pts[0], pts[-1]):
        r = w * S / 2; d.ellipse((p[0] - r, p[1] - r, p[0] + r, p[1] + r), fill=INK)
left_pts = [(lb[y] + 2.5, y) for y in range(SHO_Y + 8, H - 2, 4) if y not in hair_rows]
# split into continuous runs (hair rows already have their own outline)
runs, cur = [], []
for p in left_pts:
    if cur and p[1] - cur[-1][1] > 4: runs.append(cur); cur = []
    cur.append(p)
if cur: runs.append(cur)
for r in runs:
    if len(r) > 1: stroke(r)
stroke([(rb[y] - 2, y) for y in range(SHO_Y, H - 2, 4)])
out = big.resize((W, H), Image.LANCZOS)
out.save(f'{PACK}/talk/torso.png', optimize=True)

# the hair strand that falls over the left shoulder, as its own layer: drawn
# over the upper arm (so the strand stays in front of the shoulder), under
# the forearm and hand
try:
    import numpy as np
    from scipy import ndimage
    a = np.array(out)
    dark = (a[..., 3] > 100) & (a[..., :3].sum(-1) < 200)
    reg = np.zeros_like(dark); reg[355:700, 175:338] = True
    core = ndimage.binary_opening(dark & reg, structure=np.ones((9, 9)))  # thick hair only, not outlines
    lab, n = ndimage.label(core)
    if n:
        sizes = ndimage.sum(core, lab, range(1, n + 1)); core = lab == (1 + int(np.argmax(sizes)))
    m = ndimage.binary_dilation(core, iterations=4) & reg & (a[..., 3] > 0)
    m &= ~((a[..., 1].astype(int) > a[..., 0].astype(int) + 20) & (a[..., :3].sum(-1) > 150))
    m[:372] = False  # above the shoulders it is already in the torso layer
    hf = np.zeros_like(a); hf[m] = a[m]
    Image.fromarray(hf).save(f'{PACK}/talk/hair_front.png', optimize=True)
except ImportError:
    print('numpy/scipy missing: hair_front.png not written')

# colours sampled from the art
def sample(x0, y0, x1, y1, pred):
    acc = [0, 0, 0]; n = 0
    for y in range(y0, y1):
        for x in range(x0, x1):
            p = px[x, y]
            if pred(p): acc = [acc[i] + p[i] for i in range(3)]; n += 1
    return '#%02x%02x%02x' % tuple(round(c / max(1, n)) for c in acc)
sleeve = sample(540, 420, 590, 500, lambda p: p[3] > 200 and p[1] > p[0] + 20)
skin = sample(520, 600, 560, 760, isSkin)

man = json.load(open(f'{PACK}/character.rigpop.json'))
man['talk']['torso'] = 'talk/torso.png'
man['talk']['hairFront'] = 'talk/hair_front.png'
man['talk']['freeArms'] = {
    'note': 'v2.3 Free arms rig, base-drawing pixels. tools/make-armless.py',
    'shoulders': {'L': [218, 436], 'R': [502, 436]},   # drawing-left / drawing-right shoulder joints
    'upper': 225, 'fore': 195, 'hand': 92,            # limb lengths (shoulder-elbow, elbow-wrist, wrist-fingertip)
    'armW': 58, 'sleeveW': 92, 'sleeveLen': 0.55,     # forearm capsule width, sleeve width, sleeve share of the upper arm
    'sleeve': sleeve, 'skin': skin, 'ink': '#1a1a19', 'outline': 6,
    'hipY': 815
}
json.dump(man, open(f'{PACK}/character.rigpop.json', 'w'), indent=2, ensure_ascii=False)
print('torso.png written; sleeve', sleeve, 'skin', skin)
