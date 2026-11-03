#!/usr/bin/env python3
"""Build Rangmanch README visuals from the REAL Rigpop Forge pack art.
Dev-only generator (Pillow) — the PNGs it writes are committed, the app needs no build.
Character art is the packs' own AI-generated art; this script only composes it."""
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import os

ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
PACKS = os.path.join(ROOT, "assets", "packs")
OUT = os.path.join(ROOT, "docs", "assets")
os.makedirs(OUT, exist_ok=True)

SERIF_B = "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf"
SANS_B = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
SANS = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"

GOLD = (242, 179, 61)
CREAM = (247, 234, 215)
RED = (156, 34, 43)
INK = (34, 20, 9)


def font(path, size):
    return ImageFont.truetype(path, size)


def load(pack, name="base.png"):
    return Image.open(os.path.join(PACKS, pack, "talk", name)).convert("RGBA")


def fit(img, h):
    w = round(img.width * h / img.height)
    return img.resize((w, h), Image.LANCZOS)


# ---------------- hero banner ----------------
def hero():
    W, H = 1640, 760
    img = Image.new("RGB", (W, H), (23, 12, 8))
    d = ImageDraw.Draw(img, "RGBA")
    # stage backdrop: deep red top -> warm dark, wooden floor strip
    for y in range(H):
        t = y / H
        r = int(64 - 40 * t); g = int(18 - 8 * t); b = int(22 - 12 * t)
        d.line([(0, y), (W, y)], fill=(r, g, b))
    floor_y = int(H * 0.82)
    d.rectangle([0, floor_y, W, H], fill=(74, 44, 23))
    for x in range(0, W, 120):
        d.line([(x, floor_y), (x, H)], fill=(52, 30, 14), width=3)
    # spotlights
    spot = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    sd = ImageDraw.Draw(spot)
    for cx in (W * 0.28, W * 0.55, W * 0.8):
        sd.ellipse([cx - 300, floor_y - 330, cx + 300, floor_y + 90], fill=(255, 226, 150, 52))
    img.paste(Image.alpha_composite(img.convert("RGBA"), spot.filter(ImageFilter.GaussianBlur(40))).convert("RGB"), (0, 0))
    d = ImageDraw.Draw(img, "RGBA")
    # cast on stage
    bunty = fit(load("bunty"), 330)
    swap = fit(load("swapnil", "pose_wave.png"), 398)
    mocha = fit(load("mocha"), 360)
    img.paste(bunty, (int(W * 0.10), floor_y - 318), bunty)
    img.paste(mocha, (int(W * 0.74), floor_y - 348), mocha)
    img.paste(swap, (int(W * 0.40), floor_y - 388), swap)
    for cx, w_ in ((W * 0.16, 200), (W * 0.52, 260), (W * 0.82, 210)):
        d.ellipse([cx - w_ / 2, floor_y - 6, cx + w_ / 2, floor_y + 16], fill=(0, 0, 0, 90))
    # marquee frame + title
    d.rectangle([14, 14, W - 14, H - 14], outline=GOLD, width=5)
    for x in range(60, W - 40, 62):
        for yy in (34, H - 34):
            d.ellipse([x - 7, yy - 7, x + 7, yy + 7], fill=(255, 217, 122), outline=GOLD)
    title = "RANGMANCH AR"
    f = font(SERIF_B, 108)
    tw = d.textlength(title, font=f)
    d.text(((W - tw) / 2, 54), title, font=f, fill=CREAM, stroke_width=2, stroke_fill=(0, 0, 0))
    tag = "Don't animate. Act. — one person, every character, live."
    f2 = font(SANS_B, 33)
    tw2 = d.textlength(tag, font=f2)
    d.text(((W - tw2) / 2, 182), tag, font=f2, fill=GOLD)
    img.save(os.path.join(OUT, "hero.png"))
    print("hero.png", img.size)


# ---------------- cast lineup (all 16) ----------------
CAST = [
    ("swapnil", "Swapnil"), ("doodle-swapnil", "Doodle Swapnil"), ("sanjay", "Dr Sanjay"),
    ("seema", "Seema"), ("bhavishy", "Bhavishy"), ("mocha", "Mocha"),
    ("bunty", "Bunty"), ("pia", "Pia"), ("solana", "Solana"), ("rafi", "Rafi"),
    ("kiko", "Kiko"), ("mira", "Mira"), ("bubbles", "Bubbles"), ("luna", "Luna"),
    ("puni", "Puni"), ("static", "Static"),
]

def cast_lineup():
    cols, cell_w, cell_h = 8, 250, 360
    rows = 2
    W, H = cols * cell_w, rows * cell_h + 20
    img = Image.new("RGB", (W, H), (247, 234, 215))
    d = ImageDraw.Draw(img)
    f = font(SANS_B, 26)
    for i, (pid, name) in enumerate(CAST):
        cx = (i % cols) * cell_w; cy = (i // cols) * cell_h
        ch = fit(load(pid), 268)
        img.paste(ch, (cx + (cell_w - ch.width) // 2, cy + 26), ch)
        tw = d.textlength(name, font=f)
        d.text((cx + (cell_w - tw) / 2, cy + 306), name, font=f, fill=INK)
    img.save(os.path.join(OUT, "cast-lineup.png"))
    print("cast-lineup.png", img.size)


# ---------------- pose strip (lead actor) ----------------
def pose_strip():
    poses = [("base.png", "BASE", "just stand"), ("pose_wave.png", "WAVE", "one hand up"),
             ("pose_point.png", "POINT", "arm out"), ("pose_open.png", "OPEN", "both hands up"),
             ("pose_thumbs.png", "THUMBS", "hero pose")]
    cell_w, H = 330, 560
    W = cell_w * len(poses)
    img = Image.new("RGB", (W, H), (247, 234, 215))
    d = ImageDraw.Draw(img)
    f1, f2 = font(SANS_B, 30), font(SANS, 23)
    for i, (file, label, trig) in enumerate(poses):
        cx = i * cell_w
        ch = fit(load("swapnil", file), 420)
        img.paste(ch, (cx + (cell_w - ch.width) // 2, 16), ch)
        for fnt, txt, y, col in ((f1, label, 452, RED), (f2, trig, 496, INK)):
            tw = d.textlength(txt, font=fnt)
            d.text((cx + (cell_w - tw) / 2, y), txt, font=fnt, fill=col)
    img.save(os.path.join(OUT, "pose-strip.png"))
    print("pose-strip.png", img.size)


# ---------------- face patch strip ----------------
def face_strip():
    tiles = [("A.png", "A — mouth open"), ("O.png", "O — round lips"),
             ("E.png", "E — big smile"), ("blink.png", "BLINK — eyes shut")]
    cell_w, H = 330, 300
    W = cell_w * len(tiles)
    img = Image.new("RGB", (W, H), (247, 234, 215))
    d = ImageDraw.Draw(img)
    f = font(SANS_B, 25)
    for i, (file, label) in enumerate(tiles):
        cx = i * cell_w
        t = Image.open(os.path.join(PACKS, "swapnil", "talk", file)).convert("RGBA")
        scale = min(230 / t.width, 150 / t.height)
        t = t.resize((round(t.width * scale), round(t.height * scale)), Image.LANCZOS)
        d.rectangle([cx + 40, 36, cx + cell_w - 40, 206], fill=(255, 248, 234), outline=INK, width=3)
        img.paste(t, (cx + (cell_w - t.width) // 2, 40 + (160 - t.height) // 2), t)
        tw = d.textlength(label, font=f)
        d.text((cx + (cell_w - tw) / 2, 228), label, font=f, fill=INK)
    img.save(os.path.join(OUT, "face-strip.png"))
    print("face-strip.png", img.size)


if __name__ == "__main__":
    hero(); cast_lineup(); pose_strip(); face_strip()
