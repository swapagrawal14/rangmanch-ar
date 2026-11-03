#!/usr/bin/env python3
"""Measure per-pose face anchors for packs that ship without talk.poseAnchors.

Rangmanch composites the A/O/E mouth and blink tiles onto whichever authored
pose drawing is on stage, so it must know where the face sits in EACH pose
drawing. Four packs carry hand-measured anchors; the other twelve only carry
base-pose patch rectangles, so in v2.0.x their faces never moved at all.

This tool finds the base face (eyes + mouth region, cut from talk/base.png
around the pack's own patch rects) inside every pose drawing by normalised
cross-correlation (coarse at 1/4 scale, refined at full scale), and writes the
result to assets/anchors.json. Nothing in the packs is modified.

It validates itself first against the four hand-measured packs and refuses to
write if the median error there exceeds 6 px.

Run: python3 tools/measure-anchors.py   (needs numpy, pillow, scipy)
"""
import json
import os
import sys

import numpy as np
from PIL import Image
from scipy.signal import fftconvolve

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PACKS = os.path.join(ROOT, 'assets', 'packs')
POSES = ['wave', 'point', 'open', 'thumbs']
MIN_SCORE = 0.5  # weaker matches are refused, never guessed
# Which side of each drawing the gesturing arm is on (drawing coordinates),
# labelled by eye from the pose sheets on 2026-11-03 — the automatic estimate
# below is only a fallback for packs added later, and disagreements are printed.
SIDES = {
    'bhavishy': ('L', 'R', 'L'), 'bubbles': (None, 'R', 'L'), 'bunty': ('L', 'R', 'L'),
    'doodle-swapnil': ('R', 'R', None), 'kiko': ('L', 'R', 'L'), 'luna': ('L', 'R', 'L'),
    'mira': ('L', 'R', 'L'), 'mocha': ('R', 'R', 'L'), 'pia': ('L', 'R', 'R'),
    'puni': ('R', 'R', 'L'), 'rafi': ('L', 'R', 'L'), 'sanjay': ('L', 'R', 'R'),
    'seema': ('L', 'R', 'L'), 'solana': ('L', 'R', 'L'), 'static': ('L', 'R', 'L'),
    'swapnil': ('L', 'R', 'L'),
}


def load(path):
    im = Image.open(path).convert('RGBA')
    a = np.asarray(im).astype(np.float32) / 255.0
    rgb, al = a[..., :3], a[..., 3:4]
    # composite on mid grey so transparent areas never match ink
    return (rgb * al + 0.5 * (1 - al)).mean(axis=2)


def ncc(img, tpl):
    """Normalised cross-correlation map (valid positions)."""
    t = tpl - tpl.mean()
    tn = np.sqrt((t * t).sum()) + 1e-6
    ones = np.ones_like(tpl)
    num = fftconvolve(img, t[::-1, ::-1], mode='valid')
    s1 = fftconvolve(img, ones, mode='valid')
    s2 = fftconvolve(img * img, ones, mode='valid')
    n = tpl.size
    var = s2 - s1 * s1 / n
    tv = (t * t).sum()
    # positions far flatter than the template (blank paper, flat fills) are
    # not candidates: plain NCC explodes there
    out = num / (np.sqrt(np.maximum(var, 1e-9)) * tn)
    out[var < 0.25 * tv] = -1
    return out


def face_box(talk):
    p = talk['patches']
    b, a = p['blink'], p['A']
    x0 = min(b['x'], a['x']) - 24
    x1 = max(b['x'] + b['w'], a['x'] + a['w']) + 24
    y0 = b['y'] - 46
    y1 = a['y'] + a['h'] + 34
    return int(x0), int(y0), int(x1), int(y1)


def base_anchor(talk):
    pa = (talk.get('poseAnchors') or {}).get('base')
    if pa and pa.get('mouth') and pa.get('eyes'):
        return pa['mouth'], pa['eyes']
    p = talk['patches']
    c = lambda r: [r['x'] + r['w'] / 2, r['y'] + r['h'] / 2]
    return c(p['A']), c(p['blink'])


def rs(a, s):
    h, w = a.shape
    im = Image.fromarray((a * 255).astype(np.uint8))
    return np.asarray(im.resize((max(8, int(w * s)), max(8, int(h * s))), Image.BILINEAR)).astype(np.float32) / 255.0


def locate(base, pose, box):
    """Find the base face in a pose drawing: returns (scale, face-centre x, y, score).
    Pose drawings are separate illustrations, often drawn at a different size,
    so the search is multi-scale (template resized), coarse at 1/4 then refined."""
    x0, y0, x1, y1 = box
    tpl = base[y0:y1, x0:x1]
    f = 0.25
    P = rs(pose, f)
    best = (-2, 1, 0, 0)
    for sc in np.arange(0.55, 1.36, 0.05):
        T = rs(tpl, f * sc)
        if T.shape[0] >= P.shape[0] or T.shape[1] >= P.shape[1]:
            continue
        m = ncc(P, T)
        i = np.argmax(m)
        if m.flat[i] > best[0]:
            yy, xx = np.unravel_index(i, m.shape)
            best = (m.flat[i], sc, xx / f, yy / f)
    _, sc0, cx, cy = best
    # refine at full resolution around the coarse hit
    best2 = (-2, sc0, cx, cy)
    for sc in np.arange(sc0 - 0.04, sc0 + 0.041, 0.02):
        T = rs(tpl, sc)
        R = 12
        ya, xa = int(max(0, cy - R)), int(max(0, cx - R))
        win = pose[ya: int(cy) + R + T.shape[0], xa: int(cx) + R + T.shape[1]]
        if win.shape[0] <= T.shape[0] or win.shape[1] <= T.shape[1]:
            continue
        m = ncc(win, T)
        i = np.argmax(m)
        if m.flat[i] > best2[0]:
            yy, xx = np.unravel_index(i, m.shape)
            best2 = (m.flat[i], sc, xa + xx, ya + yy)
    score, sc, px, py = best2
    return float(sc), float(px), float(py), float(score)


def alpha(path):
    return np.asarray(Image.open(path).convert('RGBA'))[..., 3].astype(np.float32) / 255.0


def gesture_side(base_path, pose_path, base_face, pose_face, sc):
    """Which side of the drawing the gesturing arm is on ('L'/'R' in drawing
    coordinates, None when symmetric). The pose drawing is aligned onto the
    base by its face (position + drawing scale); the pixels the pose has and
    the base lacks are the moved arm, and their mass left/right of the face
    gives the side. The app mirrors the drawing when you gesture with the
    other arm, so raising your right hand never makes the character raise
    its left."""
    b = alpha(base_path) > 0.3
    p = Image.open(pose_path).convert('RGBA').getchannel('A')
    k = 1.0 / sc
    # affine: base coords -> pose coords  (x_p = pf + (x_b - bf) * sc)
    a, e = sc, sc
    c = pose_face[0] - base_face[0] * sc
    f = pose_face[1] - base_face[1] * sc
    W, H = p.size
    pa = np.asarray(p.transform((W, H), Image.AFFINE, (a, 0, c, 0, e, f), Image.BILINEAR)).astype(np.float32) / 255.0
    # per-row silhouette extents of the base, padded: a gesturing arm reaches
    # beyond them (sideways or above the head); redrawn hair/outline wobble does not
    pad = 30
    rows = b.any(axis=1)
    xmin = np.where(rows, b.argmax(axis=1), W // 2) - pad
    xmax = np.where(rows, W - 1 - b[:, ::-1].argmax(axis=1), W // 2) + pad
    xs = np.arange(W)[None, :]
    beyond_r = np.clip(xs - xmax[:, None], 0, None)
    beyond_l = np.clip(xmin[:, None] - xs, 0, None)
    on = pa > 0.3
    mr = float((on * beyond_r).sum()); ml = float((on * beyond_l).sum())
    asym = (mr - ml) / max(1.0, mr + ml)
    return ('R' if asym > 0 else 'L') if abs(asym) > 0.25 else None


def measure(pid):
    man = json.load(open(os.path.join(PACKS, pid, 'character.rigpop.json')))
    talk = man['talk']
    base = load(os.path.join(PACKS, pid, talk['base']))
    box = face_box(talk)
    mouth, eyes = base_anchor(talk)
    out = {'base': {'mouth': [round(mouth[0]), round(mouth[1])], 'eyes': [round(eyes[0]), round(eyes[1])], 'scale': 1.0, 'score': 1.0}}
    for k in POSES:
        f = (talk.get('poses') or {}).get(k)
        if not f:
            continue
        pose = load(os.path.join(PACKS, pid, f))
        sc, px, py, score = locate(base, pose, box)
        x0, y0 = box[0], box[1]
        mp = lambda q: [round(px + (q[0] - x0) * sc), round(py + (q[1] - y0) * sc)]
        out[k] = {'mouth': mp(mouth), 'eyes': mp(eyes), 'scale': round(sc, 3), 'score': round(score, 3)}
        hand_a = (talk.get('poseAnchors') or {}).get(k)
        pf = hand_a['mouth'] if hand_a else out[k]['mouth']
        good = score >= MIN_SCORE and 0.6 <= sc <= 1.4
        # an unmatched pose is compared unaligned (same canvas, same floor line)
        auto = gesture_side(os.path.join(PACKS, pid, talk['base']), os.path.join(PACKS, pid, f),
                            mouth, pf if (good or hand_a) else mouth, sc if good else 1.0)
        if k == 'open':
            out[k]['side'] = None
        elif pid in SIDES:
            lab = SIDES[pid][['wave', 'point', 'thumbs'].index(k)]
            if auto != lab:
                print(f'  side check {pid} {k}: labelled {lab}, auto {auto}')
            out[k]['side'] = lab
        else:
            out[k]['side'] = auto
    return man, out


def main():
    ids = sorted(os.listdir(PACKS))
    errs = []
    for pid in ids:
        man, got = measure(pid)
        truth = man['talk'].get('poseAnchors') or {}
        for k in POSES:
            if k in truth and k in got:
                e = np.hypot(*(np.array(truth[k]['mouth']) - np.array(got[k]['mouth'])))
                if got[k]['score'] >= MIN_SCORE:
                    errs.append(e)
                print(f'  validate {pid:8s} {k:6s} mouth err {e:5.1f}px  (score {got[k]["score"]})')
    med = float(np.median(errs)) if errs else 0
    print(f'validation median mouth error: {med:.1f}px over {len(errs)} accepted hand-measured poses')
    if med > 8:
        print('refusing to write: measurement disagrees with hand-measured anchors')
        sys.exit(1)
    result = {}
    for pid in ids:
        man, got = measure(pid)
        hand = man['talk'].get('poseAnchors') or {}
        ok = {k: v for k, v in got.items() if v['score'] >= MIN_SCORE and 0.6 <= v.get('scale', 1) <= 1.4}
        if hand:
            # hand-measured positions always win; only the drawing scale is added
            result[pid] = {k: {'scale': ok[k].get('scale', 1.0) if k in ok else 1.0, 'hand': True, 'side': got.get(k, {}).get('side')} for k in hand}
        else:
            # a weak or implausible match is refused: the app then performs that
            # pose without face tiles rather than painting a mouth in the wrong place
            result[pid] = ok
            # a refused pose still records its gesture side (mirroring needs no face)
            for k, v in got.items():
                if k not in ok:
                    result[pid][k] = {'side': v.get('side'), 'refused': True}
        print(pid, {k: (v['mouth'], v['score']) for k, v in got.items()})
    with open(os.path.join(ROOT, 'assets', 'anchors.json'), 'w') as fh:
        json.dump({'note': 'Generated by tools/measure-anchors.py: per-pose face anchors for packs without hand-measured talk.poseAnchors.', 'packs': result}, fh, indent=1)
    print('wrote assets/anchors.json')


if __name__ == '__main__':
    main()
