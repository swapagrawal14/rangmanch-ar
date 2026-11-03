/* Synthetic landmark fixtures for the v2.2 gesture classifier — each is
   what MediaPipe would report for one gesture, built with synth.js on a
   640x480 front camera, mapped onto the 720x1280 phone stage exactly as the
   app maps it (cover-fit, mirrored). */
import { synthFace, synthHand } from '../synth.js';
export const STAGE = { W: 720, H: 1280 };
const A = 4 / 3, sw = STAGE.H * A, ox = (STAGE.W - sw) / 2;
export const toPx = p => ({ x: ox + (1 - p.x) * sw, y: p.y * STAGE.H });
export const px = arr => arr.map(p => (p ? toPx(p) : p));

/* selfie face: centre x 0.5, y 0.32, face width 0.16 of the camera width */
export function face(o = {}) { const w = o.w || 0.16; return synthFace({ x: 0.5, y: 0.32, w, aspect: A, ...o }); }
export function geom(o = {}) {
  const w = o.w || 0.16, x = o.x || 0.5, y = o.y || 0.32;
  return { w, x, y, mouth: { x, y: y + 0.315 * w * A }, chin: { x, y: y + 0.62 * w * A }, eye: { x, y: y - 0.15 * w * A }, fore: { x, y: y - 0.62 * w * A } };
}
const hand = o => synthHand({ aspect: A, ...o });

/* each fixture: { face, hands } in camera space, scale s = face width */
export function fixture(name, s = 1) {
  const w = 0.16 * s, G = geom({ w }), hs = w * 0.55;
  const F = face({ w });
  switch (name) {
    case 'mouth': return { face: F, hands: [hand({ x: G.x - w * 0.12, y: G.mouth.y + hs * 0.55 * A, size: hs, angle: 0.35, shape: 'flat' })] };
    case 'shh': return { face: F, hands: [hand({ x: G.x + w * 0.02, y: G.mouth.y + hs * 1.75 * A, size: hs, angle: 0, shape: 'point' })] };
    case 'think': return { face: F, hands: [hand({ x: G.x - w * 0.12, y: G.chin.y + hs * 0.95 * A, size: hs, angle: 0.3, shape: 'fist' })] };
    case 'think-cheek': return { face: F, hands: [hand({ x: G.x - w * 0.62, y: G.y + hs * 0.9 * A, size: hs, angle: 0.15, shape: 'flat' })] };
    case 'facepalm': return { face: F, hands: [hand({ x: G.x + w * 0.05, y: G.eye.y + hs * 0.7 * A, size: hs, angle: -0.1, shape: 'flat' })] };
    case 'salute': return { face: F, hands: [hand({ x: G.x - w * 1.1, y: G.eye.y + hs * 0.25 * A, size: hs, angle: 1.25, shape: 'flat' })] };
    case 'cover': return { face: F, hands: [
      hand({ x: G.x - w * 0.18, y: G.y + hs * 0.55 * A, size: hs, angle: 0.1, shape: 'flat' }),
      hand({ x: G.x + w * 0.18, y: G.y + hs * 0.55 * A, size: hs, angle: -0.1, shape: 'flat', thumbSide: 1 })] };
    case 'head': return { face: F, hands: [
      hand({ x: G.x - w * 0.55, y: G.fore.y - hs * 0.05 * A, size: hs, angle: 0.9, shape: 'flat' }),
      hand({ x: G.x + w * 0.55, y: G.fore.y - hs * 0.05 * A, size: hs, angle: -0.9, shape: 'flat', thumbSide: 1 })] };
    case 'namaste': return { face: F, hands: [
      hand({ x: G.x - w * 0.06, y: G.chin.y + hs * 2.4 * A, size: hs, angle: 0.08, shape: 'flat' }),
      hand({ x: G.x + w * 0.06, y: G.chin.y + hs * 2.4 * A, size: hs, angle: -0.08, shape: 'flat', thumbSide: 1 })] };
    case 'apart': return { face: F, hands: [
      hand({ x: G.x - w * 0.9, y: G.chin.y + hs * 2.4 * A, size: hs, angle: 0.5, shape: 'flat' }),
      hand({ x: G.x + w * 0.9, y: G.chin.y + hs * 2.4 * A, size: hs, angle: -0.5, shape: 'flat', thumbSide: 1 })] };
    case 'fist': return { face: F, hands: [hand({ x: G.x + w * 1.6, y: G.y + hs * 0.2 * A, size: hs, angle: 0, shape: 'fist' })] };
    case 'thumbs': return { face: F, hands: [hand({ x: G.x + w * 1.4, y: G.chin.y + hs * 1.6 * A, size: hs, angle: -Math.PI / 2, shape: 'thumbs' })] };
    case 'point': return { face: F, hands: [hand({ x: G.x - w * 1.6, y: G.chin.y + hs * 1.2 * A, size: hs, angle: Math.PI / 2, shape: 'point' })] };
    case 'palm': return { face: F, hands: [hand({ x: G.x - w * 1.6, y: G.y, size: hs, angle: 0, shape: 'open' })] };
    case 'rest': return { face: F, hands: [hand({ x: G.x - w * 1.2, y: 0.95, size: hs, angle: Math.PI, shape: 'open' })] };
    case 'none': return { face: F, hands: [] };
  }
  throw new Error('no fixture ' + name);
}
