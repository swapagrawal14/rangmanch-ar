#!/usr/bin/env python3
"""Rangmanch v2.2 pose library: adds the new authored poses to the packs and
measures everything the app needs to perform them.

  python3 tools/add-poses.py import <src-dir> [pack]   # <pack>__<key>.png drawings
  python3 tools/add-poses.py heads                     # head region + pivot, all poses

import: each drawing (made with the image model from the pack's own base
drawing as the reference, on chroma green) is re-keyed, despilled at its
edges only, resized onto the pack canvas (720x936) and saved as WebP under
assets/packs/<pack>/talk/v22/. Its face is located against the base face by
normalised cross-correlation (same search as measure-anchors.py); when the
hand hides the face (cover, facepalm, a gasp) and the match is weak, the
drawing is checked against the base body silhouette instead and, if it was
drawn on the base framing (the image model keeps it), the base anchors are
used. A drawing that fits neither is refused.

wave2 is imported like any other pose: a second drawing of the pack's own
wave (forearm leaning the other way) for a hard-cut two-frame wave. (A
derived frame made by warping the forearm inside the wave drawing was tried
on 2026-11-03 and dropped: on these illustrations the forearm cannot be
separated from the hair and sleeves beside it without tearing them.)

heads: the head ellipse and neck pivot (tools/head_region.py) for every pose
of every pack, carried from the base through each pose's face anchor.

Everything lands in assets/anchors.json; no existing drawing is modified or
removed (redrawn poses are new files the app prefers via "file")."""
import json
import os
import sys
import importlib.util

import numpy as np
from PIL import Image, ImageFilter
from scipy.ndimage import map_coordinates, binary_dilation, gaussian_filter, label

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PACKS = os.path.join(ROOT, 'assets', 'packs')
ANCH = os.path.join(ROOT, 'assets', 'anchors.json')
sys.path.insert(0, os.path.join(ROOT, 'tools'))
from head_region import base_head, carry  # noqa: E402

_spec = importlib.util.spec_from_file_location('ma', os.path.join(ROOT, 'tools', 'measure-anchors.py'))
ma = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(ma)

CLASSIC = ['wave', 'point', 'open', 'thumbs']
# what of the pack's face tiles may be drawn on each new pose: a hand over the
# mouth must never get a talking mouth painted on top of it
FACE = {'mouth': 'eyes', 'shh': 'eyes', 'cover': 'none', 'facepalm': 'mouth', 'think': 'full',
        'head': 'full', 'namaste': 'full', 'clap': 'full', 'salute': 'full', 'fist': 'full',
        'open': 'full', 'point': 'full', 'wave2': 'full'}
# poses whose hands touch the head: the head moves with the whole figure only,
# never on its own (the warp would bend the hand with it)
NO_HEAD_WARP = {'mouth', 'shh', 'cover', 'facepalm', 'think', 'head', 'salute'}
# the image model was asked for the gesturing hand on this side of the
# drawing; the automatic estimate is printed alongside for checking
SIDE_HINT = {'salute': 'L', 'fist': 'R', 'point': 'R'}
# which side of the drawing the gesturing arm comes from, labelled by eye from
# the contact sheet (2026-11-03): hands inside the silhouette (on the mouth,
# the chin) defeat the automatic estimate
SIDES = {
    'doodle-swapnil': {'mouth': 'L', 'think': 'R', 'shh': 'R', 'facepalm': 'L', 'salute': 'L', 'fist': 'R'},
    'bunty': {'mouth': 'R', 'think': 'L', 'shh': 'R', 'facepalm': 'R', 'salute': 'L', 'fist': 'L'},
    'swapnil': {'mouth': 'L', 'think': 'L', 'shh': 'L', 'facepalm': 'L', 'salute': 'L', 'fist': 'L'},
    'sanjay': {'mouth': 'R', 'think': 'L', 'shh': 'L', 'facepalm': 'L', 'salute': 'L', 'fist': 'L', 'point': 'R'},
}
# per-drawing fixes found by looking at the results
FACE_OVERRIDE = {('sanjay', 'point'): 'none'}  # turned head, open mouth: no tiles
# drawings checked by eye to sit on the base framing (same head size and place)
# whose arms cross the body too much for the silhouette test
FRAMING_OK = {('sanjay', 'cover'), ('sanjay', 'point')}


def load_json(p, d):
    try:
        return json.load(open(p))
    except Exception:
        return d


def manifest(pid):
    return json.load(open(os.path.join(PACKS, pid, 'character.rigpop.json')))


def base_face(pid, man, anch):
    pa = (man['talk'].get('poseAnchors') or {}).get('base')
    if pa:
        return pa['mouth'], pa['eyes']
    b = anch['packs'][pid]['base']
    return b['mouth'], b['eyes']


def clean(src, W, H):
    im = Image.open(src).convert('RGBA')
    a = np.asarray(im).astype(np.float32)
    rgb, al = a[..., :3], a[..., 3]
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    al[(g > 150) & (g > r * 1.6) & (g > b * 1.6)] = 0          # leftover chroma
    near = np.asarray(Image.fromarray((al < 128).astype(np.uint8) * 255).filter(ImageFilter.MaxFilter(7))) > 0
    spill = near & (g > np.maximum(r, b))                       # despill edges only
    rgb[..., 1] = np.where(spill, np.maximum(r, b), g)
    al[near & (al < 200) & (g > r) & (g > b)] = 0
    out = Image.fromarray(np.dstack([rgb, al]).clip(0, 255).astype(np.uint8), 'RGBA')
    return out.resize((W, H), Image.LANCZOS)


def grey(im):
    a = np.asarray(im).astype(np.float32) / 255.0
    return (a[..., :3] * a[..., 3:4] + 0.5 * (1 - a[..., 3:4])).mean(axis=2)


def body_iou(base_alpha, pose_alpha, y0):
    b, p = base_alpha[y0:] > 0.3, pose_alpha[y0:] > 0.3
    return float((b & p).sum()) / max(1, float((b | p).sum()))


def side_of(base_path, pose_path, mouth, pf, sc):
    return ma.gesture_side(base_path, pose_path, mouth, pf, sc)


def cmd_import(src, only=None):
    anch = load_json(ANCH, {'packs': {}})
    lib = load_json(os.path.join(ROOT, 'tools', 'pose-library.json'), {})
    files = sorted(f for f in os.listdir(src) if f.endswith('.png') and '__' in f)
    for f in files:
        pid, key = f[:-4].split('__')
        if only and pid != only:
            continue
        man = manifest(pid); talk = man['talk']
        W, H = talk['canvas']['w'], talk['canvas']['h']
        im = clean(os.path.join(src, f), W, H)
        rel = f'talk/v22/pose_{key}.webp'
        os.makedirs(os.path.join(PACKS, pid, 'talk', 'v22'), exist_ok=True)
        out = os.path.join(PACKS, pid, rel)
        im.save(out, 'WEBP', quality=88, method=6)
        base_path = os.path.join(PACKS, pid, talk['base'])
        base = ma.load(base_path)
        box = ma.face_box(talk)
        mouth, eyes = base_face(pid, man, anch)
        sc, px, py, score = ma.locate(base, grey(im), box)
        bal = np.asarray(Image.open(base_path).convert('RGBA'))[..., 3] / 255.0
        pal = np.asarray(im)[..., 3] / 255.0
        iou = body_iou(bal, pal, int(H * 0.72))
        if score >= 0.68 and 0.8 <= sc <= 1.25:
            how = 'ncc'
            mp = lambda q: [round(px + (q[0] - box[0]) * sc), round(py + (q[1] - box[1]) * sc)]
            m2, e2 = mp(mouth), mp(eyes)
        elif iou >= 0.7 or (pid, key) in FRAMING_OK:
            how = 'framing'   # drawn on the base framing (the face is hidden by a hand)
            sc, m2, e2 = 1.0, [round(mouth[0]), round(mouth[1])], [round(eyes[0]), round(eyes[1])]
            if key == 'wave2':  # drawn on the WAVE drawing's framing, not the base's
                wa = (talk.get('poseAnchors') or {}).get('wave') or anch['packs'][pid].get('wave', {})
                if wa.get('mouth'):
                    sc = anch['packs'][pid].get('wave', {}).get('scale', 1.0)
                    m2, e2 = list(wa['mouth']), list(wa['eyes'])
        else:
            print(f'  REFUSED {pid} {key}: face score {score:.2f}, body IoU {iou:.2f}')
            continue
        tmp = out.replace('.webp', '.tmp.png'); im.save(tmp)
        auto = side_of(base_path, tmp, mouth, m2, sc)
        os.remove(tmp)
        side = (anch['packs'][pid].get('wave', {}).get('side') if key == 'wave2' else SIDES.get(pid, {}).get(key) or SIDE_HINT.get(key, auto)) if key not in ('namaste', 'clap', 'cover', 'head', 'open') else None
        entry = {'file': rel, 'mouth': m2, 'eyes': e2, 'scale': round(sc, 3), 'score': round(score, 3),
                 'side': side, 'face': FACE_OVERRIDE.get((pid, key), FACE.get(key, 'full')),
                 'headWarp': key not in NO_HEAD_WARP, 'v22': True, 'align': how}
        anch['packs'].setdefault(pid, {})[key] = entry
        lib[f'{pid}/{key}'] = {'align': how, 'score': round(score, 3), 'bodyIoU': round(iou, 3), 'autoSide': auto, 'side': side}
        print(f'  {pid:15s} {key:9s} {how:8s} score {score:.2f} iou {iou:.2f} side {side} (auto {auto})  {os.path.getsize(out)//1024} KB')
        json.dump(anch, open(ANCH, 'w'), indent=1)
        json.dump(lib, open(os.path.join(ROOT, 'tools', 'pose-library.json'), 'w'), indent=1)


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def cmd_heads():
    anch = load_json(ANCH, {'packs': {}})
    for pid in sorted(os.listdir(PACKS)):
        man = manifest(pid); talk = man['talk']
        bm, be = base_face(pid, man, anch)
        base = np.asarray(Image.open(os.path.join(PACKS, pid, talk['base'])).convert('RGBA'))[..., 3] / 255.0
        hb = base_head(base, bm, be, talk['patches']['blink']['w'], pid)
        bf = [(bm[0] + be[0]) / 2, (bm[1] + be[1]) / 2]
        hand = talk.get('poseAnchors') or {}
        P = anch['packs'].setdefault(pid, {})
        P.setdefault('base', {'scale': 1.0})['head'] = hb
        for key, e in P.items():
            if key == 'base':
                continue
            m = (hand.get(key) or {}).get('mouth') if not e.get('file') or e.get('derived') else None
            ey = (hand.get(key) or {}).get('eyes') if m else None
            m, ey = m or e.get('mouth'), ey or e.get('eyes')
            if not m or not ey or e.get('refused'):
                continue
            pf = [(m[0] + ey[0]) / 2, (m[1] + ey[1]) / 2]
            e['head'] = carry(hb, bf, pf, e.get('scale', 1.0))
        print(f'  {pid:15s} head {hb}')
    json.dump(anch, open(ANCH, 'w'), indent=1)


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else ''
    if cmd == 'import':
        cmd_import(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None)
    elif cmd == 'heads':
        cmd_heads()
    else:
        print(__doc__)
