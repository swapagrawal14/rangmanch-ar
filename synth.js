/* Rangmanch AR v2.2 — synthetic MediaPipe landmarks (camera-normalised, like
   the real models emit) for Demo Mode and the tests. Geometry is built in a
   local frame in camera pixels and normalised with the camera aspect, so a
   synthetic face or hand has true proportions on the stage. */

/* A face: x, y = face centre (normalised), w = face width (normalised x),
   roll radians (camera space), yaw/pitch -1..1. Fills the landmarks the app
   reads: 1 nose, 10 forehead, 152 chin, 234/454 cheeks, 33/263 eye corners,
   13/14 lips, 78/308 mouth corners. */
export function synthFace({ x = 0.5, y = 0.3, w = 0.25, roll = 0, yaw = 0, pitch = 0, aspect = 4 / 3, mouthOpen = 0 } = {}) {
  const L = {
    1: [yaw * 0.25, 0.04 + pitch * 0.16], 10: [0, -0.62], 152: [0, 0.62 - Math.abs(pitch) * 0.04],
    234: [-0.5 + Math.max(0, yaw) * 0.08, 0], 454: [0.5 + Math.min(0, yaw) * 0.08, 0],
    33: [-0.3 + yaw * 0.12, -0.15 + pitch * 0.05], 263: [0.3 + yaw * 0.12, -0.15 + pitch * 0.05],
    13: [yaw * 0.16, 0.3 + pitch * 0.08], 14: [yaw * 0.16, 0.33 + pitch * 0.08 + mouthOpen * 0.12],
    78: [-0.15 + yaw * 0.16, 0.315 + pitch * 0.08], 308: [0.15 + yaw * 0.16, 0.315 + pitch * 0.08]
  };
  const cs = Math.cos(roll), sn = Math.sin(roll), out = [];
  for (let i = 0; i < 468; i++) out.push({ x, y, z: 0 });
  for (const k in L) {
    const [lx, ly] = L[k];
    const rx = (cs * lx - sn * ly) * w, ry = (sn * lx + cs * ly) * w;
    out[k] = { x: x + rx, y: y + ry * aspect, z: 0 };
  }
  return out;
}

/* A hand: wrist at x, y (normalised); size = wrist -> middle knuckle
   (normalised x); angle radians, 0 = fingers up (camera space, clockwise +).
   shape: open | fist | point | thumbs | flat (fingers together). */
export function synthHand({ x = 0.5, y = 0.6, size = 0.08, angle = 0, shape = 'open', aspect = 4 / 3, thumbSide = -1 } = {}) {
  const u = [Math.sin(angle), -Math.cos(angle)], v = [Math.cos(angle), Math.sin(angle)];
  const P = (a, b) => ({ x: x + (u[0] * a + v[0] * b * thumbSide * -1) * size, y: y + (u[1] * a + v[1] * b * thumbSide * -1) * size * aspect, z: 0 });
  const h = new Array(21);
  h[0] = P(0, 0);
  const offs = shape === 'flat' ? [-0.18, -0.06, 0.06, 0.18] : [-0.3, -0.1, 0.1, 0.3];
  const ext = { open: [1, 1, 1, 1], flat: [1, 1, 1, 1], fist: [0, 0, 0, 0], point: [1, 0, 0, 0], thumbs: [0, 0, 0, 0] }[shape] || [1, 1, 1, 1];
  for (let f = 0; f < 4; f++) {
    const b = 5 + f * 4, o = offs[f], len = f === 3 ? 0.75 : 1;
    h[b] = P(0.95 - Math.abs(o) * 0.15, o);
    if (ext[f]) { h[b + 1] = P(1.3 * len, o * 1.05); h[b + 2] = P(1.55 * len, o * 1.1); h[b + 3] = P(1.8 * len, o * 1.12); }
    else { h[b + 1] = P(1.15, o); h[b + 2] = P(0.95, o * 0.95); h[b + 3] = P(0.72, o * 0.9); }
  }
  if (shape === 'thumbs') { // thumb straight up on screen, whatever the hand angle
    const k = h[5], up = (a) => ({ x: k.x, y: k.y - a * size * aspect, z: 0 });
    h[1] = P(0.35, -0.3); h[2] = up(0.35); h[3] = up(0.7); h[4] = up(1.05);
  }
  else if (shape === 'open') { h[1] = P(0.25, -0.35); h[2] = P(0.45, -0.6); h[3] = P(0.6, -0.8); h[4] = P(0.75, -0.98); }
  else { h[1] = P(0.25, -0.3); h[2] = P(0.45, -0.42); h[3] = P(0.65, -0.38); h[4] = P(0.8, -0.25); }
  return h;
}
