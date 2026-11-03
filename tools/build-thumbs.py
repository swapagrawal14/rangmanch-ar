#!/usr/bin/env python3
"""Build the small casting thumbnails (assets/thumbs/<id>.webp, ~12 KB each)
from each pack's base drawing, so the character picker never downloads the
full 700 KB artwork just to show a face. Run: python3 tools/build-thumbs.py"""
import json
import os
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PACKS = os.path.join(ROOT, 'assets', 'packs')
OUT = os.path.join(ROOT, 'assets', 'thumbs')
os.makedirs(OUT, exist_ok=True)
for pid in sorted(os.listdir(PACKS)):
    man = json.load(open(os.path.join(PACKS, pid, 'character.rigpop.json')))
    im = Image.open(os.path.join(PACKS, pid, man['talk']['base'])).convert('RGBA')
    bb = im.getchannel('A').point(lambda a: 255 if a > 12 else 0).getbbox()
    im = im.crop(bb)
    im.thumbnail((180, 234), Image.LANCZOS)
    im.save(os.path.join(OUT, pid + '.webp'), 'WEBP', quality=82, method=6)
    print('thumb', pid)
