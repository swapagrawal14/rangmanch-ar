/* Rangmanch AR v2.2 — the head follows you.
   1. HeadTracker: roll (tilt), yaw (turn) and pitch (nod) from FaceLandmarker
      points in stage space, smoothed with a One Euro filter (almost no lag
      when you move, steady when you hold still), plus nod / head-shake
      detection from the rhythm of pitch and yaw.
   2. warpPoint: the 2.5D head warp, one smooth displacement field over the
      whole drawing. Inside the head ellipse the head rotates about the neck
      pivot, shifts and squashes a little with yaw/pitch, and the face
      features (eyes + mouth tiles, already composited) slide further than
      the outline, which is what makes a flat drawing read as turning.
      The weight falls to zero before the shoulders, so there is no seam and
      nothing is cut: the neck simply bends.
   3. HeadWarpGL: the same field on a WebGL grid mesh (the shader is a line-
      for-line copy of warpPoint; tests check the JS version). */

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ss = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

export class OneEuro {
  constructor(minCutoff = 1.0, beta = 0.02, dCutoff = 1.0) { this.mc = minCutoff; this.beta = beta; this.dc = dCutoff; this.x = null; this.dx = 0; this.t = 0; }
  snap(x) { this.x = x; this.dx = 0; }
  filter(x, t) {
    if (this.x === null) { this.x = x; this.t = t; return x; }
    const dt = Math.max(1 / 240, Math.min(0.1, ((t - this.t) / 1000) || (1 / 60))); this.t = t;
    const aD = 1 / (1 + 1 / (2 * Math.PI * this.dc * dt));
    this.dx += aD * ((x - this.x) / dt - this.dx);
    const cutoff = this.mc + this.beta * Math.abs(this.dx);
    const a = 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
    this.x += a * (x - this.x);
    return this.x;
  }
}

/* Raw head angles from stage-px landmarks (mirrored view):
   roll  radians, +: the head tilts clockwise on stage
   yaw   -1..1,  +: the nose turns toward stage right
   pitchRaw      nose height in the face (relative; the tracker removes
                 your own neutral so a nod reads the same for everyone) */
export function rawHeadAngles(f) {
  const p = i => f[i];
  if (!f || !p(33) || !p(263) || !p(1) || !p(234) || !p(454) || !p(10) || !p(152)) return null;
  const a = p(33), b = p(263);
  const l = a.x < b.x ? a : b, r = a.x < b.x ? b : a;
  const roll = Math.atan2(r.y - l.y, r.x - l.x);
  // measure yaw/pitch in the head's own frame (undo the roll first)
  const c = { x: (p(234).x + p(454).x) / 2, y: (p(234).y + p(454).y) / 2 };
  const un = q => { const dx = q.x - c.x, dy = q.y - c.y, cs = Math.cos(-roll), sn = Math.sin(-roll); return { x: c.x + dx * cs - dy * sn, y: c.y + dx * sn + dy * cs }; };
  const A = un(p(234)), B = un(p(454)), N = un(p(1)), T = un(p(10)), C = un(p(152));
  const L = Math.min(A.x, B.x), R = Math.max(A.x, B.x);
  if (R - L < 4) return null;
  const yaw = clamp(((N.x - L) / (R - L) - 0.5) * 2.4, -1, 1);
  const top = Math.min(T.y, C.y), bot = Math.max(T.y, C.y);
  if (bot - top < 4) return null;
  const pitchRaw = (N.y - top) / (bot - top);
  return { roll, yaw, pitchRaw };
}

export class HeadTracker {
  constructor() {
    this.f = { roll: new OneEuro(2.2, 0.35), yaw: new OneEuro(2.2, 0.6), pitch: new OneEuro(2.2, 0.6) };
    this.base = null; this.hist = []; this.gest = null; this.gestUntil = 0;
    this.roll = 0; this.yaw = 0; this.pitch = 0; this.live = false; this.lastAt = 0;
  }
  reset() { this.base = null; this.hist = []; this.gest = null; this.live = false; for (const k in this.f) this.f[k].x = null; }
  update(lm, now) {
    const r = lm ? rawHeadAngles(lm) : null;
    if (!r) {
      // face lost: ease back to neutral, never freeze mid-tilt
      if (now - this.lastAt > 400) { this.roll *= 0.9; this.yaw *= 0.9; this.pitch *= 0.9; this.live = false; }
      return this;
    }
    this.lastAt = now; this.live = true;
    // your own neutral nose height, learned slowly (a held nod is not neutral)
    if (this.base === null) this.base = r.pitchRaw;
    else this.base += (r.pitchRaw - this.base) * 0.004;
    const pitch = clamp((r.pitchRaw - this.base) * 6, -1, 1);
    this.roll = this.f.roll.filter(clamp(r.roll, -0.6, 0.6), now);
    this.yaw = this.f.yaw.filter(r.yaw, now);
    this.pitch = this.f.pitch.filter(pitch, now);
    this.hist.push({ t: now, yaw: this.yaw, pitch: this.pitch });
    while (this.hist.length && now - this.hist[0].t > 1300) this.hist.shift();
    const nod = swings(this.hist, 'pitch', 0.16), shake = swings(this.hist, 'yaw', 0.22);
    if (shake >= 2 && shake >= nod) { this.gest = 'shake'; this.gestUntil = now + 500; }
    else if (nod >= 2) { this.gest = 'nod'; this.gestUntil = now + 500; }
    else if (now > this.gestUntil) this.gest = null;
    return this;
  }
  /* What the drawing performs: a detected nod / shake is exaggerated so it
     reads on a small cartoon face; otherwise the head follows 1:1. */
  params() {
    const gy = this.gest === 'shake' ? 1.45 : 1, gp = this.gest === 'nod' ? 1.6 : 1;
    return { roll: this.roll, yaw: clamp(this.yaw * gy, -1, 1), pitch: clamp(this.pitch * gp, -1, 1), gest: this.gest };
  }
}

/* Direction reversals of one axis with at least `amp` travel between them. */
export function swings(hist, key, amp) {
  if (!hist.length) return 0;
  let n = 0, dir = 0, ext = hist[0][key], lo = ext, hi = ext;
  for (let i = 1; i < hist.length; i++) {
    const v = hist[i][key];
    if (dir === 0) {
      lo = Math.min(lo, v); hi = Math.max(hi, v);
      if (v - lo >= amp) { dir = 1; ext = v; } else if (hi - v >= amp) { dir = -1; ext = v; }
    } else if (dir === 1) {
      if (v > ext) ext = v; else if (ext - v >= amp) { n++; dir = -1; ext = v; }
    } else {
      if (v < ext) ext = v; else if (v - ext >= amp) { n++; dir = 1; ext = v; }
    }
  }
  return n;
}

/* The head warp. p: drawing-pixel point; H: {c:[x,y], r:[rx,ry], pivot:[x,y]};
   k: {roll, yaw, pitch}. Returns the displaced point. */
export const WARP = { headIn: 0.9, headOut: 1.45, neckA: 0.2, neckB: 0.35, shiftX: 0.10, shiftY: 0.09, featX: 0.18, featY: 0.17, squashX: 0.07, squashY: 0.05, featR: 0.9, outRoll: 2.0, outYaw: 0.25 };
export function warpPoint(p, H, k) {
  const cx = H.c[0], cy = H.c[1], rx = H.r[0], ry = H.r[1], px = H.pivot[0], py = H.pivot[1];
  const dx = (p[0] - cx) / rx, dy = (p[1] - cy) / ry, n = Math.sqrt(dx * dx + dy * dy);
  // the falloff widens with the tilt, so a big tilt never folds the drawing
  // beside the head (a small one keeps a raised hand next to the head still)
  const out = WARP.headOut + WARP.outRoll * Math.abs(k.roll) + WARP.outYaw * Math.abs(k.yaw);
  const w = (1 - ss(WARP.headIn, out, n)) * (1 - ss(py - WARP.neckA * ry, py + WARP.neckB * ry, p[1]));
  if (w <= 0) return [p[0], p[1]];
  const sqx = 1 - WARP.squashX * Math.abs(k.yaw), sqy = 1 - WARP.squashY * Math.abs(k.pitch);
  const lx = (p[0] - cx) * sqx + (cx - px), ly = (p[1] - cy) * sqy + (cy - py);
  const cs = Math.cos(k.roll), sn = Math.sin(k.roll);
  const qx = px + cs * lx - sn * ly + k.yaw * WARP.shiftX * rx;
  const qy = py + sn * lx + cs * ly + k.pitch * WARP.shiftY * ry;
  const f = 1 - ss(0, WARP.featR, n);
  const fx = k.yaw * WARP.featX * rx, fy = k.pitch * WARP.featY * ry;
  const fsx = cs * fx - sn * fy, fsy = sn * fx + cs * fy;
  return [p[0] + w * (qx - p[0]) + f * w * fsx, p[1] + w * (qy - p[1]) + f * w * fsy];
}

const VS = `
attribute vec2 aP;
uniform vec2 uSize, uPad, uC, uR, uPiv;
uniform float uRoll, uYaw, uPitch;
uniform float W[13];
varying vec2 vUV;
float ss(float a, float b, float x) { float t = clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
void main() {
  vec2 p = aP - uPad;
  vec2 d = (p - uC) / uR; float n = length(d);
  float w = (1.0 - ss(W[0], W[1] + W[11] * abs(uRoll) + W[12] * abs(uYaw), n)) * (1.0 - ss(uPiv.y - W[2] * uR.y, uPiv.y + W[3] * uR.y, p.y));
  float sqx = 1.0 - W[8] * abs(uYaw), sqy = 1.0 - W[9] * abs(uPitch);
  vec2 l = vec2((p.x - uC.x) * sqx + (uC.x - uPiv.x), (p.y - uC.y) * sqy + (uC.y - uPiv.y));
  float cs = cos(uRoll), sn = sin(uRoll);
  vec2 q = uPiv + vec2(cs * l.x - sn * l.y, sn * l.x + cs * l.y) + vec2(uYaw * W[4] * uR.x, uPitch * W[5] * uR.y);
  float f = 1.0 - ss(0.0, W[10], n);
  vec2 fe = vec2(uYaw * W[6] * uR.x, uPitch * W[7] * uR.y);
  vec2 fs = vec2(cs * fe.x - sn * fe.y, sn * fe.x + cs * fe.y);
  vec2 o = p + w * (q - p) + f * w * fs + uPad;
  vUV = aP / uSize;
  gl_Position = vec4(o.x / uSize.x * 2.0 - 1.0, 1.0 - o.y / uSize.y * 2.0, 0.0, 1.0);
}`;
const FS = `
precision mediump float;
uniform sampler2D uTex; varying vec2 vUV;
void main() { gl_FragColor = texture2D(uTex, vUV); }`;

export class HeadWarpGL {
  constructor() {
    this.cv = (typeof document !== 'undefined') ? document.createElement('canvas') : null;
    this.gl = null; this.ok = false;
    try {
      const gl = this.cv && this.cv.getContext('webgl', { premultipliedAlpha: true, alpha: true, preserveDrawingBuffer: true, antialias: false });
      if (!gl) return;
      const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; };
      const pr = gl.createProgram();
      gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(pr);
      if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error('link');
      gl.useProgram(pr);
      this.u = {}; for (const n of ['uSize', 'uPad', 'uC', 'uR', 'uPiv', 'uRoll', 'uYaw', 'uPitch', 'uTex', 'W']) this.u[n] = gl.getUniformLocation(pr, n);
      gl.uniform1fv(this.u.W, [WARP.headIn, WARP.headOut, WARP.neckA, WARP.neckB, WARP.shiftX, WARP.shiftY, WARP.featX, WARP.featY, WARP.squashX, WARP.squashY, WARP.featR, WARP.outRoll, WARP.outYaw]);
      this.aP = gl.getAttribLocation(pr, 'aP');
      this.tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      this.vb = gl.createBuffer(); this.ib = gl.createBuffer();
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      this.gl = gl; this.ok = true; this.meshFor = null;
    } catch (e) { this.ok = false; }
  }
  mesh(Wd, Hd) {
    const gl = this.gl, key = Wd + 'x' + Hd;
    if (this.meshFor === key) return;
    const nx = 48, ny = 60, v = [], idx = [];
    for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) v.push(i / nx * Wd, j / ny * Hd);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vb); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), gl.STATIC_DRAW);
    this.nIdx = idx.length; this.meshFor = key;
  }
  /* src: a canvas holding the drawing with `pad` px of margin on every side. */
  /* upload=false reuses the drawing already on the GPU (the composite only
     changes when the pose or a face tile changes, not every frame). */
  render(src, pad, H, k, upload = true) {
    if (!this.ok) return null;
    const gl = this.gl, Wd = src.width, Hd = src.height;
    if (this.cv.width !== Wd || this.cv.height !== Hd) { this.cv.width = Wd; this.cv.height = Hd; upload = true; }
    this.mesh(Wd, Hd);
    gl.viewport(0, 0, Wd, Hd); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    if (upload || !this.hasTex) { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src); this.hasTex = true; }
    gl.uniform2f(this.u.uSize, Wd, Hd); gl.uniform2f(this.u.uPad, pad, pad);
    gl.uniform2f(this.u.uC, H.c[0], H.c[1]); gl.uniform2f(this.u.uR, H.r[0], H.r[1]); gl.uniform2f(this.u.uPiv, H.pivot[0], H.pivot[1]);
    gl.uniform1f(this.u.uRoll, k.roll); gl.uniform1f(this.u.uYaw, k.yaw); gl.uniform1f(this.u.uPitch, k.pitch);
    gl.uniform1i(this.u.uTex, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vb); gl.enableVertexAttribArray(this.aP); gl.vertexAttribPointer(this.aP, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ib);
    gl.drawElements(gl.TRIANGLES, this.nIdx, gl.UNSIGNED_SHORT, 0);
    return this.cv;
  }
}
