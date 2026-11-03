'use strict';
/* Rangmanch AR — one-person cartoon studio.
   v0.4 "You Become the Character": the lead Rigpop character is cut into a live
   puppet at load (its arms lifted out of the art as feathered bone-strips, the
   gaps filled) and re-posed bone-by-bone from your MediaPipe skeleton every
   frame. Your hands conduct full-size co-actors standing on the stage floor.
   Face blendshapes drive blink + A/O/E mouth tiles. Everything on-device. */

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

/* ---------- cast ---------- */
const CAST = [
  ['swapnil', 'Swapnil (you!)'], ['sanjay', 'Sanjay'], ['seema', 'Seema'], ['bhavishy', 'Bhavishy'],
  ['mocha', 'Mocha the Cat'], ['bunty', 'Bunty the Bot'], ['pia', 'Pia the Pineapple'],
  ['solana', 'Solana'], ['rafi', 'Rafi'], ['kiko', 'Kiko'], ['mira', 'Mira'],
  ['bubbles', 'Bubbles'], ['luna', 'Luna'], ['puni', 'Puni'], ['static', 'Static'],
  ['doodle-swapnil', 'Doodle Swapnil']
];
/* Packs whose art is a full-body humanoid the puppet-rig template fits.
   The rest play as anchored figures (and shine as hand co-actors). */
const RIG_PACKS = new Set(['swapnil', 'doodle-swapnil', 'sanjay', 'seema', 'bhavishy',
  'solana', 'rafi', 'kiko', 'mira', 'bubbles', 'luna', 'static']);

const packs = {};   // id -> {manifest, img, tiles, anchors, rig}
const cast = { lead: 'swapnil', leftHand: 'mocha', rightHand: 'bunty' };

function loadImage(src) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
}
async function ensurePack(id) {
  if (packs[id]) return packs[id];
  const base = PACKS_BASE + id + '/';
  const manifest = await (await fetch(base + 'character.rigpop.json')).json();
  const talk = manifest.talk || {};
  const img = {};
  const poses = Object.keys(talk.assets || { base: 1 });
  await Promise.all(poses.map(async p => {
    try { img[p] = await loadImage(base + 'talk/' + p + '.png'); } catch (e) { /* pose missing */ }
  }));
  const tiles = {};
  for (const t of ['mouthA', 'mouthO', 'mouthE', 'blink']) {
    if (talk.patches && talk.patches[t]) { try { tiles[t] = await loadImage(base + 'talk/' + t + '.png'); } catch (e) { /* none */ } }
  }
  packs[id] = { manifest, img, tiles, anchors: talk.poseAnchors || null, rig: null, rigFailed: false };
  return packs[id];
}
function updateThumb(role, id) {
  const p = packs[id], th = document.querySelector('#thumb-' + role);
  if (th && p && p.manifest.talk && p.manifest.talk.thumb) th.src = PACKS_BASE + id + '/' + p.manifest.talk.thumb;
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
selLead.addEventListener('change', async () => { cast.lead = selLead.value; await ensurePack(cast.lead); updateThumb('body', cast.lead); });
selLeft.addEventListener('change', async () => { cast.leftHand = selLeft.value; await ensurePack(cast.leftHand); updateThumb('left', cast.leftHand); });
selRight.addEventListener('change', async () => { cast.rightHand = selRight.value; await ensurePack(cast.rightHand); updateThumb('right', cast.rightHand); });

/* ---------- puppet rig: cut the lead's arms out of its own art ----------
   Template measured on the reference pack (720x936, via visual grounding).
   Arms become feathered strips around the arm bones; the holes are filled by
   smearing neighbouring hair/dress pixels, so arms can move with no ghost. */
const RIG_T = { // fractions of image w/h
  shoR: [243 / 720, 400 / 936], elbR: [210 / 720, 604 / 936], wriR: [176 / 720, 772 / 936],
  shoL: [502 / 720, 400 / 936], elbL: [538 / 720, 604 / 936], wriL: [578 / 720, 772 / 936],
  hip: [368 / 720, 646 / 936]
};
const RIG_SEG_BOX = { // strip crop boxes [x0,y0,x1,y1] in fractions
  Rup: [100 / 720, 356 / 936, 330 / 720, 640 / 936], Rlo: [72 / 720, 560 / 936, 316 / 720, 836 / 936],
  Lup: [416 / 720, 356 / 936, 646 / 720, 640 / 936], Llo: [434 / 720, 560 / 936, 674 / 720, 836 / 936]
};
const RIG_BONES = { Rup: ['shoR', 'elbR'], Rlo: ['elbR', 'wriR'], Lup: ['shoL', 'elbL'], Llo: ['elbL', 'wriL'] };
function distSeg(px, py, a, b) {
  const vx = b[0] - a[0], vy = b[1] - a[1], L2 = vx * vx + vy * vy || 1;
  let t = ((px - a[0]) * vx + (py - a[1]) * vy) / L2; t = Math.max(0, Math.min(1, t));
  const dx = px - (a[0] + t * vx), dy = py - (a[1] + t * vy);
  return Math.hypot(dx, dy);
}
function buildRig(pack) {
  if (pack.rig || pack.rigFailed) return pack.rig;
  const img = pack.img.base;
  if (!img) { pack.rigFailed = true; return null; }
  try {
    const W = img.naturalWidth, H = img.naturalHeight, sx = W / 720, sy = H / 936;
    const J = {}; for (const k in RIG_T) J[k] = [RIG_T[k][0] * W, RIG_T[k][1] * H];
    const base = document.createElement('canvas'); base.width = W; base.height = H;
    const bctx = base.getContext('2d', { willReadFrequently: true });
    bctx.drawImage(img, 0, 0);
    const data = bctx.getImageData(0, 0, W, H).data;
    const R = 34 * sx, F = 10 * sx;
    const arms = [
      { segs: [[J.shoR, J.elbR], [J.elbR, J.wriR]], shift: -46 * sx },
      { segs: [[J.shoL, J.elbL], [J.elbL, J.wriL]], shift: 46 * sx }
    ];
    const out = new ImageData(W, H); out.data.set(data);
    const od = out.data;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let hit = null;
      for (const a of arms) {
        const d = Math.min(distSeg(x, y, a.segs[0][0], a.segs[0][1]), distSeg(x, y, a.segs[1][0], a.segs[1][1]));
        if (d <= R + 2) { hit = a; break; }
      }
      if (!hit) continue;
      const i = (y * W + x) * 4;
      const sxp = Math.max(0, Math.min(W - 1, Math.round(x + hit.shift)));
      let j = (y * W + sxp) * 4;
      if (data[j + 3] < 40) { const syp = Math.max(0, y - Math.round(170 * sy)); j = (syp * W + sxp) * 4; } // hair falls from above
      od[i] = data[j]; od[i + 1] = data[j + 1]; od[i + 2] = data[j + 2]; od[i + 3] = data[j + 3];
    }
    // head erase: only skin/face tones are repainted (with hair sampled sideways),
    // so when the head piece turns, hair shows behind the face — no streaks, no halo.
    const NL = Math.round(351 * sy), FH = Math.round(14 * sy);
    const snap = new Uint8ClampedArray(od);
    const cxImg = Math.round(372 * sx);
    for (let y = 0; y < Math.min(H, NL + FH); y++) {
      const f = Math.max(0, Math.min(1, (NL + FH - y) / (2 * FH)));
      if (f <= 0.02) continue;
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        if (snap[i + 3] < 30) continue;
        const r = snap[i], b = snap[i + 2];
        if (!(r > 120 && r > b + 18)) continue; // hair, dress, outlines stay untouched
        const dir = x < cxImg ? -1 : 1;
        let sxp = Math.max(0, Math.min(W - 1, x + dir * Math.round(70 * sx)));
        let j = (y * W + sxp) * 4;
        if (snap[j + 3] < 30) { sxp = Math.max(0, Math.min(W - 1, x - dir * Math.round(70 * sx))); j = (y * W + sxp) * 4; }
        const sr = snap[j + 3] < 30 ? 58 : snap[j], sg = snap[j + 3] < 30 ? 44 : snap[j + 1], sb = snap[j + 3] < 30 ? 40 : snap[j + 2];
        od[i] = Math.round(sr * f + snap[i] * (1 - f));
        od[i + 1] = Math.round(sg * f + snap[i + 1] * (1 - f));
        od[i + 2] = Math.round(sb * f + snap[i + 2] * (1 - f));
        od[i + 3] = Math.max(snap[i + 3], Math.round((snap[j + 3] < 30 ? 255 : snap[j + 3]) * f));
      }
    }
    const erased = document.createElement('canvas'); erased.width = W; erased.height = H;
    erased.getContext('2d').putImageData(out, 0, 0);
    // head piece: everything above the neck line, feathered at the junction
    const headBox = [120 / 720 * W, 0, 630 / 720 * W, 392 / 936 * H];
    const hw = Math.round(headBox[2] - headBox[0]), hh = Math.round(headBox[3] - headBox[1]);
    const headC = document.createElement('canvas'); headC.width = hw; headC.height = hh;
    const hctx = headC.getContext('2d', { willReadFrequently: true });
    hctx.drawImage(img, -headBox[0], -headBox[1]);
    const hid = hctx.getImageData(0, 0, hw, hh), hd = hid.data;
    for (let y = 0; y < hh; y++) {
      const gy = y + headBox[1];
      const f = Math.max(0, Math.min(1, (NL + FH - gy) / (2 * FH)));
      if (f >= 0.999) continue;
      for (let x = 0; x < hw; x++) { const i = (y * hw + x) * 4 + 3; hd[i] = Math.round(hd[i] * f); }
    }
    hctx.putImageData(hid, 0, 0);
    const head = { img: headC, box: headBox, pivot: [372 / 720 * W, 338 / 936 * H] };
    const strips = {};
    for (const name of Object.keys(RIG_BONES)) {
      const [fk, tk] = RIG_BONES[name], a = J[fk], b = J[tk], bf = RIG_SEG_BOX[name];
      const box = [bf[0] * W, bf[1] * H, bf[2] * W, bf[3] * H];
      const cw = Math.round(box[2] - box[0]), ch = Math.round(box[3] - box[1]);
      const c = document.createElement('canvas'); c.width = cw; c.height = ch;
      const cctx = c.getContext('2d', { willReadFrequently: true });
      cctx.drawImage(img, -box[0], -box[1]);
      const idd = cctx.getImageData(0, 0, cw, ch), dd = idd.data;
      for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
        const d = distSeg(x + box[0], y + box[1], a, b);
        const f = Math.max(0, Math.min(1, (R + F - d) / (2 * F)));
        dd[(y * cw + x) * 4 + 3] = Math.round(dd[(y * cw + x) * 4 + 3] * f);
      }
      cctx.putImageData(idd, 0, 0);
      strips[name] = { img: c, box, from: a, to: b };
    }
    pack.rig = { erased, strips, head, J, W, H };
    return pack.rig;
  } catch (e) { pack.rigFailed = true; return null; }
}

/* ---------- state ---------- */
const state = {
  mode: 'idle', pose: null, face: null, hands: [],
  recording: false, chunks: [], recorder: null, stream: null,
  recUrl: null, recStart: 0, quality: 'high', reel: false,
  actors: { left: { p: 0, x: 0, talk: 0, talkT: 0, last: 0, tx: 0 }, right: { p: 0, x: 0, talk: 0, talkT: 0, last: 0, tx: 0 } }
};
const raw = { pose: null, face: null, hands: [] };

function smoothLm(prev, next, a) {
  if (!next) return prev;
  if (!prev || prev.length !== next.length) return next.map(p => ({ ...p }));
  return next.map((p, i) => ({
    x: prev[i].x + (p.x - prev[i].x) * a, y: prev[i].y + (p.y - prev[i].y) * a,
    z: (prev[i].z || 0) + ((p.z || 0) - (prev[i].z || 0)) * a, visibility: p.visibility
  }));
}
function smoothAll(alpha) {
  state.pose = smoothLm(state.pose, raw.pose, alpha);
  state.hands = raw.hands.map((h, i) => smoothLm(state.hands[i], h, alpha));
  state.face = raw.face ? {
    landmarks: smoothLm(state.face && state.face.landmarks, raw.face.landmarks, alpha),
    cats: raw.face.cats
  } : state.face;
}

/* ---------- MediaPipe ---------- */
let poseL = null, handL = null, faceL = null, lastVideoTime = -1, frameNo = 0;
async function initModels() {
  setMsg('Loading the stage crew (MediaPipe models)…');
  const { FilesetResolver, PoseLandmarker, HandLandmarker, FaceLandmarker } =
    await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs');
  const vision = await FilesetResolver.forVisionTasks(WASM);
  const mk = async (Cls, path, extra) => {
    const opts = d => Object.assign({ baseOptions: { modelAssetPath: `${MODEL}/${path}`, delegate: d }, runningMode: 'VIDEO', numPoses: 1, numHands: 2 }, extra || {});
    try { return await Cls.createFromOptions(vision, opts('GPU')); } catch (e) { return await Cls.createFromOptions(vision, opts('CPU')); }
  };
  poseL = await mk(PoseLandmarker, 'pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task');
  handL = await mk(HandLandmarker, 'hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task');
  faceL = await mk(FaceLandmarker, 'face_landmarker/face_landmarker/float16/1/face_landmarker.task', { outputFaceBlendshapes: true });
}
async function infer() {
  if (!poseL || cam.readyState < 2 || cam.currentTime === lastVideoTime) return;
  lastVideoTime = cam.currentTime; frameNo++;
  const t = performance.now();
  const skip = state.quality === 'balanced' ? 2 : 1;
  try {
    const pr = poseL.detectForVideo(cam, t);
    raw.pose = pr.landmarks && pr.landmarks[0] ? pr.landmarks[0] : null;
    if (frameNo % skip === 0) {
      const hr = handL.detectForVideo(cam, t);
      raw.hands = hr.landmarks || [];
    }
    if (frameNo % skip === 0) {
      const fr = faceL.detectForVideo(cam, t);
      if (fr.faceLandmarks && fr.faceLandmarks[0]) {
        const cats = {};
        const bs = fr.faceBlendshapes && fr.faceBlendshapes[0];
        if (bs) for (const c of bs.categories) cats[c.categoryName] = c.score;
        raw.face = { landmarks: fr.faceLandmarks[0], cats };
      } else raw.face = null;
    }
  } catch (e) { /* transient inference error: keep last frame */ }
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
  raw.face = { landmarks: fl, cats };
}

/* ---------- stage helpers ---------- */
function setMsg(t) { msgEl.textContent = t || ''; }
function toPx(p) { return { x: (1 - p.x) * stage.width, y: p.y * stage.height }; }
function mid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
function faceState() {
  const c = (state.face && state.face.cats) || {};
  const blink = ((c.eyeBlinkLeft || 0) + (c.eyeBlinkRight || 0)) / 2 > 0.5;
  const smile = ((c.mouthSmileLeft || 0) + (c.mouthSmileRight || 0)) / 2, jaw = c.jawOpen || 0;
  let mouth = null;
  if (jaw > 0.22) mouth = 'mouthA';
  else if ((c.mouthFunnel || 0) > 0.3) mouth = 'mouthO';
  else if (smile > 0.34) mouth = 'mouthE';
  const wide = smile > 0.45 && jaw > 0.1; // laughing: big grin wins over a plain A
  if (wide) mouth = 'mouthE';
  return { blink, mouth, wide };
}
function headPose() {
  const fl = state.face && state.face.landmarks;
  if (!fl || !fl[1] || !fl[33] || !fl[263]) return { yaw: 0, pitch: 0, roll: 0 };
  const nose = toPx(fl[1]), eR = toPx(fl[33]), eL = toPx(fl[263]);
  const eyeMid = mid(eR, eL), eyeDist = Math.max(10, Math.hypot(eL.x - eR.x, eL.y - eR.y));
  return {
    yaw: Math.max(-1, Math.min(1, (nose.x - eyeMid.x) / (eyeDist * 0.55))),
    pitch: Math.max(-0.8, Math.min(0.8, (nose.y - eyeMid.y) / eyeDist - 0.62)),
    roll: Math.atan2(eL.y - eR.y, eL.x - eR.x)
  };
}
function tileAt(pack, poseKey) {
  const a = pack.anchors;
  if (a && a[poseKey]) return a[poseKey];
  const m = (pack.manifest.talk || {}).patches || {};
  return { mouth: m.mouthO && m.mouthO.rect, eyes: m.blink && m.blink.rect };
}
function drawTile(img, cx, cy, w, rot) {
  if (!img) return;
  const h = w * img.naturalHeight / img.naturalWidth;
  ctx.save(); ctx.translate(cx, cy); if (rot) ctx.rotate(rot);
  ctx.drawImage(img, -w / 2, -h / 2, w, h); ctx.restore();
}
function drawFaceTiles(pack, place) {
  const fs = faceState(), anch = tileAt(pack, 'base');
  if (!anch) return;
  const man = pack.manifest.talk || {};
  if (fs.blink && pack.tiles.blink && anch.eyes) {
    const p = place(anch.eyes[0], anch.eyes[1]);
    const w = ((man.patches && man.patches.blink && man.patches.blink.w) || 170) * place.scale;
    drawTile(pack.tiles.blink, p.x, p.y, w, place.rot);
  }
  if (fs.mouth && pack.tiles[fs.mouth] && anch.mouth) {
    const p = place(anch.mouth[0], anch.mouth[1]);
    let w = ((man.patches && man.patches[fs.mouth] && man.patches[fs.mouth].w) || 110) * place.scale;
    if (place.wMul) w *= place.wMul;
    if (fs.wide && fs.mouth === 'mouthE') w *= 1.2;
    drawTile(pack.tiles[fs.mouth], p.x, p.y, w, place.rot);
  }
}
function shadow(x, y, w) {
  ctx.save(); ctx.fillStyle = 'rgba(0,0,0,0.30)';
  ctx.beginPath(); ctx.ellipse(x, y, w / 2, w * 0.09, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
}
function drawStrip(st, liveFrom, liveTo) {
  const rf = st.from, rt = st.to;
  const ra = Math.atan2(rt[1] - rf[1], rt[0] - rf[0]), la = Math.atan2(liveTo.y - liveFrom.y, liveTo.x - liveFrom.x);
  const rl = Math.hypot(rt[0] - rf[0], rt[1] - rf[1]) || 1, ll = Math.hypot(liveTo.x - liveFrom.x, liveTo.y - liveFrom.y);
  ctx.save(); ctx.translate(liveFrom.x, liveFrom.y); ctx.rotate(la - ra); ctx.scale(ll / rl, ll / rl);
  ctx.drawImage(st.img, -(rf[0] - st.box[0]), -(rf[1] - st.box[1])); ctx.restore();
}

/* ---------- the lead: YOU, converted ---------- */
function drawLead() {
  const pack = packs[cast.lead];
  if (!pack || !pack.img.base) return;
  const W = stage.width, H = stage.height, lm = state.pose;
  if (!lm) {
    const img = pack.img.base, h = H * 0.94, w = h * img.naturalWidth / img.naturalHeight;
    ctx.drawImage(img, (W - w) / 2, H - h, w, h);
    return;
  }
  const P = i => toPx(lm[i]);
  const hip = mid(P(23), P(24)), neckC = mid(P(11), P(12));
  const torsoVec = { x: neckC.x - hip.x, y: neckC.y - hip.y };
  const torsoLen = Math.max(30, Math.hypot(torsoVec.x, torsoVec.y));
  const tilt = Math.atan2(torsoVec.x, -torsoVec.y);
  const rig = RIG_PACKS.has(cast.lead) ? buildRig(pack) : null;
  if (rig) {
    const restTorso = (RIG_T.hip[1] - 351 / 936) * rig.H; // neck->hip in image px (295)
    // size from your full body span, so the character covers you completely
    const ank = mid(P(27), P(28)), span = Math.max(60, ank.y - P(0).y);
    const k = Math.max(span * 1.14 / rig.H, torsoLen * 1.02 / restTorso);
    const rel = i => {
      const p = P(i), d = restTorso * k;
      return { x: hip.x + (p.x - hip.x) / torsoLen * d, y: hip.y + (p.y - hip.y) / torsoLen * d };
    };
    shadow(hip.x, Math.min(H - 8, hip.y + (rig.H - rig.J.hip[1]) * k * 0.98), 320 * k);
    ctx.save(); ctx.translate(hip.x, hip.y); ctx.rotate(tilt); ctx.scale(k, k);
    ctx.drawImage(rig.erased, -rig.J.hip[0], -rig.J.hip[1]); ctx.restore();
    drawStrip(rig.strips.Rup, rel(12), rel(14));
    drawStrip(rig.strips.Rlo, rel(14), rel(16));
    drawStrip(rig.strips.Lup, rel(11), rel(13));
    drawStrip(rig.strips.Llo, rel(13), rel(15));
    // head: its own piece, so it can look where you look
    const hp = headPose(), hrot = tilt + hp.roll * 0.85;
    const torsoPt = (fx, fy) => {
      const dx = (fx - rig.J.hip[0]) * k, dy = (fy - rig.J.hip[1]) * k;
      const c = Math.cos(tilt), s = Math.sin(tilt);
      return { x: hip.x + dx * c - dy * s, y: hip.y + dx * s + dy * c };
    };
    if (rig.head) {
      const pv = rig.head.pivot, pivLive = torsoPt(pv[0], pv[1]);
      ctx.save(); ctx.translate(pivLive.x, pivLive.y); ctx.rotate(hrot);
      ctx.scale(k * (1 - 0.35 * Math.abs(hp.yaw)), k);
      ctx.drawImage(rig.head.img, -(pv[0] - rig.head.box[0]), -(pv[1] - rig.head.box[1])); ctx.restore();
    }
    const place = (fx, fy) => torsoPt(fx + hp.yaw * 30, fy + hp.pitch * 26);
    place.scale = k; place.rot = hrot; place.wMul = 1 - 0.28 * Math.abs(hp.yaw);
    drawFaceTiles(pack, place);
  } else {
    const img = pack.img.base;
    const ankY = Math.max(P(27).y, P(28).y), span = Math.max(80, ankY - P(0).y);
    const charH = Math.min(H * 1.05, span * 1.5), charW = charH * img.naturalWidth / img.naturalHeight;
    const cx = hip.x, feetY = Math.min(H - 4, ankY + charH * 0.06);
    ctx.save(); ctx.translate(cx, feetY); ctx.rotate(tilt * 0.7); ctx.translate(-cx, -feetY);
    shadow(cx, feetY, charW * 0.8);
    ctx.drawImage(img, cx - charW / 2, feetY - charH, charW, charH); ctx.restore();
    const place = (fx, fy) => ({ x: cx - charW / 2 + fx / img.naturalWidth * charW, y: feetY - charH + fy / img.naturalHeight * charH });
    place.scale = charW / img.naturalWidth; place.rot = 0;
    drawFaceTiles(pack, place);
  }
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
    const fullH = H * 0.54, h = fullH * (0.25 + 0.75 * a.p);
    const w = h * img.naturalWidth / img.naturalHeight;
    const feetY = H + (1 - a.p) * fullH * 0.75;
    const bobA = Math.sin(now / 300 + (sideName === 'left' ? 0 : 2)) * 3 + (a.talk > 0.5 ? Math.sin(now / 60) * 4 : 0);
    ctx.save(); ctx.globalAlpha = Math.min(1, a.p * 1.6);
    shadow(a.x, Math.min(H - 4, feetY), w * 0.75);
    ctx.translate(a.x, feetY + bobA * a.p);
    ctx.rotate(Math.max(-0.08, Math.min(0.08, ((a.tx || a.x) - a.x) * 0.0009)));
    ctx.drawImage(img, -w / 2, -h, w, h);
    ctx.restore();
    if (a.talk > 0.5 && pack.tiles.mouthO) {
      const anch = tileAt(pack, 'base');
      if (anch && anch.mouth) {
        const mx = a.x - w / 2 + anch.mouth[0] / img.naturalWidth * w;
        const my = feetY + bobA * a.p - h + anch.mouth[1] / img.naturalHeight * h;
        const tw = (((pack.manifest.talk || {}).patches || {}).mouthO || {}).w || 110;
        ctx.save(); ctx.globalAlpha = Math.min(1, a.p * 1.6);
        drawTile(pack.tiles.mouthO, mx, my, tw * (w / img.naturalWidth) * 1.15, 0); ctx.restore();
      }
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
function loop(ts) {
  requestAnimationFrame(loop);
  fitStage();
  if (state.mode === 'camera') infer();
  if (state.mode === 'demo') synthDemo(ts || 0);
  smoothAll(state.mode === 'idle' ? 1 : 0.62);
  const W = stage.width, H = stage.height;
  ctx.clearRect(0, 0, W, H);
  if (state.mode === 'camera' && cam.readyState >= 2) {
    // your room stays — as soft blurred colour. YOU are gone: fully replaced.
    if (!state.bg) { state.bg = document.createElement('canvas'); state.bg.width = 192; state.bg.height = 108; }
    const bgc = state.bg.getContext('2d');
    const vw = cam.videoWidth, vh = cam.videoHeight, s = Math.max(192 / vw, 108 / vh);
    bgc.save(); bgc.translate(192, 0); bgc.scale(-1, 1);
    bgc.drawImage(cam, (192 - vw * s) / 2, (108 - vh * s) / 2, vw * s, vh * s); bgc.restore();
    ctx.save(); ctx.imageSmoothingEnabled = true;
    ctx.drawImage(state.bg, 0, 0, W, H);
    ctx.fillStyle = 'rgba(26,9,13,0.30)'; ctx.fillRect(0, 0, W, H);
    const fg = ctx.createLinearGradient(0, H * 0.8, 0, H);
    fg.addColorStop(0, 'rgba(40,20,10,0)'); fg.addColorStop(1, 'rgba(40,20,10,0.55)');
    ctx.fillStyle = fg; ctx.fillRect(0, H * 0.8, W, H * 0.2); ctx.restore();
  } else {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#3d1522'); g.addColorStop(0.75, '#2b1219'); g.addColorStop(1, '#59331f');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#6d4423'; ctx.fillRect(0, H * 0.94, W, H * 0.06);
  }
  drawLead();
  if (state.mode !== 'idle' && chkCo.checked) drawCoActors(ts || 0);
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
  dotPose.classList.toggle('on', !!state.pose);
  dotHand.classList.toggle('on', state.hands.length > 0);
  dotFace.classList.toggle('on', !!state.face);
  fpsFrames++;
  if (ts - fpsLast > 1000) { fpsEl.textContent = fpsFrames + ' fps'; fpsFrames = 0; fpsLast = ts; }
}
let fpsFrames = 0, fpsLast = 0;

/* ---------- controls ---------- */
btnCam.addEventListener('click', async () => {
  try {
    if (!poseL) { await initModels(); statusModel.textContent = 'Models: ready ✅'; }
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: true });
    cam.srcObject = stream; await cam.play();
    state.stream = stream; state.mode = 'camera';
    btnCam.textContent = '📷 Camera On ✅'; btnDemo.textContent = '🪄 Demo Mode'; btnRec.disabled = false;
    setMsg('You are live — and fully replaced. Look around, talk, laugh, dance: the character does it all with you.');
  } catch (e) { setMsg('Camera blocked: ' + e.message + ' — try Demo Mode instead.'); }
});
btnDemo.addEventListener('click', () => {
  state.mode = state.mode === 'demo' ? 'idle' : 'demo';
  btnDemo.textContent = state.mode === 'demo' ? '🪄 Stop Demo' : '🪄 Demo Mode';
  btnRec.disabled = state.mode === 'idle';
  setMsg(state.mode === 'demo' ? 'Demo Mode: a virtual performer drives the lead — watch it wave back. (The real magic needs your camera.)' : '');
});
selQuality.addEventListener('change', () => { state.quality = selQuality.value; });
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
    const rec = new MediaRecorder(new MediaStream(tracks), { mimeType: MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm' });
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

fillCastSelects().then(() => { ensurePack(cast.lead); ensurePack(cast.leftHand); ensurePack(cast.rightHand); });
requestAnimationFrame(loop);
