'use strict';
/* Rangmanch AR v2.0 — one-person cartoon studio.
   You act; the character performs. The lead is the pack's own authored art —
   complete gesture poses drawn on one canvas — switched by a gesture
   classifier reading your MediaPipe pose, while your face blendshapes drive
   the A/O/E/blink tiles at each pose's hand-measured anchors (the compositing
   the family pilot proved). The figure follows your torso; breath, bob and
   blink timers keep it alive; bad tracking is refused, never drawn. Your room
   is only ever blurred colour — you are never on screen. On-device only. */

const $ = s => document.querySelector(s);
const stage = $('#stage'), ctx = stage.getContext('2d');
const cam = $('#cam'), msgEl = $('#stage-msg');
const btnCam = $('#btn-camera'), btnDemo = $('#btn-demo'), btnRec = $('#btn-record'), btnRetake = $('#btn-retake');
const downloadA = $('#download'), btnReel = $('#btn-reel');
const selLead = $('#cast-body'), selLeft = $('#cast-left'), selRight = $('#cast-right');
const selQuality = $('#quality'), captionInput = $('#caption-input'), chkCo = $('#coactors');
const statusModel = $('#status-model'), dotPose = $('#dot-pose'), dotHand = $('#dot-hand'), dotFace = $('#dot-face'), fpsEl = $('#fps');

const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MODEL = 'https://storage.googleapis.com/mediapipe-models';
const PACKS_BASE = 'assets/packs/';
const VERSION = '2.0.0';

/* ---------- cast ---------- */
const CAST = [
  ['swapnil', 'Swapnil (you!)'], ['sanjay', 'Sanjay'], ['seema', 'Seema'], ['bhavishy', 'Bhavishy'],
  ['mocha', 'Mocha the Cat'], ['bunty', 'Bunty the Bot'], ['pia', 'Pia the Pineapple'],
  ['solana', 'Solana'], ['rafi', 'Rafi'], ['kiko', 'Kiko'], ['mira', 'Mira'],
  ['bubbles', 'Bubbles'], ['luna', 'Luna'], ['puni', 'Puni'], ['static', 'Static'],
  ['doodle-swapnil', 'Doodle Swapnil']
];
const packs = {};   // id -> {manifest, img, tiles, face, poses, anchors}
const cast = { lead: 'swapnil', leftHand: 'mocha', rightHand: 'bunty' };

function loadImage(src) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
}
/* Forge pack format (character.rigpop.json): talk.base is a path, talk.files
   holds {A,O,E,blink} tile paths, talk.patches holds {key:{x,y,w,h}} rects,
   talk.poseAnchors holds hand-measured centres where available. */
async function ensurePack(id) {
  if (packs[id]) return packs[id];
  const base = PACKS_BASE + id + '/';
  const manifest = await (await fetch(base + 'character.rigpop.json')).json();
  const talk = manifest.talk || {};
  const img = {};
  if (talk.base) { try { img.base = await loadImage(base + talk.base); } catch (e) { /* missing */ } }
  const tiles = {};
  const files = talk.files || {};
  for (const key of ['A', 'O', 'E', 'blink']) {
    if (files[key]) { try { tiles[key] = await loadImage(base + files[key]); } catch (e) { /* none */ } }
  }
  const patches = talk.patches || {}, anchBase = (talk.poseAnchors || {}).base || null;
  const centre = p => p ? [p.x + p.w / 2, p.y + p.h / 2] : null;
  const face = {};
  for (const key of ['A', 'O', 'E']) if (patches[key]) face[key] = { c: (anchBase && anchBase.mouth) || centre(patches[key]), w: patches[key].w };
  if (patches.blink) face.blink = { c: (anchBase && anchBase.eyes) || centre(patches.blink), w: patches.blink.w };
  // the authored gesture poses — complete drawings, same canvas/floor line
  const poses = {};
  const poseFiles = talk.poses || {};
  for (const key of ['wave', 'point', 'open', 'thumbs']) {
    if (poseFiles[key]) { try { poses[key] = await loadImage(base + poseFiles[key]); } catch (e) { /* none */ } }
  }
  packs[id] = { manifest, img, tiles, face, poses, anchors: talk.poseAnchors || {} };
  return packs[id];
}
function updateThumb(role, id) {
  const th = document.querySelector('#thumb-' + role);
  if (th) th.src = PACKS_BASE + id + '/talk/base.png'; // every pack ships its base art
}
async function fillCastSelects() {
  for (const sel of [selLead, selLeft, selRight]) {
    sel.innerHTML = '';
    for (const [id, name] of CAST) { const o = document.createElement('option'); o.value = id; o.textContent = name; sel.appendChild(o); }
  }
  selLead.value = cast.lead; selLeft.value = cast.leftHand; selRight.value = cast.rightHand;
  for (const [id] of CAST) { try { await ensurePack(id); } catch (e) { /* offline pack */ } }
  updateThumb('body', cast.lead); updateThumb('left', cast.leftHand); updateThumb('right', cast.rightHand);
}
selLead.addEventListener('change', async () => {
  cast.lead = selLead.value;
  await ensurePack(cast.lead); updateThumb('body', cast.lead);
  state.poseName = 'base'; state.candName = null; state.candCount = 0; state.figInit = false;
});
selLeft.addEventListener('change', async () => { cast.leftHand = selLeft.value; await ensurePack(cast.leftHand); updateThumb('left', cast.leftHand); });
selRight.addEventListener('change', async () => { cast.rightHand = selRight.value; await ensurePack(cast.rightHand); updateThumb('right', cast.rightHand); });

/* Pack geometry from the REAL data files. v2.0 does not cut the illustration
   at all (the research verdict: nobody ships a runtime cut-up of a finished
   drawing) — the puppet is the pack's own authored drawings. Geometry is only
   PLACEMENT math: face proportions from the talk patches (WowKit), figure
   bounds from a single alpha scan of the base art. */
const geomCache = new WeakMap();
function packGeom(pack) {
  if (geomCache.has(pack)) return geomCache.get(pack);
  const t = pack.manifest.talk || {}, cv = t.canvas || { w: 720, h: 936 };
  const W = cv.w, H = cv.h, img = pack.img.base;
  let bbox = { x0: 0, y0: 0, x1: W, y1: H };
  try {
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, W, H);
    const d = g.getImageData(0, 0, W, H).data;
    let x0 = W, y0 = H, x1 = 0, y1 = 0;
    for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
      if (d[(y * W + x) * 4 + 3] > 12) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    if (x1 > x0 && y1 > y0) bbox = { x0, y0, x1, y1 };
  } catch (e) { /* keep full canvas */ }
  const pat = t.patches || {};
  const aB = (t.poseAnchors || {}).base || {};
  const faceCx = aB.eyes ? aB.eyes[0] : (W / 2);
  const eyeY = aB.eyes ? aB.eyes[1] : (bbox.y0 + (bbox.y1 - bbox.y0) * 0.18);
  const mouthY = aB.mouth ? aB.mouth[1] : (eyeY + 70);
  const blinkW = pat.blink ? pat.blink.w : 140;
  const headH = (mouthY - eyeY) * 3.1;
  const top = Math.max(bbox.y0, eyeY - headH * 0.74);
  const neckY = top + headH * 1.06;
  const hipY = neckY + (bbox.y1 - top) * 0.44;
  const geom = { W, H, bbox, faceCx, eyeY, mouthY, blinkW, neckY, hipY, bboxBottom: bbox.y1 };
  geomCache.set(pack, geom);
  return geom;
}

/* One Euro filter — the avatar industry's standard landmark conditioner:
   heavy smoothing when still (kills jitter), almost no lag when moving. */
class OneEuro {
  constructor(minCutoff = 1.0, beta = 0.02, dCutoff = 1.0) { this.mc = minCutoff; this.beta = beta; this.dc = dCutoff; this.x = null; this.dx = 0; this.t = 0; }
  snap(x) { this.x = x; this.dx = 0; }
  filter(x, t) {
    if (this.x === null) { this.x = x; this.t = t; return x; }
    const dt = Math.max(1 / 240, Math.min(0.1, ((t - this.t) / 1000) || (1 / 60))); this.t = t;
    const aD = 1 / (1 + 1 / (2 * Math.PI * this.dc * dt));
    const dxRaw = (x - this.x) / dt;
    this.dx += aD * (dxRaw - this.dx);
    const cutoff = this.mc + this.beta * Math.abs(this.dx);
    const a = 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
    this.x += a * (x - this.x);
    return this.x;
  }
}
function makePlacementFilters() {
  return { cx: new OneEuro(1.4, 0.04), feetY: new OneEuro(1.2, 0.03), h: new OneEuro(0.9, 0.015), roll: new OneEuro(1.8, 0.03) };
}

/* ---------- state ---------- */
const state = {
  mode: 'idle', pose: null, face: null, hands: [],
  recording: false, chunks: [], recorder: null, stream: null,
  recUrl: null, recStart: 0, quality: 'high', reel: false, bg: null,
  hpS: { yaw: 0, pitch: 0, roll: 0 }, msgAt: 0, autoBalanced: false, lowFpsSince: 0,
  poseName: 'base', candName: null, candCount: 0, poseSince: 0,
  wristHist: { a: [], b: [] }, fig: null, figInit: false, talkSm: 0, nextBlink: 0,
  leadFeetY: 0, leadH: 0,
  actors: { left: { p: 0, x: 0, talk: 0, talkT: 0, last: 0, tx: 0 }, right: { p: 0, x: 0, talk: 0, talkT: 0, last: 0, tx: 0 } }
};
const raw = { pose: null, face: null, hands: [] };

function smoothLm(prev, next, a) {
  if (!next) return prev;
  if (!prev || prev.length !== next.length) return next.map(p => ({ ...p }));
  const out = new Array(next.length);
  for (let i = 0; i < next.length; i++) {
    const p = next[i], q = prev[i];
    out[i] = { x: q.x + (p.x - q.x) * a, y: q.y + (p.y - q.y) * a, z: (q.z || 0) + ((p.z || 0) - (q.z || 0)) * a, visibility: p.visibility };
  }
  return out;
}
function smoothAll(alpha) {
  state.pose = raw.pose ? smoothLm(state.pose, raw.pose, alpha) : null; // lost body = stop, don't ghost
  state.hands = raw.hands.map((h, i) => smoothLm(state.hands[i], h, alpha));
  state.face = raw.face ? {
    landmarks: smoothLm(state.face && state.face.landmarks, raw.face.landmarks, alpha),
    cats: raw.face.cats
  } : state.face;
}

/* ---------- MediaPipe ---------- */
let poseL = null, handL = null, faceL = null, lastVideoTime = -1, frameNo = 0;
let inferErrors = 0, cpuMode = false, lastPoseAt = 0, noPoseMsgAt = 0;
async function initModels(forceCpu) {
  statusModel.textContent = 'Models: loading…';
  const { FilesetResolver, PoseLandmarker, HandLandmarker, FaceLandmarker } =
    await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs');
  const vision = await FilesetResolver.forVisionTasks(WASM);
  const mk = async (Cls, path, extra) => {
    const opts = d => Object.assign({ baseOptions: { modelAssetPath: `${MODEL}/${path}`, delegate: d }, runningMode: 'VIDEO', numPoses: 1, numHands: 2 }, extra || {});
    if (forceCpu) return await Cls.createFromOptions(vision, opts('CPU'));
    try { return await Cls.createFromOptions(vision, opts('GPU')); } catch (e) { return await Cls.createFromOptions(vision, opts('CPU')); }
  };
  poseL = await mk(PoseLandmarker, 'pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task');
  handL = await mk(HandLandmarker, 'hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task');
  faceL = await mk(FaceLandmarker, 'face_landmarker/face_landmarker/float16/1/face_landmarker.task', { outputFaceBlendshapes: true });
  statusModel.textContent = cpuMode ? 'Models: ready ✅ (CPU mode)' : 'Models: ready ✅';
}
/* Pose runs every frame (it carries the body). Face and hands alternate on
   even/odd frames — they read perfectly at half rate and the stage stays
   smooth on phone GPUs. 'High' quality runs everything every frame. */
async function infer() {
  if (!poseL || cam.readyState < 2 || cam.currentTime === lastVideoTime) return;
  lastVideoTime = cam.currentTime; frameNo++;
  const t = performance.now();
  const high = state.quality === 'high';
  try {
    const pr = poseL.detectForVideo(cam, t);
    raw.pose = pr.landmarks && pr.landmarks[0] ? pr.landmarks[0] : null;
    if (raw.pose) { lastPoseAt = performance.now(); inferErrors = 0; }
    if (high || frameNo % 2 === 0) {
      const hr = handL.detectForVideo(cam, t);
      raw.hands = hr.landmarks || [];
    }
    if (high || frameNo % 2 === 1) {
      const fr = faceL.detectForVideo(cam, t);
      if (fr.faceLandmarks && fr.faceLandmarks[0]) {
        const cats = {};
        const bs = fr.faceBlendshapes && fr.faceBlendshapes[0];
        if (bs) for (const c of bs.categories) cats[c.categoryName] = c.score;
        raw.face = { landmarks: fr.faceLandmarks[0], cats };
      } else raw.face = null;
    }
  } catch (e) {
    // a GPU delegate can initialise fine yet fail on every inference on some
    // phones — after repeated failures, rebuild the models on CPU and go on
    inferErrors++;
    if (inferErrors === 20 && !cpuMode) {
      cpuMode = true; poseL = null;
      initModels(true).catch(() => { statusModel.textContent = 'Models: failed — tap Start Camera to retry'; });
    }
  }
}

/* ---------- demo mode (synthetic performer) ---------- */
function synthDemo(t) {
  const s = t / 1000, bob = Math.sin(s * 1.6) * 0.008, wave = (Math.sin(s * 0.7) > 0.3);
  const P = [];
  for (let i = 0; i < 33; i++) P.push({ x: 0.5, y: 0.5, z: 0, visibility: 1 });
  const set = (i, x, y) => { P[i] = { x, y: y + bob, z: 0, visibility: 1 }; };
  set(0, 0.5, 0.30); set(11, 0.44, 0.38); set(12, 0.56, 0.38);
  set(23, 0.46, 0.58); set(24, 0.54, 0.58);
  set(13, 0.40, 0.50); set(15, 0.37, 0.62);
  if (wave) { set(14, 0.62, 0.30); set(16, 0.58 + Math.sin(s * 6) * 0.03, 0.16); }
  else { set(14, 0.60, 0.50); set(16, 0.63, 0.62); }
  set(25, 0.45, 0.74); set(26, 0.55, 0.74); set(27, 0.44, 0.90); set(28, 0.56, 0.90);
  raw.pose = P;
  const hand = [];
  for (let i = 0; i < 21; i++) hand.push({ x: 0.25, y: 0.6, z: 0 });
  const hx = 0.22 + Math.sin(s * 0.9) * 0.05, hy = 0.62 + Math.sin(s * 2.1) * 0.02;
  hand[0] = { x: hx, y: hy, z: 0 }; hand[9] = { x: hx + 0.01, y: hy - 0.05, z: 0 };
  const pinch = Math.sin(s * 2.4) > 0.55;
  hand[4] = { x: hx - 0.02, y: hy - 0.07, z: 0 };
  hand[8] = pinch ? { x: hx - 0.019, y: hy - 0.068, z: 0 } : { x: hx - 0.05, y: hy - 0.10, z: 0 };
  raw.hands = [hand];
  const cats = { eyeBlinkLeft: (Math.sin(s * 0.9) > 0.97) ? 0.9 : 0.02, eyeBlinkRight: 0.02, jawOpen: Math.max(0, Math.sin(s * 2.4)) * 0.55, mouthSmileLeft: 0.3, mouthSmileRight: 0.3, mouthFunnel: 0 };
  const fl = []; for (let i = 0; i < 468; i++) fl.push({ x: 0.5, y: 0.3, z: 0 });
  // a face that slowly looks left, then right — shows off the gaze tracking
  const yawA = Math.sin(s * 0.45) * 0.035;
  fl[1] = { x: 0.5 + yawA, y: 0.315, z: 0 };
  fl[33] = { x: 0.465, y: 0.30, z: 0 }; fl[263] = { x: 0.535, y: 0.30, z: 0 };
  raw.face = { landmarks: fl, cats };
}

/* ---------- stage helpers ---------- */
function setMsg(t) { msgEl.textContent = t || ''; msgEl.style.opacity = t ? '1' : '0'; state.msgAt = performance.now(); }
/* Landmarks arrive normalised to the CAMERA frame. Map them into the stage
   with the aspect preserved (fit, centred) — otherwise a landscape camera on
   the portrait reel stage would stretch the performer and detach the arms. */
const MAP = { sw: 1280, sh: 720, ox: 0, oy: 0 };
function updateMap() {
  const W = stage.width, H = stage.height;
  const srcA = (state.mode === 'camera' && cam.videoWidth) ? cam.videoWidth / cam.videoHeight : 16 / 9;
  let sw = W, sh = W / srcA;
  if (sh > H) { sh = H; sw = H * srcA; }
  MAP.sw = sw; MAP.sh = sh; MAP.ox = (W - sw) / 2; MAP.oy = (H - sh) / 2;
}
function toPx(p) { return { x: MAP.ox + (1 - p.x) * MAP.sw, y: MAP.oy + p.y * MAP.sh }; }
function mid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function headPoseRaw() {
  const fl = state.face && state.face.landmarks;
  if (!fl || !fl[1] || !fl[33] || !fl[263]) return null;
  const nose = toPx(fl[1]), e1 = toPx(fl[33]), e2 = toPx(fl[263]);
  // in the mirrored stage view, pick the canvas-left and canvas-right eyes —
  // using the raw landmark order flips the roll to 180° on a level face
  const eLft = e1.x < e2.x ? e1 : e2, eRgt = e1.x < e2.x ? e2 : e1;
  const eyeMid = mid(e1, e2), eyeDist = Math.max(10, Math.hypot(e2.x - e1.x, e2.y - e1.y));
  return {
    yaw: Math.max(-0.75, Math.min(0.75, (nose.x - eyeMid.x) / (eyeDist * 0.55))),
    pitch: Math.max(-0.55, Math.min(0.55, (nose.y - eyeMid.y) / eyeDist - 0.62)),
    roll: Math.max(-0.32, Math.min(0.32, Math.atan2(eRgt.y - eLft.y, eRgt.x - eLft.x)))
  };
}
function drawTile(img, cx, cy, w, rot) {
  if (!img) return;
  const h = w * img.naturalHeight / img.naturalWidth;
  ctx.save(); ctx.translate(cx, cy); if (rot) ctx.rotate(rot);
  ctx.drawImage(img, -w / 2, -h / 2, w, h); ctx.restore();
}
function shadow(x, y, w) {
  ctx.save(); ctx.fillStyle = 'rgba(0,0,0,0.30)';
  ctx.beginPath(); ctx.ellipse(x, y, w / 2, w * 0.09, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
}
function drawStrip(st, liveFrom, liveTo) {
  const rf = st.from, rt = st.to;
  const ra = Math.atan2(rt[1] - rf[1], rt[0] - rf[0]), la = Math.atan2(liveTo.y - liveFrom.y, liveTo.x - liveFrom.x);
  const rl = Math.hypot(rt[0] - rf[0], rt[1] - rf[1]) || 1, ll = Math.hypot(liveTo.x - liveFrom.x, liveTo.y - liveFrom.y);
  if (ll < 4) return;
  ctx.save(); ctx.translate(liveFrom.x, liveFrom.y); ctx.rotate(la - ra); ctx.scale(ll / rl, ll / rl);
  ctx.drawImage(st.img, -(rf[0] - st.box[0]), -(rf[1] - st.box[1])); ctx.restore();
}

/* ---------- the lead: the Stage Puppet (v2.0) ----------
   The research verdict, implemented: the character is NEVER cut up. It is the
   pack's own authored drawings — base + wave/point/open/thumbs, complete
   illustrations on the same canvas and floor line. Your pose landmarks drive a
   gesture classifier (with hysteresis, so it cannot flicker); your face
   blendshapes drive the A/O/E/blink tiles at the CURRENT POSE's hand-measured
   anchors — the exact compositing the delivered family pilot proved. The whole
   figure follows your torso (position, scale, lean), and a secondary-motion
   layer (breath, idle bob, talk bounce, blink timer) keeps it alive. Bad or
   missing tracking is REFUSED (hold the last good state), never drawn. */
/* Face state from the app's canonical blendshape map (inferAll converts
   MediaPipe categories into `cats` once, at capture). */
function faceState() {
  const out = { mouth: null, wide: false, blink: false, laugh: false };
  const c = (state.face && state.face.cats) || null;
  if (c) {
    const jaw = c.jawOpen || 0, smile = ((c.mouthSmileLeft || 0) + (c.mouthSmileRight || 0)) / 2;
    const stretch = c.mouthStretchLeft || 0, round = Math.max(c.mouthFunnel || 0, c.mouthPucker || 0);
    out.blink = (c.eyeBlinkLeft || 0) > 0.55 && (c.eyeBlinkRight || 0) > 0.55;
    out.laugh = jaw > 0.30 && smile > 0.45;
    if (jaw > 0.16) out.mouth = round > 0.38 ? 'O' : 'A';
    else if (smile > 0.38 || stretch > 0.30) { out.mouth = 'E'; out.wide = true; }
  }
  if (!out.mouth && state.face && state.face.landmarks) { // landmark fallback (mouth-open ratio)
    const lm = state.face.landmarks, up = lm[13], dn = lm[14], lf = lm[78], rt = lm[308];
    if (up && dn && lf && rt) {
      const wM = Math.hypot(rt.x - lf.x, rt.y - lf.y) || 1e-6;
      const ratio = Math.hypot(dn.x - up.x, dn.y - up.y) / wM;
      if (ratio > 0.30) out.mouth = 'A'; else if (ratio > 0.16) out.mouth = 'O';
    }
  }
  return out;
}
/* Head pose from landmarks (the pipeline stores landmarks + cats, no matrix):
   roll = the eye line's on-screen angle, yaw/pitch = nose offset in eye spans. */
let hpRaw = { yaw: 0, pitch: 0, roll: 0 };
function updateHeadPose() {
  const fl = state.face && state.face.landmarks;
  if (!fl || !fl[33] || !fl[263] || !fl[1]) return;
  const le = toPx(fl[33]), re = toPx(fl[263]), nose = toPx(fl[1]);
  const midE = mid(le, re);
  const span = Math.max(8, Math.hypot(re.x - le.x, re.y - le.y));
  hpRaw = {
    roll: Math.atan2(re.y - le.y, re.x - le.x),
    yaw: clamp((nose.x - midE.x) / span, -1, 1),
    pitch: clamp((nose.y - midE.y) / span - 0.32, -1, 1)
  };
  const a = 0.35;
  state.hpS.yaw += (hpRaw.yaw - state.hpS.yaw) * a;
  state.hpS.pitch += (hpRaw.pitch - state.hpS.pitch) * a;
  state.hpS.roll += (hpRaw.roll - state.hpS.roll) * a;
}

function elbowAngle(a, b, c) {
  const v1x = a.x - b.x, v1y = a.y - b.y, v2x = c.x - b.x, v2y = c.y - b.y;
  const d = (Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y)) || 1;
  return Math.acos(Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / d))) * 180 / Math.PI;
}
/* Gesture classifier: reads the performer's pose, returns the pack pose that
   matches, or null ("hold"). Only fully-visible joints count — anything else
   is refused, Kalidokit-style, instead of being followed into garbage. */
function classifyGesture() {
  const lm = state.pose, H = stage.height;
  if (!lm) return null;
  for (const i of [11, 12, 13, 14, 15, 16, 23, 24]) if ((lm[i].visibility ?? 1) < 0.45) return null;
  const p = i => toPx(lm[i]);
  const hipC = mid(p(23), p(24)), nose = p(0);
  const shoW = Math.max(30, Math.hypot(p(12).x - p(11).x, p(12).y - p(11).y));
  const mk = (si, ei, wi, hist) => {
    const sho = p(si), elb = p(ei), wri = p(wi);
    hist.push(wri.x); if (hist.length > 14) hist.shift();
    let rev = 0;
    for (let i = 2; i < hist.length; i++) { const d1 = hist[i - 1] - hist[i - 2], d2 = hist[i] - hist[i - 1]; if (d1 * d2 < 0 && Math.abs(d2) > 2) rev++; }
    return { sho, elb, wri, raised: wri.y < sho.y - H * 0.035, straight: elbowAngle(sho, elb, wri) > 152, osc: rev >= 2 };
  };
  const A = mk(11, 13, 15, state.wristHist.a), B = mk(12, 14, 16, state.wristHist.b);
  if ((A.raised && A.osc) || (B.raised && B.osc)) return 'wave';
  if (A.raised && B.raised) return 'open';
  if ((A.raised && A.wri.y < nose.y + H * 0.02) || (B.raised && B.wri.y < nose.y + H * 0.02)) return 'wave';
  const pointing = s => s.straight && Math.abs(s.wri.y - s.sho.y) < H * 0.10 && Math.abs(s.wri.x - s.sho.x) > shoW * 0.55;
  const reachA = Math.abs(A.wri.x - A.sho.x), reachB = Math.abs(B.wri.x - B.sho.x);
  if ((pointing(A) && !B.raised && reachA > reachB * 1.6) || (pointing(B) && !A.raised && reachB > reachA * 1.6)) return 'point';
  for (const h of state.hands) {
    if (!h[0] || !h[4] || !h[5] || !h[8]) continue;
    const w = toPx(h[0]), tt = toPx(h[4]), im = toPx(h[5]), it = toPx(h[8]);
    if (tt.y < w.y - H * 0.03 && it.y > im.y - H * 0.01 && w.y < hipC.y + H * 0.12) return 'thumbs';
  }
  return null;
}
function updatePoseChoice(now) {
  const cand = classifyGesture();
  if (cand === state.candName) state.candCount++; else { state.candName = cand; state.candCount = 1; }
  const need = cand ? 3 : 5; // entering a pose is fast; leaving it is steadier
  const want = cand || 'base';
  if (want !== state.poseName && state.candCount >= need && now - state.poseSince > 550) {
    state.poseName = want; state.poseSince = now;
  }
}

/* Draws the whole figure for the current pose, with face tiles composited at
   that pose's own hand-measured anchors, inside the figure's transform — so
   the face can never split from the head again. */
function drawFigure(pack, now, cx, feetY, h, roll) {
  const G = packGeom(pack);
  const img = pack.poses[state.poseName] || pack.img.base;
  if (!img) return;
  const s = h / G.H;
  const fs = faceState();
  state.talkSm += ((fs.mouth ? 1 : 0) - state.talkSm) * 0.3;
  const bob = Math.sin(now / 340) * 1.1 + state.talkSm * Math.sin(now / 85) * 1.7;
  const breath = 1 + 0.007 * Math.sin(now / 1500);
  shadow(cx, Math.min(stage.height - 5, feetY + bob * s * 8), G.W * s * 0.60);
  ctx.save();
  ctx.translate(cx, feetY + bob * s * 8); ctx.rotate(roll); ctx.scale(s, s * breath);
  ctx.drawImage(img, -G.W / 2, -G.bboxBottom, G.W, G.H);
  const anch = pack.anchors[state.poseName] || pack.anchors.base || null;
  const patches = (pack.manifest.talk || {}).patches || {};
  if (anch) {
    const lx = ax => ax - G.W / 2, ly = ay => ay - G.bboxBottom;
    const autoBlink = !state.face && now > state.nextBlink && now < state.nextBlink + 130;
    if ((fs.blink || autoBlink) && pack.tiles.blink && patches.blink && anch.eyes) {
      const tw = patches.blink.w, th = tw * pack.tiles.blink.naturalHeight / pack.tiles.blink.naturalWidth;
      ctx.drawImage(pack.tiles.blink, lx(anch.eyes[0]) - tw / 2, ly(anch.eyes[1]) - th / 2, tw, th);
    }
    const mouthKey = fs.mouth || (fs.laugh ? 'E' : null);
    if (mouthKey && pack.tiles[mouthKey] && patches[mouthKey] && anch.mouth) {
      const tw = patches[mouthKey].w * ((fs.wide || fs.laugh) ? 1.2 : 1);
      const th = tw * pack.tiles[mouthKey].naturalHeight / pack.tiles[mouthKey].naturalWidth;
      ctx.drawImage(pack.tiles[mouthKey], lx(anch.mouth[0]) - tw / 2, ly(anch.mouth[1]) - th / 2, tw, th);
    }
  }
  ctx.restore();
  if (!state.face && now > state.nextBlink + 130) state.nextBlink = now + 2400 + Math.random() * 1800;
  state.leadFeetY = feetY; state.leadH = h;
}

function drawLead(now) {
  const pack = packs[cast.lead];
  if (!pack || !pack.img.base) return;
  const W = stage.width, H = stage.height, G = packGeom(pack);
  if (!state.fig) state.fig = makePlacementFilters();
  let tcx, tFeetY, th, troll, live = false;
  const lm = state.pose;
  const hipsVis = !!(lm && lm[23] && lm[24] && (lm[23].visibility ?? 1) > 0.5 && (lm[24].visibility ?? 1) > 0.5);
  if (lm && hipsVis && lm[11] && lm[12]) {
    // full/upper body: the figure stands where you stand, sized by your torso
    updatePoseChoice(now);
    const neckC = mid(toPx(lm[11]), toPx(lm[12])), hipC = mid(toPx(lm[23]), toPx(lm[24]));
    const torsoLive = Math.max(26, Math.hypot(hipC.x - neckC.x, hipC.y - neckC.y));
    th = Math.max(H * 0.25, Math.min(H * 1.12, (G.H * torsoLive) / Math.max(60, G.hipY - G.neckY)));
    const s = th / G.H;
    tcx = hipC.x; tFeetY = hipC.y + (G.bboxBottom - G.hipY) * s;
    const tilt = Math.atan2(neckC.y - hipC.y, neckC.x - hipC.x) + Math.PI / 2;
    troll = clamp(tilt * 0.55 + state.hpS.roll * 0.25, -0.32, 0.32);
    live = true;
  } else if (state.face && state.face.landmarks) {
    // face only (the usual selfie framing): you still ARE the character —
    // head-driven placement, gesture poses hold, face fully alive
    const fl = state.face.landmarks, le = fl[33], re = fl[263];
    if (le && re) {
      const eyeSpan = Math.hypot(toPx(re).x - toPx(le).x, toPx(re).y - toPx(le).y);
      const eyeC = mid(toPx(le), toPx(re));
      th = Math.max(H * 0.3, Math.min(H * 1.6, (G.H * eyeSpan) / Math.max(20, G.blinkW)));
      const s = th / G.H;
      tcx = eyeC.x + (G.W / 2 - G.faceCx) * s;
      tFeetY = eyeC.y + (G.bboxBottom - G.eyeY) * s;
      troll = clamp(state.hpS.roll * 0.6, -0.35, 0.35);
      live = true;
    }
  }
  if (!live && lm && lm[11] && lm[12] && (lm[11].visibility ?? 1) > 0.5 && (lm[12].visibility ?? 1) > 0.5) {
    // shoulders only: scale from shoulder width, stand on the neck line
    const neckC = mid(toPx(lm[11]), toPx(lm[12]));
    const shoLive = Math.max(20, Math.hypot(toPx(lm[12]).x - toPx(lm[11]).x, toPx(lm[12]).y - toPx(lm[11]).y));
    th = Math.max(H * 0.25, Math.min(H * 1.3, (G.H * shoLive) / (G.blinkW * 1.86)));
    const s = th / G.H;
    tcx = neckC.x; tFeetY = neckC.y + (G.bboxBottom - G.neckY) * s;
    troll = clamp(state.hpS.roll * 0.3, -0.3, 0.3);
    live = true;
  }
  if (!live) { // idle stage pose
    tcx = W / 2; th = H * 0.92; tFeetY = H - 6; troll = 0;
    if (state.poseName !== 'base') { state.poseName = 'base'; state.poseSince = now; }
  }
  if (!state.figInit) { // snap on the first frame / after a cast change
    state.fig.cx.snap(tcx); state.fig.feetY.snap(tFeetY); state.fig.h.snap(th); state.fig.roll.snap(troll);
    state.figInit = true;
  }
  const cx = state.fig.cx.filter(tcx, now), feetY = state.fig.feetY.filter(tFeetY, now);
  const h = state.fig.h.filter(th, now), roll = state.fig.roll.filter(troll, now);
  drawFigure(pack, now, cx, feetY, h, roll);
}

/* ---------- co-actors: your hands conduct them, full-size on the floor ---------- */
function drawCoActors(now) {
  const W = stage.width, H = stage.height;
  for (const h of state.hands) {
    if (!h[9]) continue;
    const mcp = toPx(h[9]);
    const a = state.actors[mcp.x < W / 2 ? 'left' : 'right'];
    a.tx = mcp.x; a.last = now;
    a.talkT = Math.hypot(h[4].x - h[8].x, h[4].y - h[8].y) < 0.045 ? 1 : 0;
  }
  for (const sideName of ['left', 'right']) {
    const a = state.actors[sideName];
    const pack = packs[sideName === 'left' ? cast.leftHand : cast.rightHand];
    a.p += (((now - a.last < 900) ? 1 : 0) - a.p) * 0.07;
    a.talk += ((a.talkT || 0) - a.talk) * 0.3;
    if (!pack || !pack.img.base || a.p < 0.02) continue;
    if (!a.x) a.x = a.tx || W / 2;
    a.x += ((a.tx || a.x) - a.x) * 0.12;
    const img = pack.img.base;
    // sidekicks scale with the lead, not the frame — vital in 9:16 reel mode
    const fullH = (state.leadH || H * 0.7) * 0.72, h = fullH * (0.25 + 0.75 * a.p);
    const w = h * img.naturalWidth / img.naturalHeight;
    const floorY = state.leadFeetY || (H - 4); // stand on the lead's floor line, not the frame edge
    const feetY = floorY + (1 - a.p) * fullH * 0.75;
    const bobA = Math.sin(now / 300 + (sideName === 'left' ? 0 : 2)) * 3 + (a.talk > 0.5 ? Math.sin(now / 60) * 4 : 0);
    ctx.save(); ctx.globalAlpha = Math.min(1, a.p * 1.6);
    shadow(a.x, Math.min(H - 4, feetY), w * 0.75);
    ctx.translate(a.x, feetY + bobA * a.p);
    ctx.rotate(Math.max(-0.08, Math.min(0.08, ((a.tx || a.x) - a.x) * 0.0009)));
    ctx.drawImage(img, -w / 2, -h, w, h);
    ctx.restore();
    if (a.talk > 0.5 && pack.tiles.O && pack.face && pack.face.O) {
      ctx.save(); ctx.globalAlpha = Math.min(1, a.p * 1.6);
      drawTile(pack.tiles.O,
        a.x - w / 2 + pack.face.O.c[0] / img.naturalWidth * w,
        feetY + bobA * a.p - h + pack.face.O.c[1] / img.naturalHeight * h,
        pack.face.O.w * (w / img.naturalWidth) * 1.15, 0);
      ctx.restore();
    }
  }
}

/* ---------- render loop ---------- */
function fitStage() {
  const w = state.reel ? 720 : 1280, h = state.reel ? 1280 : 720;
  if (stage.width !== w) { stage.width = w; stage.height = h; }
}
function roundRectPath(x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
let fpsFrames = 0, fpsLast = 0, fpsEMA = 60, lastFrameT = 0;
function loop(ts) {
  requestAnimationFrame(loop);
  fitStage();
  updateMap();
  if (lastFrameT) fpsEMA += ((1000 / Math.max(1, ts - lastFrameT)) - fpsEMA) * 0.05;
  lastFrameT = ts;
  if (state.mode === 'camera') infer();
  if (state.mode === 'demo') synthDemo(ts || 0);
  smoothAll(state.mode === 'idle' ? 1 : 0.62);
  const W = stage.width, H = stage.height;
  ctx.clearRect(0, 0, W, H);
  if (state.mode === 'camera' && cam.readyState >= 2) {
    // your room stays as soft blurred colour. YOU are gone: fully replaced.
    if (!state.bg) { state.bg = document.createElement('canvas'); state.bg.width = 192; state.bg.height = 108; }
    const bgc = state.bg.getContext('2d');
    const vw = cam.videoWidth, vh = cam.videoHeight, s = Math.max(192 / vw, 108 / vh);
    bgc.save(); bgc.translate(192, 0); bgc.scale(-1, 1);
    bgc.drawImage(cam, (192 - vw * s) / 2, (108 - vh * s) / 2, vw * s, vh * s); bgc.restore();
    ctx.save(); ctx.imageSmoothingEnabled = true;
    ctx.filter = 'blur(16px)'; // backdrop is pure colour wash — nobody is recognisable in it
    ctx.drawImage(state.bg, -24, -24, W + 48, H + 48);
    ctx.filter = 'none';
    ctx.fillStyle = 'rgba(26,9,13,0.42)'; ctx.fillRect(0, 0, W, H);
    const fg = ctx.createLinearGradient(0, H * 0.8, 0, H);
    fg.addColorStop(0, 'rgba(40,20,10,0)'); fg.addColorStop(1, 'rgba(40,20,10,0.55)');
    ctx.fillStyle = fg; ctx.fillRect(0, H * 0.8, W, H * 0.2); ctx.restore();
  } else {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#3d1522'); g.addColorStop(0.75, '#2b1219'); g.addColorStop(1, '#59331f');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#6d4423'; ctx.fillRect(0, H * 0.94, W, H * 0.06);
  }
  drawLead(ts || performance.now());
  if (state.mode !== 'idle' && chkCo.checked) drawCoActors(ts || 0);
  // honest guidance: camera is on but no body found — say what to do
  if (state.mode === 'camera' && poseL && !state.pose && performance.now() - lastPoseAt > 2500 && (ts || 0) - noPoseMsgAt > 7000) {
    noPoseMsgAt = ts || 0;
    setMsg('I can\'t see your body yet — hold the phone further back so your shoulders and waist are in frame. (Face-only works too: your face alone drives the head, mouth and blinks.)');
  }
  if (captionInput.value.trim()) {
    const txt = captionInput.value.trim();
    ctx.save(); ctx.font = `700 ${Math.round(H * 0.045)}px 'Space Grotesk', sans-serif`;
    ctx.textAlign = 'center';
    const tw = ctx.measureText(txt).width + 44, th = H * 0.075;
    ctx.fillStyle = 'rgba(20,8,10,0.72)';
    roundRectPath(W / 2 - tw / 2, H - th - H * 0.035, tw, th, 14); ctx.fill();
    ctx.fillStyle = '#ffe9b8'; ctx.textBaseline = 'middle';
    ctx.fillText(txt, W / 2, H - th / 2 - H * 0.035); ctx.restore();
  }
  if (state.recording) {
    const s = Math.floor((Date.now() - state.recStart) / 1000);
    btnRec.textContent = `■ ${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')} — Stop & Save`;
  }
  if (msgEl.textContent && performance.now() - state.msgAt > 7000) msgEl.style.opacity = '0';
  dotPose.classList.toggle('on', !!state.pose);
  dotHand.classList.toggle('on', state.hands.length > 0);
  dotFace.classList.toggle('on', !!state.face);
  fpsFrames++;
  if (ts - fpsLast > 1000) { fpsEl.textContent = Math.round(fpsEMA) + ' fps'; fpsFrames = 0; fpsLast = ts; }
  // auto-quality: if the stage struggles, shed load once and say so in the ticket
  if (state.mode === 'camera' && !state.autoBalanced && fpsEMA < 17 && state.quality === 'high') {
    if (!state.lowFpsSince) state.lowFpsSince = ts;
    if (ts - state.lowFpsSince > 5000) {
      state.quality = 'balanced'; selQuality.value = 'balanced'; state.autoBalanced = true;
      statusModel.textContent = 'Models: ready ✅ (auto-balanced for smoothness)';
    }
  } else state.lowFpsSince = 0;
}

/* ---------- controls ---------- */
btnCam.addEventListener('click', async () => {
  try {
    if (!poseL) await initModels();
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: true });
    cam.srcObject = stream; await cam.play();
    state.stream = stream; state.mode = 'camera';
    btnCam.textContent = '📷 Camera On ✅'; btnDemo.textContent = '🪄 Demo Mode'; btnRec.disabled = false;
    setMsg('You are live — and fully replaced. Look around, talk, laugh, dance: the character does it all with you.');
  } catch (e) {
    statusModel.textContent = 'Models: failed to load — check connection, tap Start Camera to retry';
    poseL = null;
    setMsg('Something blocked the stage: ' + e.message + ' — try again, or use Demo Mode.');
  }
});
btnDemo.addEventListener('click', () => {
  state.mode = state.mode === 'demo' ? 'idle' : 'demo';
  btnDemo.textContent = state.mode === 'demo' ? '🪄 Stop Demo' : '🪄 Demo Mode';
  btnRec.disabled = state.mode === 'idle';
  setMsg(state.mode === 'demo' ? 'Demo Mode: a virtual performer drives the lead — watch it wave and look around. (The real magic needs your camera.)' : '');
});
selQuality.addEventListener('change', () => { state.quality = selQuality.value; state.autoBalanced = false; });
btnReel.addEventListener('click', () => {
  state.reel = !state.reel;
  stage.classList.toggle('reel', state.reel);
  btnReel.textContent = state.reel ? '🖥 16:9 Stage Mode' : '📱 9:16 Reel Mode';
});

btnRec.addEventListener('click', () => {
  if (state.recording) { state.recorder.stop(); return; }
  if (state.mode === 'idle') { setMsg('Start the camera or Demo Mode first — then record your scene.'); return; }
  try {
    const canvasStream = stage.captureStream(30);
    const tracks = [...canvasStream.getVideoTracks()];
    if (state.stream && state.stream.getAudioTracks().length) tracks.push(state.stream.getAudioTracks()[0]);
    const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', '']
      .find(m => m === '' || MediaRecorder.isTypeSupported(m));
    const rec = new MediaRecorder(new MediaStream(tracks), mime ? { mimeType: mime } : undefined);
    state.chunks = [];
    rec.ondataavailable = e => { if (e.data.size) state.chunks.push(e.data); };
    rec.onstop = () => {
      state.recording = false; btnRec.textContent = '⏺ Record Scene';
      const blob = new Blob(state.chunks, { type: 'video/webm' });
      if (state.recUrl) URL.revokeObjectURL(state.recUrl);
      state.recUrl = URL.createObjectURL(blob);
      downloadA.href = state.recUrl; downloadA.hidden = false; btnRetake.hidden = false;
      setMsg('Scene recorded! Download the film, or act out a retake.');
    };
    rec.start(250); state.recorder = rec; state.recording = true; state.recStart = Date.now();
    downloadA.hidden = true; btnRetake.hidden = true;
    setMsg('Rolling! Lights, camera… act!');
  } catch (e) { setMsg('Recording failed: ' + e.message); }
});
btnRetake.addEventListener('click', () => {
  if (state.recording) return;
  downloadA.hidden = true; btnRetake.hidden = true; btnRec.click();
});

/* Debug/testing handle — lets the sandbox harness drive synthetic performers. */
window.__rangmanch = { version: VERSION, state, raw, cast, packs, ensurePack, classifyGesture, packGeom, stage };

fillCastSelects();
requestAnimationFrame(loop);
