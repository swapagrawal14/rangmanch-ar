"""Head region + neck pivot for a pose drawing (v2.2 head follow).

The app tilts, turns and nods the character's head with a smooth mesh warp
that is confined to this region: full movement inside the head ellipse,
fading to nothing before the shoulders, so there is never a seam. The region
is measured once on the base drawing (face anchors + the drawing's own alpha
silhouette) and carried onto every pose drawing through that pose's face
anchor and drawing scale."""
import numpy as np
from PIL import Image

# Per-pack shape hints where the silhouette alone misleads (big robot screen
# heads, a cat in a hood, a pineapple crown). Factors on the measured values.
HINTS = {
    'bunty': {'rx': 1.3, 'chin': 1.25},
    'mocha': {'rx': 1.1, 'chin': 0.7},
    'puni': {'nowarp': True},   # the whole body is the face: no separate head
    'pia': {'nowarp': True},

}


def base_head(alpha, mouth, eyes, blink_w, pid=''):
    """alpha: HxW float array of the base drawing. Returns dict c, r, pivot."""
    H, W = alpha.shape
    ex, ey = eyes; mx, my = mouth
    d = max(20.0, my - ey)
    h = HINTS.get(pid, {})
    fx = (ex + mx) / 2
    band = alpha[:, int(max(0, fx - d * 0.6)): int(min(W, fx + d * 0.6))] > 0.3
    rows = np.where(band.any(axis=1))[0]
    top = float(rows[0]) if len(rows) else ey - 2.2 * d
    top = max(top, ey - 3.2 * d)           # a tall antenna / bun is not head
    chin = my + d * h.get('chin', 0.85)
    cy = (top + chin) / 2
    ry = (chin - top) / 2
    rx = max(blink_w * 0.62, ry * 0.72) * h.get('rx', 1.0)
    rx = min(rx, ry * 1.25)
    pivot = [fx, chin + ry * 0.12]
    out = {'c': [round(fx, 1), round(cy, 1)], 'r': [round(rx, 1), round(ry, 1)], 'pivot': [round(pivot[0], 1), round(pivot[1], 1)]}
    if h.get('nowarp'):
        out['nowarp'] = True
    return out


def carry(head, base_face, pose_face, scale):
    """Map a base-drawing head region into a pose drawing whose face sits at
    pose_face with the given drawing scale (pose = base_face->pose_face, *scale)."""
    T = lambda p: [round(pose_face[0] + (p[0] - base_face[0]) * scale, 1), round(pose_face[1] + (p[1] - base_face[1]) * scale, 1)]
    out = {'c': T(head['c']), 'r': [round(head['r'][0] * scale, 1), round(head['r'][1] * scale, 1)], 'pivot': T(head['pivot'])}
    if head.get('nowarp'):
        out['nowarp'] = True
    return out


def load_alpha(path):
    return np.asarray(Image.open(path).convert('RGBA'))[..., 3].astype(np.float32) / 255.0
