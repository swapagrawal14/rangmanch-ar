/* Rangmanch AR v2.2 — one-person cartoon studio, phone first.
   You act; the character performs. The lead is the pack's own authored art —
   complete gesture poses drawn on one canvas — switched by a gesture
   classifier reading your MediaPipe pose, while your face blendshapes drive
   the A/O/E/blink tiles at each pose's face anchors. Every pose drawing is
   normalised onto the base drawing by its face (position + drawing scale,
   assets/anchors.json), so a pose swap never makes the character jump in
   size, and it is mirrored when you gesture with the other arm. The figure
   follows your torso or face; breath, bob and blink timers keep it alive; bad
   tracking is refused, never drawn. No camera pixel ever reaches the stage,
   and nothing leaves the phone.
   v2.2: the head follows yours (tilt, turn, nod, shake — headwarp.js), the
   hands are read too (gestures.js: hand on mouth, shh, thinking, facepalm,
   salute, covering the face, hands on head, namaste, clap, fist, thumbs,
   point, open palm) and each is performed as its own authored drawing, and
   a wave really waves (two drawn frames, hard cuts in time with your hand).
   v2.3: Free arms (freearms.js) — for a character with an arm rig (Doodle
   Swapnil first) the arms are no longer chosen from drawn poses: an armless
   torso drawing carries the head, face tiles and head warp, and cartoon arms
   and hands are drawn every frame from your pose + hand landmarks, so any
   gesture you make (both hands up, a heart, peace, a shrug…) is copied.
   Toggle "Free arms" off to get the pose drawings back. */
import { classifyHandsFace, makeGestureMemory } from './gestures.js?v=2.3.0';
import { HeadTracker, HeadWarpGL, warpPoint, OneEuro, swings } from './headwarp.js?v=2.3.0';
import { synthFace, synthHand } from './synth.js?v=2.3.0';
import { FreeArms } from './freearms.js?v=2.3.0';

const $ = s => document.querySelector(s);
const stage = $('#stage'), ctx = stage.getContext('2d');
const cam = $('#cam'), msgEl = $('#stage-msg');
const btnCam = $('#btn-camera'), btnDemo = $('#btn-demo'), btnRec = $('#btn-record'), btnRetake = $('#btn-retake');
const downloadA = $('#download'), btnShare = $('#btn-share'), btnReel = $('#btn-reel');
const leadStrip = $('#lead-strip'), selLeft = $('#cast-left'), selRight = $('#cast-right');
const selQuality = $('#quality'), captionInput = $('#caption-input'), chkCo = $('#coactors');
const chkFA = $('#freearms'), faWrap = $('#fa-wrap');
const statusModel = $('#status-model'), dotPose = $('#dot-pose'), dotHand = $('#dot-hand'), dotFace = $('#dot-face'), fpsEl = $('#fps');

const MP_VER = '0.10.14';
const WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VER}/wasm`;
const MODEL = 'https://storage.googleapis.com/mediapipe-models';
const PACKS_BASE = 'assets/packs/';
const VERSION = '2.3.0';

/* ---------- cast ---------- */
const CAST = [
  ['swapnil', 'Swapnil'], ['sanjay', 'Sanjay'], ['seema', 'Seema'], ['bhavishy', 'Bhavishy'],
  ['mocha', 'Mocha the Cat'], ['bunty', 'Bunty the Bot'], ['pia', 'Pia the Pineapple'],
  ['solana', 'Solana'], ['rafi', 'Rafi'], ['kiko', 'Kiko'], ['mira', 'Mira'],
  ['bubbles', 'Bubbles'], ['luna', 'Luna'], ['puni', 'Puni'], ['static', 'Static'],
  ['doodle-swapnil', 'Doodle Swapnil']
];
const POSE_KEYS = ['wave', 'point', 'open', 'thumbs'];          // every pack: loaded with the lead
const EXTRA_KEYS = ['wave2', 'mouth', 'think', 'head', 'cover', 'namaste', 'clap', 'salute', 'shh', 'facepalm', 'fist']; // v2.2 art: loaded once you are live
const ALL_POSES = [...POSE_KEYS, ...EXTRA_KEYS];
/* A character without the drawing for a gesture performs its nearest
   existing drawing (and, on the base drawing, the matching face), never a
   blank or a crude cut-out. */
const FALLBACK = { palm: 'wave', mouth: 'base', shh: 'base', think: 'base', facepalm: 'base', cover: 'base', head: 'open', salute: 'wave', namaste: 'base', clap: 'open', fist: 'thumbs' };
const FALLBACK_FACE = { mouth: { mouth: 'O' }, cover: { blink: true, mouth: null }, facepalm: { blink: true }, shh: { mouth: null } };
const HAND_FACE = new Set(['mouth', 'shh', 'think', 'facepalm', 'salute', 'cover', 'head']);
const packs = {};        // id -> pack (base art + tiles first; poses stream in after)
const packLoads = {};    // id -> in-flight promise (no double downloads)
const cast = { lead: 'swapnil', leftHand: 'mocha', rightHand: 'bunty' };
let measured = null;     // assets/anchors.json (per-pose face anchors, scale, gesture side)

function loadImage(src) {
  // decoded up front, off the main thread where supported: the first swap to
  // a new pose must not stall the stage while a drawing decodes
  return new Promise((res, rej) => {
    const i = new Image(); i.decoding = 'async';
    i.onload = () => (i.decode ? i.decode().catch(() => {}) : Promise.resolve()).then(() => res(i));
    i.onerror = rej; i.src = src;
  });
}
async function loadMeasured() {
  if (measured) return measured;
  try { measured = (await (await fetch('assets/anchors.json?v=' + VERSION)).json()).packs || {}; }
  catch (e) { measured = {}; }
  return measured;
}
/* Per-pose face geometry: hand-measured talk.poseAnchors win; otherwise the
   anchors measured by tools/measure-anchors.py. A pose with neither is
   performed without face tiles — never with a mouth painted in the wrong place. */
function buildPoseInfo(manifest, id) {
  const talk = manifest.talk || {}, hand = talk.poseAnchors || {}, m = (measured && measured[id]) || {};
  const patches = talk.patches || {};
  const centre = p => p ? [p.x + p.w / 2, p.y + p.h / 2] : null;
  const info = {}, poses = talk.poses || {};
  for (const key of ['base', ...ALL_POSES]) {
    const g = m[key] || {};
    // a v2.2 drawing (its own file) carries its own measured anchors; a
    // hand-measured anchor belongs to the pack's original drawing only
    const h = g.file ? null : hand[key];
    if (key !== 'base' && !g.file && !poses[key]) continue; // no drawing for this pose
    let mouth = null, eyes = null;
    if (h && h.mouth && h.eyes) { mouth = h.mouth; eyes = h.eyes; }
    else if (g.mouth && g.eyes && !g.refused) { mouth = g.mouth; eyes = g.eyes; }
    else if (key === 'base') { mouth = centre(patches.A); eyes = centre(patches.blink); }
    info[key] = {
      mouth, eyes, scale: (g.scale && !g.refused) ? g.scale : 1, side: g.side || null,
      file: g.file || poses[key] || null, face: g.face || 'full', headWarp: g.headWarp !== false,
      head: g.head || null
    };
  }
  return info;
}
/* Forge pack format (character.rigpop.json): talk.base, talk.files{A,O,E,blink},
   talk.patches{key:{x,y,w,h}}, talk.poses{wave,point,open,thumbs}. Only what
   is needed is fetched: base + face tiles now, pose drawings for the lead in
   the background. */
function ensurePack(id, withPoses) {
  if (!packLoads[id]) {
    packLoads[id] = (async () => {
      await loadMeasured();
      const base = PACKS_BASE + id + '/';
      const manifest = await (await fetch(base + 'character.rigpop.json')).json();
      const talk = manifest.talk || {};
      const img = {}, tiles = {};
      const files = talk.files || {};
      await Promise.all([
        talk.base ? loadImage(base + talk.base).then(i => { img.base = i; }).catch(() => {}) : null,
        ...['A', 'O', 'E', 'blink'].map(k => files[k] ? loadImage(base + files[k]).then(i => { tiles[k] = i; }).catch(() => {}) : null),
        // v2.3 free arms: the armless torso + the hair strand that lies over the shoulder
        talk.freeArms && talk.torso ? loadImage(base + talk.torso).then(i => { img.torso = i; }).catch(() => {}) : null,
        talk.freeArms && talk.hairFront ? loadImage(base + talk.hairFront).then(i => { img.hairFront = i; }).catch(() => {}) : null
      ]);
      const poseInfo = buildPoseInfo(manifest, id), bi = poseInfo.base || {};
      const fa = talk.freeArms && img.torso ? new FreeArms(talk.freeArms, bi.eyes && bi.mouth ? { eyes: bi.eyes, mouth: bi.mouth } : null) : null;
      packs[id] = { id, manifest, img, tiles, poses: {}, poseInfo, posesLoading: null, fa };
      return packs[id];
    })();
  }
  return packLoads[id].then(p => { if (withPoses) loadPoses(p); return p; });
}
function loadPoses(pack) {
  if (pack.posesLoading) return pack.posesLoading;
  const base = PACKS_BASE + pack.id + '/';
  pack.posesLoading = Promise.all(POSE_KEYS.map(k => pack.poseInfo[k] && pack.poseInfo[k].file
    ? loadImage(base + pack.poseInfo[k].file).then(i => { pack.poses[k] = i; }).catch(() => {}) : null));
  return pack.posesLoading;
}
/* The v2.2 gesture drawings (~0.4-0.9 MB a character) are fetched only once
   you are live (camera or demo), for the lead only: the first load stays as
   light as v2.1. */
function loadExtraPoses(pack) {
  if (!pack || pack.extraLoading) return pack && pack.extraLoading;
  const base = PACKS_BASE + pack.id + '/';
  pack.extraLoading = Promise.all(EXTRA_KEYS.map(k => pack.poseInfo[k] && pack.poseInfo[k].file
    ? loadImage(base + pack.poseInfo[k].file).then(i => { pack.poses[k] = i; }).catch(() => {}) : null));
  return pack.extraLoading;
}
function goingLive() { const p = packs[cast.lead]; if (p) loadExtraPoses(p); else ensurePack(cast.lead, true).then(loadExtraPoses).catch(() => {}); }
const thumbSrc = id => 'assets/thumbs/' + id + '.webp';
function updateThumb(role, id) { const th = document.querySelector('#thumb-' + role); if (th) th.src = thumbSrc(id); }

function buildCasting() {
  leadStrip.innerHTML = '';
  for (const [id, name] of CAST) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'lead-pick'; b.dataset.id = id;
    b.setAttribute('aria-pressed', id === cast.lead ? 'true' : 'false');
    b.innerHTML = `<img loading="lazy" alt="" src="${thumbSrc(id)}"><span>${name}</span>`;
    b.addEventListener('click', () => setLead(id));
    leadStrip.appendChild(b);
  }
  for (const sel of [selLeft, selRight]) {
    sel.innerHTML = '';
    for (const [id, name] of CAST) { const o = document.createElement('option'); o.value = id; o.textContent = name; sel.appendChild(o); }
  }
  selLeft.value = cast.leftHand; selRight.value = cast.rightHand;
  updateThumb('left', cast.leftHand); updateThumb('right', cast.rightHand);
}
async function setLead(id) {
  cast.lead = id;
  for (const b of leadStrip.querySelectorAll('.lead-pick')) b.setAttribute('aria-pressed', b.dataset.id === id ? 'true' : 'false');
  state.poseName = 'base'; state.poseSide = null; state.candName = null; state.figInit = false;
  try { const p = await ensurePack(id, true); if (state.mode !== 'idle') loadExtraPoses(p); if (cast.lead === id) faWrap.hidden = !p.fa; } catch (e) { setMsg('Could not load that character — check your connection.'); }
}
selLeft.addEventListener('change', async () => { cast.leftHand = selLeft.value; updateThumb('left', cast.leftHand); if (chkCo.checked) ensurePack(cast.leftHand).catch(() => {}); });
selRight.addEventListener('change', async () => { cast.rightHand = selRight.value; updateThumb('right', cast.rightHand); if (chkCo.checked) ensurePack(cast.rightHand).catch(() => {}); });
chkFA.addEventListener('change', () => { state.freeArms = chkFA.checked; state.compSig = null; });
chkCo.addEventListener('change', () => {
  if (chkCo.checked) { ensurePack(cast.leftHand).catch(() => {}); ensurePack(cast.rightHand).catch(() => {}); if (state.mode === 'camera') ensureHands(); }
});

/* Placement geometry from the base art: a single alpha scan for the figure
   bounds plus the face proportions from the talk patches. */
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
  const pat = t.patches || {}, b = pack.poseInfo.base;
  const faceCx = b.eyes ? b.eyes[0] : (W / 2);
  const eyeY = b.eyes ? b.eyes[1] : (bbox.y0 + (bbox.y1 - bbox.y0) * 0.18);
  const mouthY = b.mouth ? b.mouth[1] : (eyeY + 70);
  const blinkW = pat.blink ? pat.blink.w : 140;
  const headH = (mouthY - eyeY) * 3.1;
  const top = Math.max(bbox.y0, eyeY - headH * 0.74);
  const neckY = top + headH * 1.06;
  const hipY = neckY + (bbox.y1 - top) * 0.44;
  const geom = { W, H, bbox, faceCx, eyeY, mouthY, blinkW, neckY, hipY, headTop: bbox.y0, bboxBottom: bbox.y1 };
  geomCache.set(pack, geom);
  return geom;
}

/* One Euro filter: headwarp.js (shared with the head tracker). */
function makePlacementFilters() {
  return { cx: new OneEuro(1.4, 0.04), feetY: new OneEuro(1.2, 0.03), h: new OneEuro(0.9, 0.015), roll: new OneEuro(1.8, 0.03) };
}

/* ---------- state ---------- */
const state = {
  mode: 'idle', pose: null, face: null, hands: [],
  recording: false, chunks: [], recorder: null, stream: null, recMime: '',
  recUrl: null, recBlob: null, recStart: 0, quality: 'high', reel: false,
  hpS: { yaw: 0, pitch: 0, roll: 0 }, msgAt: 0, lowFpsSince: 0, tint: 'rgba(120,70,50,0.20)', tintAt: 0,
  poseName: 'base', poseSide: null, candName: null, candSide: null, candSince: 0, poseSince: 0,
  wristHist: { a: [], b: [] }, fig: null, figInit: false, talkSm: 0, nextBlink: 0,
  gmem: makeGestureMemory(), headT: new HeadTracker(), head: { roll: 0, yaw: 0, pitch: 0, gest: null },
  warpScale: 1, waveFrame: 0, waveCx: null, waveFlipAt: 0, waveOscAt: 0, gestVia: null, drawKey: 'base', warpOn: false,
  leadFeetY: 0, leadH: 0, figDbg: null, mouthDbg: null, wakeLock: null, freeArms: true, armsDbg: null,
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
  // the face model runs on alternate frames and misses the odd frame: hold the
  // last face briefly so placement never jumps between face and body framing
  const now = performance.now();
  if (raw.face) { state.face = { landmarks: smoothLm(state.face && state.face.landmarks, raw.face.landmarks, alpha), cats: raw.face.cats }; state.faceAt = now; }
  else if (state.face) {
    // a hand over the face hides it from the face model: while a hand-to-face
    // gesture is on stage the last face is held (its expression is not)
    const hold = HAND_FACE.has(state.poseName) || HAND_FACE.has(state.candName) ? 3000 : 600;
    if (now - (state.faceAt || 0) > hold) state.face = null;
    else if (now - (state.faceAt || 0) > 150) state.face.stale = true;
  }
}

/* ---------- MediaPipe ----------
   Models are fetched with progress (shown on the ticket) and handed to
   MediaPipe as buffers. Pose + face load first so you are live sooner; the
   hand model (only needed for thumbs-up and co-actors) follows. */
let vision = null, Tasks = null, poseL = null, handL = null, faceL = null, lastVideoTime = -1, frameNo = 0;
let inferErrors = 0, cpuMode = false, lastPoseAt = 0, noPoseMsgAt = 0, modelsLoading = null, handsLoading = null;
const MODEL_FILES = {
  pose: 'pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
  face: 'face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  hand: 'hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'
};
const modelBufs = {};
async function fetchModel(key, onProgress) {
  if (modelBufs[key]) return modelBufs[key];
  const res = await fetch(`${MODEL}/${MODEL_FILES[key]}`);
  if (!res.ok) throw new Error('model download failed (' + res.status + ')');
  const total = +res.headers.get('content-length') || 0;
  if (!res.body || !total) { modelBufs[key] = new Uint8Array(await res.arrayBuffer()); return modelBufs[key]; }
  const reader = res.body.getReader(), parts = []; let got = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); got += value.length; onProgress && onProgress(got, total); }
  const buf = new Uint8Array(got); let o = 0; for (const p of parts) { buf.set(p, o); o += p.length; }
  modelBufs[key] = buf; return buf;
}
async function makeTask(Cls, key, extra, forceCpu) {
  const opts = d => Object.assign({ baseOptions: { modelAssetBuffer: modelBufs[key].slice(), delegate: d }, runningMode: 'VIDEO', numPoses: 1, numHands: 2 }, extra || {});
  if (forceCpu) return Cls.createFromOptions(vision, opts('CPU'));
  try { return await Cls.createFromOptions(vision, opts('GPU')); } catch (e) { return Cls.createFromOptions(vision, opts('CPU')); }
}
function initModels(forceCpu) {
  if (modelsLoading && !forceCpu) return modelsLoading;
  modelsLoading = (async () => {
    const prog = { pose: 0, face: 0 };
    const show = () => { statusModel.textContent = `Tracker: downloading ${Math.round((prog.pose + prog.face) / 2 * 100)}%`; };
    statusModel.textContent = 'Tracker: downloading…';
    const [mod] = await Promise.all([
      Tasks ? Promise.resolve(Tasks) : import(`https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VER}/vision_bundle.mjs`),
      fetchModel('pose', (g, t) => { prog.pose = g / t; show(); }),
      fetchModel('face', (g, t) => { prog.face = g / t; show(); })
    ]);
    Tasks = mod;
    statusModel.textContent = 'Tracker: starting…';
    if (!vision) vision = await Tasks.FilesetResolver.forVisionTasks(WASM);
    poseL = await makeTask(Tasks.PoseLandmarker, 'pose', null, forceCpu);
    faceL = await makeTask(Tasks.FaceLandmarker, 'face', { outputFaceBlendshapes: true }, forceCpu);
    statusModel.textContent = cpuMode ? 'Tracker: live ✅ (CPU mode)' : 'Tracker: live ✅';
    if (chkCo.checked || forceCpu) ensureHands(forceCpu);
    else setTimeout(() => ensureHands(), 1500); // thumbs-up reads the hand model too
  })();
  modelsLoading.catch(() => { modelsLoading = null; });
  return modelsLoading;
}
function ensureHands(forceCpu) {
  if (handL && !forceCpu) return Promise.resolve(handL);
  if (handsLoading && !forceCpu) return handsLoading;
  handsLoading = (async () => {
    await fetchModel('hand');
    handL = await makeTask(Tasks.HandLandmarker, 'hand', null, forceCpu || cpuMode);
    return handL;
  })();
  handsLoading.catch(() => { handsLoading = null; });
  return handsLoading;
}
/* Pose every frame (it carries the body); face and hands share the rest.
   Lower quality tiers spread the models thinner. */
function infer() {
  if (!poseL || !faceL || cam.readyState < 2 || cam.currentTime === lastVideoTime) return;
  lastVideoTime = cam.currentTime; frameNo++;
  const t = performance.now();
  const q = state.quality;
  const poseEvery = q === 'high' ? 1 : q === 'balanced' ? 2 : 3;
  const faceEvery = q === 'high' ? 1 : q === 'balanced' ? 2 : 3;
  const handEvery = q === 'high' ? 2 : q === 'balanced' ? 4 : 6;
  try {
    if (frameNo % poseEvery === 0) {
      const pr = poseL.detectForVideo(cam, t);
      raw.pose = pr.landmarks && pr.landmarks[0] ? pr.landmarks[0] : null;
      if (raw.pose) { lastPoseAt = performance.now(); inferErrors = 0; }
    }
    if (handL && frameNo % handEvery === 0) {
      const hr = handL.detectForVideo(cam, t);
      raw.hands = hr.landmarks || [];
    }
    if ((frameNo + 1) % faceEvery === 0) {
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
      cpuMode = true; poseL = null; faceL = null; handL = null;
      initModels(true).catch(() => { statusModel.textContent = 'Tracker failed — tap Start Camera to retry'; });
    }
  }
}

/* ---------- demo mode (synthetic performer) ----------
   A scripted actor made of the same landmarks the models emit (synth.js):
   tilts, waves, nods, shakes its head, gasps, says namaste, thinks, opens
   its arms and points — every path the camera uses, without a camera. */
const DEMO = ['tilt', 'wave', 'nod', 'shake', 'mouth', 'namaste', 'think', 'open', 'point'];
/* Demo "speech" (house standard, same rule as every Rigpop renderer):
   the mouth follows a speech envelope — fast syllable bursts inside a
   phrase, silence between phrases — never a slow continuous sine flap.
   Deterministic in t so tests and recordings are reproducible. */
function demoSpeech(s) {
  const ph = s % 3.2;
  if (ph > 2.0) return 0;
  const syl = Math.pow(Math.max(0, Math.sin(s * 34)), 2);
  const vary = 0.65 + 0.35 * Math.sin(s * 2.1 + 1.3);
  return Math.min(1, syl * vary * 1.15) * 0.6;
}
function synthDemo(t) {
  const s = t / 1000, bob = Math.sin(s * 1.6) * 0.008, phase = DEMO[Math.floor(s / 3.2) % DEMO.length], ps = (s % 3.2);
  const asp = MAP.sw / MAP.sh;
  const P = [];
  for (let i = 0; i < 33; i++) P.push({ x: 0.5, y: 0.5, z: 0, visibility: 1 });
  const set = (i, x, y) => { P[i] = { x, y: y + bob, z: 0, visibility: 1 }; };
  set(0, 0.5, 0.30); set(2, 0.515, 0.285); set(5, 0.485, 0.285); set(11, 0.56, 0.38); set(12, 0.44, 0.38);
  set(23, 0.54, 0.58); set(24, 0.46, 0.58);
  set(13, 0.60, 0.50); set(15, 0.63, 0.62); set(14, 0.40, 0.50); set(16, 0.37, 0.62);
  if (phase === 'wave') { set(14, 0.38, 0.30); set(16, 0.40 + Math.sin(s * 7) * 0.035, 0.16); }
  if (phase === 'point') { set(14, 0.32, 0.385); set(16, 0.20, 0.39); }
  if (phase === 'open') { set(13, 0.66, 0.28); set(15, 0.70, 0.17); set(14, 0.34, 0.28); set(16, 0.30, 0.17); }
  set(25, 0.55, 0.74); set(26, 0.45, 0.74); set(27, 0.56, 0.90); set(28, 0.44, 0.90);
  raw.pose = P;
  let roll = 0, yaw = 0, pitch = 0;
  if (phase === 'tilt') roll = Math.sin(ps * 1.9) * 0.32;
  if (phase === 'nod') pitch = ps > 0.3 ? Math.sin((ps - 0.3) * 9) * 0.4 : 0;
  if (phase === 'shake') yaw = ps > 0.3 ? Math.sin((ps - 0.3) * 9) * 0.55 : 0;
  if (phase === 'think') { roll = -0.12; yaw = 0.2; }
  const fy = 0.272 + bob, fw = 0.085;
  const talk = demoSpeech(s);
  const fl = synthFace({ x: 0.5, y: fy, w: fw, roll, yaw, pitch, aspect: asp, mouthOpen: phase === 'mouth' ? 0.4 : talk * 0.5 });
  const cats = { eyeBlinkLeft: (Math.sin(s * 0.9) > 0.97) ? 0.9 : 0.02, eyeBlinkRight: (Math.sin(s * 0.9) > 0.97) ? 0.9 : 0.02,
    jawOpen: phase === 'mouth' || phase === 'namaste' ? 0 : talk, mouthSmileLeft: 0.3, mouthSmileRight: 0.3, mouthFunnel: 0 };
  raw.face = { landmarks: fl, cats };
  const hands = [];
  const mouthY = fy + 0.315 * fw * asp, chinY = fy + 0.62 * fw * asp;
  if (phase === 'mouth') hands.push(synthHand({ x: 0.52, y: mouthY + 0.03 * asp, size: 0.04, angle: -0.35, shape: 'flat', aspect: asp }));
  if (phase === 'think') hands.push(synthHand({ x: 0.53, y: chinY + 0.07 * asp, size: 0.04, angle: -0.5, shape: 'point', aspect: asp }));
  if (phase === 'namaste') {
    hands.push(synthHand({ x: 0.508, y: 0.43, size: 0.04, angle: -0.08, shape: 'flat', aspect: asp, thumbSide: 1 }));
    hands.push(synthHand({ x: 0.492, y: 0.43, size: 0.04, angle: 0.08, shape: 'flat', aspect: asp, thumbSide: -1 }));
  }
  raw.hands = hands;
}

/* ---------- stage helpers ---------- */
function setMsg(t) { msgEl.textContent = t || ''; msgEl.style.opacity = t ? '1' : '0'; state.msgAt = performance.now(); }
/* Landmarks arrive normalised to the CAMERA frame. They are mapped onto the
   stage aspect-true with COVER (the camera fills the stage, overflow cropped),
   so the character stands where you stand on a portrait phone stage. */
const MAP = { sw: 1280, sh: 720, ox: 0, oy: 0 };
function updateMap() {
  const W = stage.width, H = stage.height;
  const srcA = (state.mode === 'camera' && cam.videoWidth) ? cam.videoWidth / cam.videoHeight : (state.mode === 'camera' && state.testAspect) || W / H; // testAspect: harness only
  let sw = W, sh = W / srcA;
  if (sh < H) { sh = H; sw = H * srcA; }
  MAP.sw = sw; MAP.sh = sh; MAP.ox = (W - sw) / 2; MAP.oy = (H - sh) / 2;
}
function toPx(p) { return { x: MAP.ox + (1 - p.x) * MAP.sw, y: MAP.oy + p.y * MAP.sh }; }
function mid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
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

/* Face state from the blendshape map. */
function faceState() {
  const out = { mouth: null, wide: false, blink: false, laugh: false };
  const c = (state.face && !state.face.stale && state.face.cats) || null;
  if (c) {
    const jaw = c.jawOpen || 0, smile = ((c.mouthSmileLeft || 0) + (c.mouthSmileRight || 0)) / 2;
    const stretch = c.mouthStretchLeft || 0, round = Math.max(c.mouthFunnel || 0, c.mouthPucker || 0);
    out.blink = (c.eyeBlinkLeft || 0) > 0.55 && (c.eyeBlinkRight || 0) > 0.55;
    out.laugh = jaw > 0.30 && smile > 0.45;
    if (jaw > 0.16) out.mouth = round > 0.38 ? 'O' : 'A';
    else if (smile > 0.38 || stretch > 0.30) { out.mouth = 'E'; out.wide = true; }
  }
  if (!out.mouth && state.face && !state.face.stale && state.face.landmarks) { // landmark fallback (mouth-open ratio)
    const lm = state.face.landmarks, up = lm[13], dn = lm[14], lf = lm[78], rt = lm[308];
    if (up && dn && lf && rt) {
      const wM = Math.hypot(rt.x - lf.x, rt.y - lf.y) || 1e-6;
      const ratio = Math.hypot(dn.x - up.x, dn.y - up.y) / wM;
      if (ratio > 0.30) out.mouth = 'A'; else if (ratio > 0.16) out.mouth = 'O';
    }
  }
  return out;
}
/* Face landmarks in stage pixels (the points the head tracker and the
   hand/face classifier read), rebuilt once per frame. */
const FACE_IDX = [1, 10, 13, 14, 33, 78, 152, 234, 263, 308, 454];
function faceStage() {
  const fl = state.face && state.face.landmarks;
  if (!fl) return null;
  const out = [];
  for (const i of FACE_IDX) if (fl[i]) out[i] = toPx(fl[i]);
  return out;
}
/* Head tilt / turn / nod from the face (headwarp.js), every frame. */
function updateHeadPose(now) {
  state.head = state.headT.update(state.face && !state.face.stale ? state.fs : null, now).params();
  state.hpS.roll = state.head.roll; state.hpS.yaw = state.head.yaw; state.hpS.pitch = state.head.pitch;
}

function elbowAngle(a, b, c) {
  const v1x = a.x - b.x, v1y = a.y - b.y, v2x = c.x - b.x, v2y = c.y - b.y;
  const d = (Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y)) || 1;
  return Math.acos(Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / d))) * 180 / Math.PI;
}
/* Gesture classifier: returns {name, side} ('L'/'R' = the side of the STAGE
   the gesturing arm is on) or null. Each arm is judged on its own, so the
   usual selfie — one hand holding the phone, out of frame — still waves,
   points and gives thumbs-up with the free arm. A joint that is not clearly
   visible is refused, never followed into garbage. Distances are in
   shoulder widths, so the same gesture reads the same at any distance. */
function classifyArms() {
  const lm = state.pose;
  if (!lm) return null;
  const vis = i => (lm[i].visibility ?? 1);
  const inFrame = i => lm[i].x > -0.02 && lm[i].x < 1.02 && lm[i].y > -0.02 && lm[i].y < 1.02;
  if (vis(11) < 0.5 || vis(12) < 0.5) { state.gestDbg = { shoulders: false }; return null; }
  const p = i => toPx(lm[i]);
  const shoW = Math.max(24, Math.hypot(p(12).x - p(11).x, p(12).y - p(11).y));
  const nose = p(0);
  const arm = (si, ei, wi, hist) => {
    // the wrist carries wave/open/point; the elbow (often out of frame at
    // selfie distance) is only needed to know the arm is straight
    if (!(vis(wi) > 0.4 && inFrame(wi))) { hist.length = 0; return { refused: true, vw: +vis(wi).toFixed(2), wx: +lm[wi].x.toFixed(2), wy: +lm[wi].y.toFixed(2) }; }
    const elbOk = vis(ei) > 0.35 && inFrame(ei);
    const sho = p(si), elb = elbOk ? p(ei) : null, wri = p(wi);
    hist.push({ x: wri.x, t: performance.now() });
    while (hist.length && performance.now() - hist[0].t > 900) hist.shift();
    let rev = 0, lastD = 0;
    for (let i = 1; i < hist.length; i++) {
      const d = hist[i].x - hist[i - 1].x;
      if (Math.abs(d) < shoW * 0.04) continue;
      if (lastD && d * lastD < 0) rev++;
      lastD = d;
    }
    return {
      sho, elb, wri, side: wri.x < (p(11).x + p(12).x) / 2 ? 'L' : 'R',
      raised: wri.y < sho.y - shoW * 0.25, high: wri.y < nose.y + shoW * 0.1,
      straight: !!elb && elbowAngle(sho, elb, wri) > 150, osc: rev >= 2
    };
  };
  const A = arm(11, 13, 15, state.wristHist.a), B = arm(12, 14, 16, state.wristHist.b);
  const dbg = s => s && !s.refused ? { side: s.side, raised: s.raised, high: s.high, osc: s.osc, straight: s.straight } : s;
  state.gestDbg = { A: dbg(A), B: dbg(B) };
  const arms = [A, B].filter(s => s && !s.refused);
  const okA = A && !A.refused ? A : null, okB = B && !B.refused ? B : null;
  if (okA && okB && okA.raised && okB.raised && !(okA.osc !== okB.osc && (okA.osc || okB.osc) && Math.abs(okA.wri.y - okB.wri.y) > shoW * 0.6)) return { name: 'open', side: null };
  for (const s of arms) if (s.raised && (s.osc || s.high)) return { name: 'wave', side: s.side, osc: s.osc, x: s.wri.x, size: shoW * 0.5 };
  for (const s of arms) {
    const other = s === okA ? okB : okA;
    const reach = Math.abs(s.wri.x - s.sho.x);
    if (s.straight && Math.abs(s.wri.y - s.sho.y) < shoW * 0.45 && reach > shoW * 0.75 &&
        !(other && other.raised) && (!other || reach > Math.abs(other.wri.x - other.sho.x) * 1.5)) return { name: 'point', side: s.side };
  }
  return null;
}
/* The whole classifier: hands at the face and two-hand gestures first (the
   most specific), then the arms (whole-arm wave, point, both arms open),
   then hand shapes (thumbs, fist, index point, open palm). */
function classifyGesture(now) {
  now = now || performance.now();
  const hands = state.hands.map(h => h.map(toPx));
  const hf = classifyHandsFace({ hands, face: state.fs, cur: state.poseName, now, mem: state.gmem, stageW: stage.width });
  state.gestDbg = Object.assign(state.gestDbg || {}, { hf: hf && hf.name });
  if (hf && !['palm', 'wave', 'thumbs', 'point', 'fist'].includes(hf.name)) return hf;
  const arm = classifyArms();
  if (arm) return arm;
  return hf;
}
/* Time-based hysteresis (frame counts mean different things at 10 and 60 fps):
   a gesture must hold 160 ms to enter, its absence 450 ms to return to base,
   and every pose is held at least 600 ms — so swaps are hard cuts, never flicker. */
function updatePoseChoice(now) {
  const c = classifyGesture(now);
  let name = c ? c.name : null;
  const side = c ? c.side : null;
  if (name === 'palm') name = 'wave'; // a held open palm is the wave drawing, held still
  if (name !== state.candName || (name && side !== state.candSide)) { state.candName = name; state.candSide = side; state.candSince = now; }
  const want = name || 'base';
  const held = now - state.candSince;
  const enter = name && HAND_FACE.has(name) ? 200 : 160;
  if ((want !== state.poseName || (name && side !== state.poseSide)) && held >= (name ? enter : 450) && now - state.poseSince > 600) {
    state.poseName = want; state.poseSide = side; state.poseSince = now; state.waveFrame = 0; state.waveCx = null;
  }
  state.gestVia = c ? (c.via || 'arm') : null;
  // the wave's two drawn frames follow your hand: frame 1 (the forearm
  // leaning in toward the head) when it swings in past its running centre,
  // frame 0 when it swings back out (hard cuts,
  // never faster than every 90 ms); a held palm stays on frame 0
  if (state.poseName === 'wave' && c && c.name === 'wave' && typeof c.x === 'number') {
    const osc = c.osc !== false;
    if (osc) state.waveOscAt = now;
    if (state.waveCx === null) state.waveCx = c.x;
    state.waveCx += (c.x - state.waveCx) * 0.12;
    const d = c.x - state.waveCx, thr = (c.size || 40) * 0.18;
    if (now - state.waveOscAt < 450 && now - state.waveFlipAt > 90) {
      const inward = (state.poseSide === 'L') ? d > thr : d < -thr, outward = (state.poseSide === 'L') ? d < -thr * 0.3 : d > thr * 0.3;
      if (state.waveFrame === 0 && inward) { state.waveFrame = 1; state.waveFlipAt = now; }
      else if (state.waveFrame === 1 && outward) { state.waveFrame = 0; state.waveFlipAt = now; }
    } else if (now - state.waveOscAt >= 450) state.waveFrame = 0;
  } else if (state.poseName !== 'wave' || performance.now() - state.waveOscAt > 450) state.waveFrame = 0;
}

/* Draws the figure for the current pose. Each pose drawing is mapped onto the
   base drawing by its face (anchor + measured drawing scale), mirrored when
   you gesture with the other arm, and its face tiles are drawn inside the same
   transform — so the face can never split from the head, and a pose swap never
   resizes or teleports the character. */
/* Which drawing performs the current gesture for this pack: its own drawing
   if it has one (the wave's second frame when the hand swings in), else the
   nearest drawing it does have, with a matching face on the base drawing. */
function resolvePose(pack, name, frame) {
  let key = name || 'base', fbFace = null;
  if (key === 'wave' && frame === 1 && pack.poses.wave2) key = 'wave2';
  if (key !== 'base' && !pack.poses[key]) {
    const fb = FALLBACK[key];
    fbFace = FALLBACK_FACE[key] || null;
    key = fb && fb !== 'base' && pack.poses[fb] ? fb : 'base';
    if (key !== 'base') fbFace = null;
  }
  return { key, fbFace, sway: name === 'wave' && frame === 1 && key === 'wave' };
}
let headGL = null, compCv = null;
const PAD = 90; // margin around the drawing for the head to move into
const freeArmsOn = pack => !!(pack && pack.fa && state.freeArms);
/* Free arms: your landmarks → the drawing's own pixels (the inverse of the
   figure transform), then the arm rig solves and draws there. */
function updateFreeArms(pack, now) {
  const m = ctx.getTransform(), inv = m.inverse();
  const toD = p => ({ x: inv.a * p.x + inv.c * p.y + inv.e, y: inv.b * p.x + inv.d * p.y + inv.f });
  const live = state.mode !== 'idle';
  const lm = live ? state.pose : null;
  const pose = lm ? lm.map(q => { const d = toD(toPx(q)); d.z = q.z || 0; d.v = q.visibility ?? 1; return d; }) : null;
  const hands = live ? (raw.hands || []).filter(hh => hh && hh.length === 21).map(hh => hh.map(q => { const d = toD(toPx(q)); d.z = q.z || 0; return d; })) : [];
  const fs = live ? state.fs : null;
  const face = fs && fs[33] && fs[263] && fs[13] ? { eyes: toD(mid(fs[33], fs[263])), mouth: toD(fs[13]) } : null;
  pack.fa.update(pose, hands, face, now);
  const T = q => q && [Math.round(m.a * q.x + m.c * q.y + m.e), Math.round(m.b * q.x + m.d * q.y + m.f)];
  const arm = a => a && { S: T(a.S), E: T(a.E), W: T(a.W), tips: [4, 8, 12, 16, 20].map(i => T(a.hand[i])), hand: a.hand.map(T), live: a.live, stretch: +a.stretch.toFixed(3), faceW: +(a.faceW || 0).toFixed(2) };
  const d = pack.fa.dbg;
  state.armsDbg = { k: d.k && +d.k.toFixed(3), hands: d.hands, L: arm(d.L), R: arm(d.R), back: { L: pack.fa.arms.L.back, R: pack.fa.arms.R.back }, scale: Math.hypot(m.a, m.b) };
}
function drawFigure(pack, now, cx, feetY, h, roll) {
  const G = packGeom(pack);
  const fa = freeArmsOn(pack);
  const r = fa ? { key: 'base', fbFace: null, sway: false } : resolvePose(pack, state.poseName, state.waveFrame);
  const key = r.key;
  state.drawKey = fa ? 'free' : key;
  if (!fa) state.armsDbg = null;
  const img = fa ? pack.img.torso : key === 'base' ? pack.img.base : pack.poses[key];
  if (!img) return;
  const pi = pack.poseInfo[key] || {}, bi = pack.poseInfo.base || {};
  if (r.sway) roll += (state.poseSide === 'L' ? 1 : -1) * 0.05; // no 2nd wave drawing: lean the figure instead
  const s = h / G.H;
  const fs = faceState();
  if (r.fbFace) { if ('mouth' in r.fbFace) { fs.mouth = r.fbFace.mouth; fs.laugh = false; fs.wide = false; } if (r.fbFace.blink) fs.blink = true; }
  const faceMode = pi.face || 'full';
  const allowMouth = faceMode === 'full' || faceMode === 'mouth', allowEyes = faceMode === 'full' || faceMode === 'eyes';
  state.talkSm += ((fs.mouth ? 1 : 0) - state.talkSm) * 0.3;
  const bob = Math.sin(now / 340) * 1.1 + state.talkSm * Math.sin(now / 85) * 1.7;
  const breath = 1 + 0.007 * Math.sin(now / 1500);
  shadow(cx, Math.min(stage.height - 5, feetY + bob * s * 8), G.W * s * 0.60);
  ctx.save();
  ctx.translate(cx, feetY + bob * s * 8); ctx.rotate(roll); ctx.scale(s, s * breath);
  ctx.translate(-G.W / 2, -G.bboxBottom); // now in base-drawing pixels
  // pose drawing -> base drawing: match the face centre and the drawing scale
  const fc = a => a.mouth && a.eyes ? [(a.mouth[0] + a.eyes[0]) / 2, (a.mouth[1] + a.eyes[1]) / 2] : null;
  const bF = fc(bi), pF = fc(pi);
  const k = clamp(1 / (pi.scale || 1), 0.7, 1.6);
  const mirror = key !== 'base' && pi.side && state.poseSide && pi.side !== state.poseSide;
  if (key !== 'base' && bF && pF) {
    ctx.translate(bF[0], bF[1]); if (mirror) ctx.scale(-1, 1); ctx.scale(k, k); ctx.translate(-pF[0], -pF[1]);
  } else if (mirror) {
    ctx.translate(G.W / 2, 0); ctx.scale(-1, 1); ctx.translate(-G.W / 2, 0);
  }
  if (pi.eyes && pi.mouth) { // where this drawing's face lands on stage (tests + debugging)
    const m = ctx.getTransform(), T = q => [m.a * q[0] + m.c * q[1] + m.e, m.b * q[0] + m.d * q[1] + m.f];
    const e = T(pi.eyes), mo = T(pi.mouth);
    state.faceDbg = [Math.round((e[0] + mo[0]) / 2), Math.round((e[1] + mo[1]) / 2), Math.round(Math.hypot(e[0] - mo[0], e[1] - mo[1]))];
  } else state.faceDbg = null;
  // the drawing + its face tiles, in drawing pixels; then (when the head
  // moves) the head warp over the whole composite, so tiles move with it
  const hk = state.head || { roll: 0, yaw: 0, pitch: 0 };
  const mirrored = !!(ctx.getTransform().a * ctx.getTransform().d - ctx.getTransform().b * ctx.getTransform().c < 0);
  const headRoll = clamp(state.headRoll || 0, -0.45, 0.45);
  const kh = { roll: mirrored ? -headRoll : headRoll, yaw: mirrored ? -hk.yaw : hk.yaw, pitch: hk.pitch };
  const warpable = pi.headWarp !== false && pi.head && !pi.head.nowarp && !!state.face;
  const moving = Math.abs(kh.roll) > 0.004 || Math.abs(kh.yaw) > 0.01 || Math.abs(kh.pitch) > 0.01;
  if (warpable && moving && !headGL) headGL = new HeadWarpGL();
  const useWarp = warpable && moving && headGL && headGL.ok;
  state.warpOn = !!useWarp; state.warpable = warpable;
  const patches = (pack.manifest.talk || {}).patches || {};
  const tileScale = pi.scale || 1;
  const autoBlink = !state.face && now > state.nextBlink && now < state.nextBlink + 130;
  const showBlink = allowEyes && (fs.blink || autoBlink) && pack.tiles.blink && patches.blink && pi.eyes;
  const mouthKey = allowMouth ? (fs.mouth || (fs.laugh ? 'E' : null)) : null;
  const showMouth = mouthKey && pack.tiles[mouthKey] && patches[mouthKey] && pi.mouth;
  const sig = pack.id + '|' + key + (fa ? '+fa' : '') + '|' + (showBlink ? 1 : 0) + '|' + (showMouth ? mouthKey + ((fs.wide || fs.laugh) ? 'w' : '') : '-');
  let g = ctx, off = 0, upload = true;
  if (useWarp) {
    if (!compCv) compCv = document.createElement('canvas');
    const ws = state.warpScale, cw = Math.round((G.W + 2 * PAD) * ws), ch = Math.round((G.H + 2 * PAD) * ws);
    if (compCv.width !== cw || compCv.height !== ch) { compCv.width = cw; compCv.height = ch; state.compSig = null; }
    upload = sig !== state.compSig; state.compSig = sig;
    g = compCv.getContext('2d'); off = PAD;
    if (upload) { g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, cw, ch); g.setTransform(ws, 0, 0, ws, 0, 0); }
  } else state.compSig = null;
  state.mouthDbg = showMouth ? mouthKey : null;
  if (fa) { updateFreeArms(pack, now); pack.fa.draw(ctx, 'back', null, G.W, G.H); } // arms behind the back
  if (!useWarp || upload) {
    g.drawImage(img, off, off, G.W, G.H);
    if (showBlink) {
      const tw = patches.blink.w * tileScale, th = tw * pack.tiles.blink.naturalHeight / pack.tiles.blink.naturalWidth;
      g.drawImage(pack.tiles.blink, off + pi.eyes[0] - tw / 2, off + pi.eyes[1] - th / 2, tw, th);
    }
    if (showMouth) {
      const tw = patches[mouthKey].w * tileScale * ((fs.wide || fs.laugh) ? 1.2 : 1);
      const th = tw * pack.tiles[mouthKey].naturalHeight / pack.tiles[mouthKey].naturalWidth;
      g.drawImage(pack.tiles[mouthKey], off + pi.mouth[0] - tw / 2, off + pi.mouth[1] - th / 2, tw, th);
    }
  }
  if (useWarp) {
    const ws = state.warpScale, Hs = { c: [pi.head.c[0] * ws, pi.head.c[1] * ws], r: [pi.head.r[0] * ws, pi.head.r[1] * ws], pivot: [pi.head.pivot[0] * ws, pi.head.pivot[1] * ws] };
    const out = headGL.render(compCv, PAD * ws, Hs, kh, upload) || compCv;
    ctx.drawImage(out, -PAD, -PAD, G.W + 2 * PAD, G.H + 2 * PAD);
    // where the warped face lands (tests): the face centre through the warp
    if (pi.eyes && pi.mouth) {
      const fcx = (pi.eyes[0] + pi.mouth[0]) / 2, fcy = (pi.eyes[1] + pi.mouth[1]) / 2;
      const q = warpPoint([fcx, fcy], pi.head, kh), m = ctx.getTransform();
      state.faceWarpDbg = [Math.round(m.a * q[0] + m.c * q[1] + m.e), Math.round(m.b * q[0] + m.d * q[1] + m.f)];
    }
  } else state.faceWarpDbg = null;
  // free arms in front of the body — and of the face, so covering it or "shh" just works
  if (fa) pack.fa.draw(ctx, 'front', pack.img.hairFront, G.W, G.H);
  ctx.restore();
  if (!state.face && now > state.nextBlink + 130) state.nextBlink = now + 2400 + Math.random() * 1800;
  state.leadFeetY = feetY; state.leadH = h; state.leadCx = cx;
  state.leadW = (G.bbox.x1 - G.bbox.x0) * s * 0.7; // body, not flowing hair
}

function drawLead(now) {
  const pack = packs[cast.lead];
  if (!pack || !pack.img.base) return;
  const W = stage.width, H = stage.height, G = packGeom(pack);
  if (!state.fig) state.fig = makePlacementFilters();
  let tcx, tFeetY, th, troll, live = false, how = 'idle';
  const lm = state.pose;
  state.fs = faceStage();
  updateHeadPose(now);
  // gestures read the arms, the hands and the face — in every framing, selfie included
  if (lm || state.hands.length || state.face) updatePoseChoice(now);
  const hs = state.warpable ? 0.12 : 1; // share of your head tilt the whole figure takes
  // MediaPipe hallucinates hips below the frame at selfie distance; the torso
  // branch only runs when the hips are really in frame.
  const inFrame = p => p && p.x > -0.05 && p.x < 1.05 && p.y > -0.05 && p.y < 1.02;
  const hipsVis = !!(lm && inFrame(lm[23]) && inFrame(lm[24]) && (lm[23].visibility ?? 1) > 0.55 && (lm[24].visibility ?? 1) > 0.55);
  if (lm && hipsVis && lm[11] && lm[12]) {
    // full / upper body: the figure stands where you stand, sized by your torso
    const neckC = mid(toPx(lm[11]), toPx(lm[12])), hipC = mid(toPx(lm[23]), toPx(lm[24]));
    const torsoLive = Math.max(26, Math.hypot(hipC.x - neckC.x, hipC.y - neckC.y));
    th = clamp((G.H * torsoLive) / Math.max(60, G.hipY - G.neckY), H * 0.3, H * 1.12);
    let s = th / G.H;
    tcx = hipC.x; tFeetY = hipC.y + (G.bboxBottom - G.hipY) * s;
    // whole body in frame: stand on your feet with eyes at your eye line —
    // cartoon proportions (big head, short torso) make torso scaling float
    const ankOk = i => inFrame(lm[i]) && (lm[i].visibility ?? 1) > 0.5;
    if (ankOk(27) && ankOk(28) && (lm[2].visibility ?? 1) > 0.5 && (lm[5].visibility ?? 1) > 0.5) {
      const ank = mid(toPx(lm[27]), toPx(lm[28])), eyeP = mid(toPx(lm[2]), toPx(lm[5]));
      const span = (ank.y - eyeP.y) * 1.04; // ankle -> sole
      if (span > H * 0.2 && eyeP.y < neckC.y) { // eyes must sit above the shoulders
        th = clamp((G.H * span) / Math.max(60, G.bboxBottom - G.eyeY), H * 0.3, H * 1.12);
        tFeetY = eyeP.y + span; s = th / G.H;
      }
    }
    const tilt = Math.atan2(neckC.y - hipC.y, neckC.x - hipC.x) + Math.PI / 2;
    troll = clamp(tilt * 0.55 + state.hpS.roll * 0.25 * hs, -0.32, 0.32);
    live = true; how = 'body';
  } else if (state.face && state.face.landmarks) {
    // face framing (the usual selfie): the character's face sits on yours
    const fl = state.face.landmarks, le = fl[33], re = fl[263];
    if (le && re) {
      const a = toPx(le), b = toPx(re);
      const eyeSpan = Math.hypot(b.x - a.x, b.y - a.y), eyeC = mid(a, b);
      // capped so head-to-waist stays on stage: a selfie face is far bigger
      // than a cartoon face at body scale, and gestures need room
      th = clamp((G.H * eyeSpan) / Math.max(20, G.blinkW), H * 0.45, H * 1.0);
      const s = th / G.H;
      tcx = eyeC.x + (G.W / 2 - G.faceCx) * s;
      tFeetY = eyeC.y + (G.bboxBottom - G.eyeY) * s;
      troll = clamp(state.hpS.roll * 0.6 * hs, -0.35, 0.35);
      live = true; how = 'face';
    }
  }
  if (!live && lm && lm[11] && lm[12] && (lm[11].visibility ?? 1) > 0.5 && (lm[12].visibility ?? 1) > 0.5) {
    // shoulders only: scale from shoulder width, stand on the neck line
    const neckC = mid(toPx(lm[11]), toPx(lm[12]));
    const shoLive = Math.max(20, Math.hypot(toPx(lm[12]).x - toPx(lm[11]).x, toPx(lm[12]).y - toPx(lm[11]).y));
    th = clamp((G.H * shoLive) / (G.blinkW * 1.86), H * 0.3, H * 1.0);
    const s = th / G.H;
    tcx = neckC.x; tFeetY = neckC.y + (G.bboxBottom - G.neckY) * s;
    troll = clamp(state.hpS.roll * 0.3 * hs, -0.3, 0.3);
    live = true; how = 'shoulders';
  }
  if (!live) { // idle stage pose
    th = H * (state.reel ? 0.62 : 0.86); tcx = W / 2; tFeetY = H * 0.965; troll = 0;
    if (state.poseName !== 'base') { state.poseName = 'base'; state.poseSide = null; state.poseSince = now; }
  }
  // keep the whole head on stage (with headroom for a raised hand) and the
  // figure horizontally on stage — tracking near the frame edge must never
  // push the face out of the film
  const s0 = th / G.H;
  const headTopY = tFeetY - (G.bboxBottom - G.headTop) * s0;
  const minTop = H * (live ? 0.07 : 0.04);
  if (headTopY < minTop) tFeetY += minTop - headTopY;
  const halfW = (G.bbox.x1 - G.bbox.x0) * s0 * 0.35;
  tcx = clamp(tcx, Math.min(W / 2, halfW), Math.max(W / 2, W - halfW));
  if (!state.figInit) { // snap on the first frame / after a cast change
    state.fig.cx.snap(tcx); state.fig.feetY.snap(tFeetY); state.fig.h.snap(th); state.fig.roll.snap(troll);
    state.figInit = true;
  }
  const cx = state.fig.cx.filter(tcx, now), feetY = state.fig.feetY.filter(tFeetY, now);
  const h = state.fig.h.filter(th, now), roll = state.fig.roll.filter(troll, now);
  // the head takes the rest of your tilt (relative to the figure), so the
  // character's head ends up at your head's angle
  state.headRoll = live ? state.hpS.roll - roll : 0;
  state.figDbg = { how, cx: Math.round(cx), feetY: Math.round(feetY), h: Math.round(h), headTop: Math.round(feetY - (G.bboxBottom - G.headTop) * h / G.H) };
  drawFigure(pack, now, cx, feetY, h, roll);
}

/* ---------- co-actors: your hands conduct them, full-size on the floor ---------- */
function drawCoActors(now) {
  const W = stage.width, H = stage.height;
  for (const h of state.hands) {
    if (!h[9]) continue;
    const mcp = toPx(h[9]);
    const a = state.actors[mcp.x < W / 2 ? 'left' : 'right'];
    a.tx = clamp(mcp.x, W * 0.12, W * 0.88); a.last = now;
    a.talkT = Math.hypot(h[4].x - h[8].x, h[4].y - h[8].y) < 0.045 ? 1 : 0;
  }
  // the stage floor: the lead's feet when they are on stage, else the boards
  const floorY = Math.min(state.leadFeetY || H, H * 0.97);
  const baseH = Math.min(state.leadH || H * 0.7, H * 0.8) * 0.72;
  for (const sideName of ['left', 'right']) {
    const a = state.actors[sideName];
    const id = sideName === 'left' ? cast.leftHand : cast.rightHand, pack = packs[id];
    if (!pack && !packLoads[id]) ensurePack(id).catch(() => {}); // fetched on first use
    a.p += (((now - a.last < 900) ? 1 : 0) - a.p) * 0.07;
    a.talk += ((a.talkT || 0) - a.talk) * 0.3;
    if (!pack || !pack.img.base || a.p < 0.02) continue;
    const img = pack.img.base;
    const ar = img.naturalWidth / img.naturalHeight;
    // on a narrow stage next to a big lead there is little room: the co-actor
    // shrinks to the space beside the lead (peeking in from the wings)
    const room = state.leadCx ? (sideName === 'left' ? state.leadCx - (state.leadW || 0) / 2 : W - state.leadCx - (state.leadW || 0) / 2) : W;
    const fullH = Math.min(baseH, floorY * 0.85, Math.max(W * 0.22, room * 1.5) / ar), h = fullH * (0.25 + 0.75 * a.p);
    const w = h * ar;
    // co-actors stand BESIDE the lead, never on top of them (the narrow 9:16
    // stage put both hands' actors over the lead's body)
    const sep = (state.leadW || W * 0.2) * 0.5 + w * 0.45;
    let tx = a.tx || (sideName === 'left' ? 0 : W);
    if (state.leadCx) tx = sideName === 'left' ? Math.min(tx, state.leadCx - sep) : Math.max(tx, state.leadCx + sep);
    tx = clamp(tx, w * 0.12, W - w * 0.12);
    if (!a.x) a.x = tx;
    a.x += (tx - a.x) * 0.12;
    const feetY = floorY + (1 - a.p) * fullH * 0.75;
    const bobA = Math.sin(now / 300 + (sideName === 'left' ? 0 : 2)) * 3 + (a.talk > 0.5 ? Math.sin(now / 60) * 4 : 0);
    ctx.save(); ctx.globalAlpha = Math.min(1, a.p * 1.6);
    shadow(a.x, Math.min(H - 4, feetY), w * 0.75);
    ctx.translate(a.x, feetY + bobA * a.p);
    ctx.rotate(clamp((tx - a.x) * 0.0009, -0.08, 0.08));
    ctx.drawImage(img, -w / 2, -h, w, h);
    const bi = pack.poseInfo.base, pat = (pack.manifest.talk || {}).patches || {};
    if (a.talk > 0.5 && pack.tiles.O && bi.mouth && pat.O) {
      drawTile(pack.tiles.O, -w / 2 + bi.mouth[0] / img.naturalWidth * w, -h + bi.mouth[1] / img.naturalHeight * h, pat.O.w * (w / img.naturalWidth) * 1.15, 0);
    }
    ctx.restore();
  }
}

/* ---------- render loop ---------- */
function fitStage() {
  const w = state.reel ? 720 : 1280, h = state.reel ? 1280 : 720;
  if (stage.width !== w || stage.height !== h) { stage.width = w; stage.height = h; state.figInit = false; }
}
function roundRectPath(x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function wrapLines(text, maxW) {
  const words = text.split(/\s+/), lines = []; let cur = '';
  for (const w of words) { const t = cur ? cur + ' ' + w : w; if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t; }
  if (cur) lines.push(cur);
  return lines.slice(0, 3);
}
let fpsLast = 0, fpsEMA = 60, lastFrameT = 0;
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
  // NO camera pixels reach the stage: the room contributes one average colour,
  // sampled twice a second (a per-frame GPU readback stalls phone GPUs)
  if (state.mode === 'camera' && cam.readyState >= 2 && ts - state.tintAt > 500) {
    state.tintAt = ts;
    if (!state.bg) { state.bg = document.createElement('canvas'); state.bg.width = 1; state.bg.height = 1; }
    try {
      const bgc = state.bg.getContext('2d', { willReadFrequently: true });
      bgc.drawImage(cam, 0, 0, 1, 1);
      const px = bgc.getImageData(0, 0, 1, 1).data; state.tint = `rgba(${px[0]},${px[1]},${px[2]},0.20)`;
    } catch (e) { /* keep last */ }
  }
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#3d1522'); g.addColorStop(0.75, '#2b1219'); g.addColorStop(1, '#59331f');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  if (state.mode === 'camera') {
    const rg = ctx.createRadialGradient(W / 2, H * 0.42, 40, W / 2, H * 0.42, Math.max(W, H) * 0.62);
    rg.addColorStop(0, state.tint); rg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = rg; ctx.fillRect(0, 0, W, H);
  }
  ctx.fillStyle = '#6d4423'; ctx.fillRect(0, H * 0.94, W, H * 0.06);
  const fg = ctx.createLinearGradient(0, H * 0.8, 0, H);
  fg.addColorStop(0, 'rgba(40,20,10,0)'); fg.addColorStop(1, 'rgba(40,20,10,0.55)');
  ctx.fillStyle = fg; ctx.fillRect(0, H * 0.8, W, H * 0.2);
  drawLead(ts || performance.now());
  if (state.mode !== 'idle' && chkCo.checked) drawCoActors(ts || 0);
  // honest guidance: camera is on but nobody is found
  if (state.mode === 'camera' && poseL && !state.pose && !state.face && performance.now() - lastPoseAt > 3000 && (ts || 0) - noPoseMsgAt > 8000) {
    noPoseMsgAt = ts || 0;
    setMsg('I can\'t see you yet — face the phone in good light. Step back so your shoulders show to unlock gestures.');
  }
  const cap = captionInput.value.trim();
  if (cap) {
    ctx.save(); const fsz = Math.round(Math.min(W, H) * 0.052);
    ctx.font = `700 ${fsz}px 'Space Grotesk', system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const lines = wrapLines(cap, W * 0.84), lh = fsz * 1.25;
    const tw = Math.max(...lines.map(l => ctx.measureText(l).width)) + fsz * 1.4, th = lines.length * lh + fsz * 0.7;
    const y0 = H - th - H * 0.035;
    ctx.fillStyle = 'rgba(20,8,10,0.74)'; roundRectPath(W / 2 - tw / 2, y0, tw, th, 14); ctx.fill();
    ctx.fillStyle = '#ffe9b8';
    lines.forEach((l, i) => ctx.fillText(l, W / 2, y0 + fsz * 0.35 + lh * (i + 0.5)));
    ctx.restore();
  }
  if (state.recording) {
    const s = Math.floor((Date.now() - state.recStart) / 1000);
    btnRec.textContent = `■ Stop · ${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }
  if (msgEl.textContent && performance.now() - state.msgAt > 7000) msgEl.style.opacity = '0';
  dotPose.classList.toggle('on', !!state.pose);
  dotHand.classList.toggle('on', state.hands.length > 0);
  dotFace.classList.toggle('on', !!state.face);
  if (ts - fpsLast > 1000) { fpsEl.textContent = Math.round(fpsEMA) + ' fps'; fpsLast = ts; }
  // the head warp renders at 70 % on a struggling GPU (it is upscaled back)
  if (state.warpOn && fpsEMA < 22 && state.warpScale > 0.7) {
    if (!state.slowWarpSince) state.slowWarpSince = ts;
    if (ts - state.slowWarpSince > 3000) { state.warpScale = 0.7; state.compSig = null; }
  } else state.slowWarpSince = 0;
  // auto-quality: if the stage struggles, shed load tier by tier and say so
  if (state.mode === 'camera' && poseL && fpsEMA < 17 && state.quality !== 'performance') {
    if (!state.lowFpsSince) state.lowFpsSince = ts;
    if (ts - state.lowFpsSince > 5000) {
      state.quality = state.quality === 'high' ? 'balanced' : 'performance';
      selQuality.value = state.quality; state.lowFpsSince = 0;
      statusModel.textContent = 'Tracker: live ✅ (auto-' + state.quality + ')';
    }
  } else state.lowFpsSince = 0;
}

/* ---------- controls ---------- */
function cameraErrorText(e) {
  const n = e && e.name;
  if (n === 'NotAllowedError' || n === 'SecurityError') return 'Camera permission was blocked. Allow the camera for this site in your browser settings, then tap Start Camera again.';
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'No front camera was found on this device. Demo Mode still works.';
  if (n === 'NotReadableError' || n === 'AbortError') return 'The camera is busy in another app. Close it and tap Start Camera again.';
  return 'The camera could not start (' + ((e && e.message) || n || 'unknown') + '). Try again, or use Demo Mode.';
}
async function openCamera() {
  if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    const err = new Error('the camera needs an https:// address'); err.name = 'SecurityError'; throw err;
  }
  const video = { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30, max: 30 } };
  const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  try { return { stream: await navigator.mediaDevices.getUserMedia({ video, audio }), mic: true }; }
  catch (e) {
    if (e && (e.name === 'NotAllowedError' || e.name === 'NotFoundError' || e.name === 'NotReadableError')) {
      // mic refused or missing: perform anyway, the film is silent
      return { stream: await navigator.mediaDevices.getUserMedia({ video, audio: false }), mic: false };
    }
    throw e;
  }
}
async function keepAwake() {
  try { if ('wakeLock' in navigator && !state.wakeLock) { state.wakeLock = await navigator.wakeLock.request('screen'); state.wakeLock.addEventListener('release', () => { state.wakeLock = null; }); } } catch (e) { /* optional */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.mode === 'camera') keepAwake();
  if (document.visibilityState === 'hidden' && state.recording) state.recorder.stop(); // a backgrounded tab stops drawing frames
});
btnCam.addEventListener('click', async () => {
  if (state.mode === 'camera') return;
  btnCam.disabled = true;
  // the camera is asked for first, inside the tap (iOS requires the gesture),
  // and the tracker downloads in parallel — you are on stage at once
  const models = initModels();
  models.catch(() => {});
  let mic = false;
  try {
    const r = await openCamera(); mic = r.mic;
    cam.srcObject = r.stream; cam.muted = true; cam.setAttribute('playsinline', ''); await cam.play();
    if (state.stream) state.stream.getTracks().forEach(t => t.stop());
    state.stream = r.stream; state.mode = 'camera'; raw.pose = null; raw.face = null; raw.hands = [];
    state.figInit = false;
    btnCam.textContent = '📷 Camera on'; btnCam.hidden = true; btnDemo.textContent = '🪄 Demo'; btnRec.disabled = false;
    keepAwake(); goingLive(); state.headT.reset();
    if (!poseL) setMsg(mic ? 'Camera on. The tracker is warming up — a few seconds on first visit.' : 'Camera on (no microphone — your film will be silent). Tracker warming up…');
  } catch (e) {
    btnCam.disabled = false;
    setMsg(cameraErrorText(e));
    return;
  }
  try {
    await models;
    setMsg(mic ? 'You are live. Talk, nod, tilt your head, wave, hand on mouth, namaste — the character performs with you.' : 'You are live (silent film — the microphone is off).');
  } catch (e) {
    statusModel.textContent = 'Tracker failed to load — tap Start Camera to retry';
    setMsg('The tracker could not download (' + (e.message || 'network') + '). Check your connection and tap Start Camera.');
    btnCam.disabled = false; btnCam.hidden = false; btnCam.textContent = '📷 Retry tracker';
    state.mode = 'idle'; btnRec.disabled = true;
    if (state.stream) { state.stream.getTracks().forEach(t => t.stop()); state.stream = null; }
    return;
  }
});
btnDemo.addEventListener('click', () => {
  if (state.recording) return;
  if (state.mode === 'camera') return setMsg('Demo Mode is for when there is no camera — you are already live.');
  state.mode = state.mode === 'demo' ? 'idle' : 'demo';
  btnDemo.textContent = state.mode === 'demo' ? '🪄 Stop demo' : '🪄 Demo';
  btnRec.disabled = state.mode === 'idle';
  if (state.mode === 'demo') { goingLive(); state.headT.reset(); }
  if (state.mode === 'demo' && chkCo.checked) { ensurePack(cast.leftHand).catch(() => {}); ensurePack(cast.rightHand).catch(() => {}); }
  if (state.mode === 'idle') { raw.pose = null; raw.face = null; raw.hands = []; }
  setMsg(state.mode === 'demo' ? 'Demo Mode: a virtual performer nods, shakes its head, waves, gasps, says namaste and thinks. The real thing needs your camera.' : '');
});
selQuality.addEventListener('change', () => { state.quality = selQuality.value; });
function setReel(on) {
  state.reel = on;
  stage.classList.toggle('reel', on);
  document.body.classList.toggle('reel-mode', on);
  btnReel.textContent = on ? '🖥 16:9' : '📱 9:16';
  btnReel.setAttribute('aria-pressed', on ? 'true' : 'false');
}
btnReel.addEventListener('click', () => {
  if (state.recording) return setMsg('Stop recording before changing the frame — a film keeps one shape.');
  setReel(!state.reel);
});

/* ---------- recording ----------
   MP4 first (iPhone Safari only records MP4; Chrome 126+ records it too, and
   it is what WhatsApp/Instagram accept), WebM as the fallback — with its
   duration written into the header, since MediaRecorder WebM files have none
   and many players then cannot seek them. */
const REC_TYPES = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a', 'video/mp4;codecs=avc1,opus', 'video/mp4',
  'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
function pickRecType() {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const t of REC_TYPES) { try { if (MediaRecorder.isTypeSupported(t)) return t; } catch (e) { /* ignore */ } }
  return '';
}
/* Writes a Duration element into a MediaRecorder WebM (Segment of unknown
   size, Info without Duration — what Chrome and Firefox emit). Returns the
   input untouched if the file does not look like that. */
async function fixWebmDuration(blob, ms) {
  try {
    const head = new Uint8Array(await blob.slice(0, Math.min(blob.size, 65536)).arrayBuffer());
    const vlen = b => { let l = 1, m = 0x80; while (l <= 8 && !(b & m)) { l++; m >>= 1; } return l; };
    const readVint = (o) => { const l = vlen(head[o]); const mask = (0x80 >> (l - 1)) - 1; let v = head[o] & mask, ones = (head[o] & mask) === mask; for (let i = 1; i < l; i++) { v = v * 256 + head[o + i]; ones = ones && head[o + i] === 0xFF; } return { l, v, unknown: ones }; };
    const idLen = b => vlen(b);
    let o = 0;
    // EBML header
    if (head[0] !== 0x1A || head[1] !== 0x45 || head[2] !== 0xDF || head[3] !== 0xA3) return blob;
    o = 4; let sz = readVint(o); o += sz.l + sz.v;
    // Segment
    if (!(head[o] === 0x18 && head[o + 1] === 0x53 && head[o + 2] === 0x80 && head[o + 3] === 0x67)) return blob;
    o += 4; sz = readVint(o); if (!sz.unknown) return blob; o += sz.l;
    // walk segment children until Info
    while (o < head.length - 12) {
      const il = idLen(head[o]); const id = Array.from(head.slice(o, o + il)).map(b => b.toString(16).padStart(2, '0')).join('');
      const s = readVint(o + il);
      if (id === '1549a966') {
        const infoStart = o, bodyStart = o + il + s.l, bodyEnd = bodyStart + s.v;
        // already has Duration (0x4489)?
        for (let p = bodyStart; p < bodyEnd;) { const cl = idLen(head[p]); if (cl === 2 && head[p] === 0x44 && head[p + 1] === 0x89) return blob; const cs = readVint(p + cl); p += cl + cs.l + cs.v; }
        // TimecodeScale (0x2AD7B1) defaults to 1 ms
        let scale = 1e6;
        for (let p = bodyStart; p < bodyEnd;) { const cl = idLen(head[p]); const cs = readVint(p + cl); if (cl === 3 && head[p] === 0x2A && head[p + 1] === 0xD7 && head[p + 2] === 0xB1) { let v = 0; for (let i = 0; i < cs.v; i++) v = v * 256 + head[p + cl + cs.l + i]; scale = v; } p += cl + cs.l + cs.v; }
        const dur = new Uint8Array(11); dur[0] = 0x44; dur[1] = 0x89; dur[2] = 0x88;
        new DataView(dur.buffer).setFloat64(3, ms * 1e6 / scale);
        const body = head.slice(bodyStart, bodyEnd);
        const newSize = body.length + dur.length;
        const sizeV = new Uint8Array(8); sizeV[0] = 0x01; let v = newSize; for (let i = 7; i >= 1; i--) { sizeV[i] = v & 0xff; v = Math.floor(v / 256); }
        const info = new Blob([head.slice(infoStart, infoStart + il), sizeV, body, dur]);
        return new Blob([blob.slice(0, infoStart), info, blob.slice(bodyEnd)], { type: blob.type });
      }
      if (s.unknown) return blob;
      o += il + s.l + s.v;
    }
  } catch (e) { /* leave the file as recorded */ }
  return blob;
}
function stamp() { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; }
btnRec.addEventListener('click', () => {
  if (state.recording) { state.recorder.stop(); return; }
  if (state.mode === 'idle') { setMsg('Start the camera or Demo Mode first — then record your scene.'); return; }
  const mime = pickRecType();
  if (mime === null || !stage.captureStream) { setMsg('This browser cannot record video. Try Chrome on Android or Safari on iPhone (iOS 14.3+).'); return; }
  try {
    const canvasStream = stage.captureStream(30);
    const tracks = [...canvasStream.getVideoTracks()];
    if (state.mode === 'camera' && state.stream && state.stream.getAudioTracks().length) tracks.push(state.stream.getAudioTracks()[0]);
    const rec = new MediaRecorder(new MediaStream(tracks), Object.assign(mime ? { mimeType: mime } : {}, { videoBitsPerSecond: 4_000_000 }));
    state.chunks = [];
    rec.ondataavailable = e => { if (e.data && e.data.size) state.chunks.push(e.data); };
    rec.onstop = async () => {
      const ms = Date.now() - state.recStart;
      state.recording = false; btnRec.textContent = '⏺ Record again'; btnRec.classList.remove('recording');
      canvasStream.getTracks().forEach(t => t.stop());
      const type = (rec.mimeType || mime || 'video/webm').split(';')[0];
      let blob = new Blob(state.chunks, { type });
      if (type === 'video/webm') blob = await fixWebmDuration(blob, ms);
      const ext = type === 'video/mp4' ? 'mp4' : 'webm';
      if (state.recUrl) URL.revokeObjectURL(state.recUrl);
      state.recBlob = blob; state.recUrl = URL.createObjectURL(blob);
      downloadA.href = state.recUrl; downloadA.download = `rangmanch-${stamp()}.${ext}`;
      downloadA.hidden = false; btnRetake.hidden = false;
      btnShare.hidden = !(navigator.canShare && navigator.canShare({ files: [new File([blob], downloadA.download, { type })] }));
      setMsg(`Scene recorded (${Math.round(ms / 1000)} s). Save the film, share it, or act a retake.`);
    };
    rec.start(1000); state.recorder = rec; state.recording = true; state.recStart = Date.now(); state.recMime = rec.mimeType || mime;
    btnRec.classList.add('recording');
    downloadA.hidden = true; btnRetake.hidden = true; btnShare.hidden = true;
    setMsg('Rolling! Lights, camera… act!');
  } catch (e) { setMsg('Recording failed: ' + e.message); }
});
btnShare.addEventListener('click', async () => {
  if (!state.recBlob) return;
  try { await navigator.share({ files: [new File([state.recBlob], downloadA.download, { type: state.recBlob.type })], title: 'My Rangmanch scene' }); }
  catch (e) { if (e && e.name !== 'AbortError') setMsg('Sharing failed — use Save instead.'); }
});
btnRetake.addEventListener('click', () => {
  if (state.recording) return;
  downloadA.hidden = true; btnRetake.hidden = true; btnShare.hidden = true; btnRec.click();
});

/* Debug/testing handle — lets the test harness drive synthetic performers. */
window.__rangmanch = { version: VERSION, state, raw, cast, packs, ensurePack, classifyGesture, packGeom, stage, setLead, setReel, fixWebmDuration, pickRecType, MAP, toPx,
  loadExtraPoses, resolvePose, warpPoint, freeArmsOn, setFreeArms: on => { state.freeArms = !!on; chkFA.checked = !!on; state.compSig = null; }, synthFace, synthHand, ALL_POSES, EXTRA_KEYS, FALLBACK, get headGL() { return headGL; } };

// phones held upright get the vertical 9:16 stage by default
setReel(window.matchMedia('(orientation: portrait)').matches && window.innerWidth < 900);
buildCasting();
setLead(cast.lead);
requestAnimationFrame(loop);
