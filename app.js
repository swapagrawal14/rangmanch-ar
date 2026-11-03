// Rangmanch AR v0.3 — one-person cartoon studio.
// MediaPipe Pose + Hands + Face (on-device) -> body-part casting of Rigpop Forge packs -> AR canvas -> record.
// v0.3: all 16 Forge packs (lazy-loaded), landmark smoothing, quality toggle, 9:16 reel mode,
//       live captions burned into the film, record timer + retake.
import {
  FilesetResolver,
  PoseLandmarker,
  HandLandmarker,
  FaceLandmarker,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODELS = {
  pose: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
  hand: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
  face: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
};

// folder id -> display name (folders under assets/packs/, manifests are Rigpop Forge character.rigpop.json)
const PACKS = [
  ["swapnil", "Swapnil Agrawal"],
  ["doodle-swapnil", "Doodle Swapnil (OG)"],
  ["sanjay", "Dr Sanjay Agrawal"],
  ["seema", "Seema Agrawal"],
  ["bhavishy", "Bhavishy Agrawal"],
  ["mocha", "Mocha the Cat"],
  ["bunty", "Bunty the Bot"],
  ["pia", "Pia the Pineapple"],
  ["solana", "Solana the Sun-Chaser"],
  ["rafi", "Rafi the Rickshaw Poet"],
  ["kiko", "Kiko the Cloud Shepherd"],
  ["mira", "Mira the Moon Gardener"],
  ["bubbles", "Bubbles the Fishbowl Girl"],
  ["luna", "Luna the Moth Girl"],
  ["puni", "Puni the Slime"],
  ["static", "Static the TV Kid"],
];
const PACK_IDS = PACKS.map(([id]) => id);

const canvas = document.getElementById("stage");
const ctx = canvas.getContext("2d");
const video = document.getElementById("cam");
const msgEl = document.getElementById("stage-msg");
const statusModel = document.getElementById("status-model");

const state = {
  packs: {},            // id -> { manifest, img:{}, tile:{} } (lazy)
  cast: { body: "swapnil", left: "mocha", right: "bunty" },
  pose: null,
  hands: [],
  face: null,
  demo: false,
  cameraOn: false,
  frame: 0,
  lastVideoTime: -1,
  fps: 0,
  mouth: null,
  blink: false,
  quality: "high",      // 'high' | 'balanced'
  reel: false,
  caption: "",
  recording: false,
  recStart: 0,
};

// ---------- helpers ----------
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const toPx = (p) => ({ x: (1 - p.x) * canvas.width, y: p.y * canvas.height }); // selfie mirror
const setMsg = (t) => { msgEl.textContent = t || ""; };
const setDot = (id, on) => document.getElementById(id).classList.toggle("on", !!on);

// exponential smoothing kills landmark jitter (the "shaky character" problem)
function smoothLm(prev, next, alpha = 0.45) {
  if (!prev || !next || prev.length !== next.length) return next;
  return next.map((p, i) => ({
    x: prev[i].x + (p.x - prev[i].x) * alpha,
    y: prev[i].y + (p.y - prev[i].y) * alpha,
    z: p.z, visibility: p.visibility,
  }));
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

async function loadPack(id) {
  const base = `assets/packs/${id}/`;
  const manifest = await (await fetch(base + "character.rigpop.json")).json();
  const talk = manifest.talk;
  const img = { base: await loadImage(base + talk.base) };
  for (const [poseName, path] of Object.entries(talk.poses || {})) {
    img[poseName] = await loadImage(base + path);
  }
  const tile = {};
  for (const [name, path] of Object.entries(talk.files || {})) {
    tile[name] = await loadImage(base + path);
  }
  return { manifest, img, tile };
}

async function ensurePack(id) {
  if (state.packs[id]) return state.packs[id];
  setMsg(`Cast load ho raha hai… (${id})`);
  state.packs[id] = await loadPack(id);
  setMsg("");
  return state.packs[id];
}

// ---------- MediaPipe ----------
let poseLM, handLM, faceLM;
async function createSet(vision, delegate) {
  const opts = (modelAssetPath) => ({ baseOptions: { modelAssetPath, delegate }, runningMode: "VIDEO" });
  poseLM = await PoseLandmarker.createFromOptions(vision, { ...opts(MODELS.pose), numPoses: 1 });
  handLM = await HandLandmarker.createFromOptions(vision, { ...opts(MODELS.hand), numHands: 2 });
  faceLM = await FaceLandmarker.createFromOptions(vision, {
    ...opts(MODELS.face), numFaces: 1, outputFaceBlendshapes: true,
  });
}
async function initModels() {
  statusModel.textContent = "Models: downloading (on-device)…";
  const vision = await FilesetResolver.forVisionTasks(WASM_URL);
  try { await createSet(vision, "GPU"); }
  catch (e) { await createSet(vision, "CPU"); }
  statusModel.textContent = "Models: ready ✅ (on-device)";
}

// ---------- tracking (staggered by quality) ----------
function runTracking(now) {
  if (!state.cameraOn || video.readyState < 2 || video.currentTime === state.lastVideoTime) return;
  state.lastVideoTime = video.currentTime;
  state.frame++;
  const every = state.quality === "high"
    ? { pose: 1, hand: 2, face: 3 }
    : { pose: 2, hand: 3, face: 5 };
  try {
    if (poseLM && state.frame % every.pose === 0) {
      const r = poseLM.detectForVideo(video, now);
      const raw = r.landmarks && r.landmarks[0] ? r.landmarks[0] : null;
      state.pose = raw ? smoothLm(state.pose, raw) : null;
    }
    if (handLM && state.frame % every.hand === 0) {
      const r = handLM.detectForVideo(video, now);
      const labels = r.handednesses || r.handedness || [];
      const rawHands = (r.landmarks || []).map((lm, i) => ({
        landmarks: lm,
        handedness: labels[i]?.[0]?.categoryName || labels[i]?.categoryName || "",
      }));
      state.hands = rawHands.map((h, i) => ({
        handedness: h.handedness,
        landmarks: state.hands[i] ? smoothLm(state.hands[i].landmarks, h.landmarks, 0.5) : h.landmarks,
      }));
    }
    if (faceLM && state.frame % every.face === 0) {
      const r = faceLM.detectForVideo(video, now);
      const cats = r.faceBlendshapes && r.faceBlendshapes[0] ? r.faceBlendshapes[0].categories : [];
      state.face = new Map(cats.map((c) => [c.categoryName, c.score]));
      updateExpression();
    }
  } catch (_) { /* a dropped inference frame is fine */ }
}

function updateExpression() {
  const f = state.face;
  if (!f) return;
  const jaw = f.get("jawOpen") || 0;
  const funnel = f.get("mouthFunnel") || 0;
  const smile = ((f.get("mouthSmileLeft") || 0) + (f.get("mouthSmileRight") || 0)) / 2;
  state.mouth = jaw > 0.35 ? "A" : funnel > 0.3 ? "O" : smile > 0.35 ? "E" : null;
  state.blink = (f.get("eyeBlinkLeft") || 0) > 0.55 && (f.get("eyeBlinkRight") || 0) > 0.55;
}

// ---------- demo mode (synthetic landmarks, same pipeline) ----------
function demoLandmarks(t) {
  const cx = 0.5 + Math.sin(t * 0.4) * 0.03;
  const bob = Math.sin(t * 1.6) * 0.008;
  const raiseR = Math.sin(t * 0.5) > 0.55;
  const raiseBoth = Math.sin(t * 0.23) > 0.86;
  const P = (x, y) => ({ x, y, z: 0, visibility: 1 });
  const lm = new Array(33).fill(null).map(() => P(cx, 0.5));
  lm[0] = P(cx, 0.14 + bob);
  lm[11] = P(cx - 0.09, 0.26 + bob); lm[12] = P(cx + 0.09, 0.26 + bob);
  lm[13] = P(cx - 0.14, 0.4); lm[14] = P(cx + 0.14, 0.4);
  lm[15] = P(cx - 0.15, raiseBoth ? 0.1 : 0.52);
  lm[16] = P(cx + 0.15, raiseR || raiseBoth ? 0.1 : 0.52);
  lm[23] = P(cx - 0.055, 0.52 + bob); lm[24] = P(cx + 0.055, 0.52 + bob);
  lm[25] = P(cx - 0.065, 0.72); lm[26] = P(cx + 0.065, 0.72);
  lm[27] = P(cx - 0.07, 0.92); lm[28] = P(cx + 0.07, 0.92);
  state.pose = lm;
  const handLm = [];
  const hx = 0.3 + Math.sin(t * 0.8) * 0.05, hy = 0.62 + Math.cos(t * 1.1) * 0.04;
  for (let i = 0; i < 21; i++) handLm.push(P(hx, hy));
  handLm[0] = P(hx, hy + 0.09); handLm[9] = P(hx, hy); handLm[4] = P(hx - 0.03, hy + 0.03);
  handLm[8] = P(hx + (Math.sin(t * 2) > 0.7 ? 0.005 : 0.045), hy - 0.05);
  state.hands = [{ landmarks: handLm, handedness: "Left" }];
  const cyc = Math.floor(t) % 5;
  state.mouth = cyc === 1 ? "A" : cyc === 2 ? "O" : cyc === 3 ? "E" : null;
  state.blink = Math.sin(t * 2.2) > 0.96;
}

// ---------- character drawing ----------
function classifyPose(lm) {
  const ls = lm[11], rs = lm[12], lw = lm[15], rw = lm[16];
  const leftUp = lw.y < ls.y - 0.04, rightUp = rw.y < rs.y - 0.04;
  if (leftUp && rightUp) return "open";
  if (leftUp || rightUp) return "wave";
  const leftOut = Math.abs(lw.x - ls.x) > 0.22 && Math.abs(lw.y - ls.y) < 0.12;
  const rightOut = Math.abs(rw.x - rs.x) > 0.22 && Math.abs(rw.y - rs.y) < 0.12;
  if (leftOut || rightOut) return "point";
  return "base";
}

function drawPackFigure(pack, poseKey, cxPx, bottomPx, heightPx, tiltRad, opts = {}) {
  const talk = pack.manifest.talk;
  const img = pack.img[poseKey] || pack.img.base;
  const w = heightPx * (talk.canvas.w / talk.canvas.h);
  ctx.save();
  ctx.translate(cxPx, bottomPx);
  ctx.rotate(tiltRad);
  ctx.drawImage(img, -w / 2, -heightPx, w, heightPx);
  const scale = w / talk.canvas.w;
  const anchors = talk.poseAnchors && talk.poseAnchors[poseKey];
  const place = (tileImg, rect, anchorPoint) => {
    if (!tileImg) return;
    const tw = (rect ? rect.w : tileImg.width) * scale;
    const th = (rect ? rect.h : tileImg.height) * scale;
    let dx, dy;
    if (anchorPoint) { dx = anchorPoint[0] * scale - tw / 2; dy = anchorPoint[1] * scale - th / 2; }
    else if (rect) { dx = rect.x * scale; dy = rect.y * scale; }
    else return;
    ctx.drawImage(tileImg, -w / 2 + dx, -heightPx + dy, tw, th);
  };
  if (!opts.noFace) {
    if (state.mouth && pack.tile[state.mouth]) {
      place(pack.tile[state.mouth], talk.patches[state.mouth], anchors && anchors.mouth);
    }
    if (state.blink && pack.tile.blink) {
      place(pack.tile.blink, talk.patches.blink, anchors && anchors.eyes);
    }
  }
  ctx.restore();
  return w;
}

function drawMainCharacter() {
  const pack = state.packs[state.cast.body];
  if (!pack || !state.pose) return;
  const lm = state.pose;
  const hip = toPx(mid(lm[23], lm[24]));
  const sho = toPx(mid(lm[11], lm[12]));
  const ank = toPx(mid(lm[27], lm[28]));
  const spanPx = Math.max(110, Math.abs(ank.y - sho.y));
  const heightPx = Math.min(canvas.height * 1.05, spanPx * 1.45);
  const lsPx = toPx(lm[11]), rsPx = toPx(lm[12]);
  const tilt = Math.atan2(rsPx.y - lsPx.y, rsPx.x - lsPx.x) * 0.45;
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.28)";
  ctx.beginPath();
  ctx.ellipse(hip.x, ank.y + 12, heightPx * 0.26, Math.max(7, canvas.height * 0.018), 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  drawPackFigure(pack, classifyPose(lm), hip.x, ank.y + 14, heightPx, tilt);
}

function drawHandPuppet(hand, t) {
  const lm = hand.landmarks;
  const mcp = toPx(lm[9]);
  const wrist = toPx(lm[0]);
  const isLeftSide = mcp.x < canvas.width / 2;
  const pack = state.packs[isLeftSide ? state.cast.left : state.cast.right];
  if (!pack) return;
  const handPx = Math.max(24, dist(wrist, mcp));
  const heightPx = Math.max(80, Math.min(canvas.height * 0.42, handPx * 2.3));
  const tilt = Math.atan2(mcp.x - wrist.x, -(mcp.y - wrist.y)) * 0.55;
  const pinchRatio = dist(toPx(lm[4]), toPx(lm[8])) / handPx;
  const talking = pinchRatio < 0.4;
  const bounce = talking ? Math.sin(t * 18) * 4 : Math.sin(t * 2.4 + mcp.x) * 2;
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.22)";
  ctx.beginPath();
  ctx.ellipse(mcp.x, mcp.y + heightPx * 0.52, heightPx * 0.2, 8, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  const prevMouth = state.mouth;
  if (talking) state.mouth = "O";
  drawPackFigure(pack, "base", mcp.x, mcp.y + heightPx * 0.52 + bounce, heightPx, tilt, {});
  state.mouth = prevMouth;
}

function drawCaption() {
  const text = state.caption.trim();
  if (!text) return;
  const maxW = canvas.width * 0.86;
  ctx.save();
  ctx.font = "700 30px 'Space Grotesk', system-ui, sans-serif";
  // simple word-wrap to at most 2 lines
  const words = text.split(/\s+/);
  const lines = [""];
  for (const word of words) {
    const test = lines[lines.length - 1] ? lines[lines.length - 1] + " " + word : word;
    if (ctx.measureText(test).width > maxW && lines[lines.length - 1]) {
      if (lines.length === 2) { lines[1] += " " + word; break; }
      lines.push(word);
    } else lines[lines.length - 1] = test;
  }
  const lineH = 38;
  const boxH = lines.length * lineH + 22;
  const widest = Math.max(...lines.map((l) => ctx.measureText(l).width));
  const boxW = Math.min(canvas.width * 0.94, widest + 44);
  const x = (canvas.width - boxW) / 2, y = canvas.height - boxH - 18;
  ctx.fillStyle = "rgba(18,9,2,0.88)";
  ctx.strokeStyle = "#f2b33d"; ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.roundRect(x, y, boxW, boxH, 12); ctx.fill(); ctx.stroke();
  ctx.fillStyle = "#f7ead7";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  lines.forEach((l, i) => ctx.fillText(l, canvas.width / 2, y + 16 + lineH * i + lineH / 2 - 4));
  ctx.restore();
}

// ---------- render loop ----------
let lastFpsT = performance.now(), framesCounted = 0;
function render(nowMs) {
  const t = nowMs / 1000;
  if (state.demo) demoLandmarks(t);
  else runTracking(nowMs);
  framesCounted++;
  if (nowMs - lastFpsT > 600) {
    state.fps = Math.round((framesCounted * 1000) / (nowMs - lastFpsT));
    framesCounted = 0; lastFpsT = nowMs;
    document.getElementById("fps").textContent = state.cameraOn || state.demo ? `${state.fps} fps` : "";
    setDot("dot-pose", !!state.pose);
    setDot("dot-hand", state.hands.length > 0);
    setDot("dot-face", !!state.face || state.demo);
    if (state.recording) {
      const s = Math.floor((nowMs - state.recStart) / 1000);
      btnRecord.textContent = `⏹ Stop · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    }
  }
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (state.cameraOn && video.readyState >= 2) {
    const vw = video.videoWidth, vh = video.videoHeight;
    const s = Math.max(canvas.width / vw, canvas.height / vh);
    const dw = vw * s, dh = vh * s;
    ctx.save();
    ctx.translate(canvas.width, 0); ctx.scale(-1, 1);
    ctx.drawImage(video, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
    ctx.restore();
  } else {
    const g = ctx.createLinearGradient(0, 0, 0, canvas.height);
    g.addColorStop(0, "#2b1215"); g.addColorStop(0.78, "#3d1a12"); g.addColorStop(0.781, "#4a2c17"); g.addColorStop(1, "#5d3a1f");
    ctx.fillStyle = g; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "rgba(255,240,214,0.85)";
    ctx.font = "600 22px 'Fraunces', serif";
    ctx.fillText(state.demo ? "🪄 Demo stage — yahi cast camera pe bhi chalegi" : "Rangmanch stage", 24, 40);
  }
  for (const h of state.hands) drawHandPuppet(h, t);
  drawMainCharacter();
  drawCaption();
  requestAnimationFrame(render);
}

// ---------- controls ----------
const btnCamera = document.getElementById("btn-camera");
const btnDemo = document.getElementById("btn-demo");
const btnRecord = document.getElementById("btn-record");
const btnRetake = document.getElementById("btn-retake");
const downloadEl = document.getElementById("download");

btnCamera.addEventListener("click", async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
      audio: true,
    });
    video.srcObject = stream;
    await video.play();
    state.cameraOn = true; state.demo = false;
    btnRecord.disabled = false;
    btnDemo.textContent = "🪄 Demo Mode";
    setMsg("Camera live hai — act karo! Haath upar, munh kholo, haathon ko paas lao.");
    btnCamera.textContent = "📷 Camera On ✅";
  } catch (e) {
    setMsg("Camera nahi mila / permission nahi mili — Demo Mode try karo.");
  }
});

btnDemo.addEventListener("click", () => {
  state.demo = !state.demo;
  btnRecord.disabled = !state.demo && !state.cameraOn;
  btnDemo.textContent = state.demo ? "🪄 Demo Mode: ON" : "🪄 Demo Mode";
  setMsg(state.demo ? "Demo chal raha hai — cast badal ke dekho, Record bhi kar sakte ho." : "");
});

document.getElementById("quality").addEventListener("change", (e) => {
  state.quality = e.target.value;
  setMsg(state.quality === "balanced" ? "Balanced mode — models thode dheere chalenge, halke phone pe smooth rahega." : "High mode — teeno models full speed.");
});

document.getElementById("btn-reel").addEventListener("click", (e) => {
  state.reel = !state.reel;
  canvas.width = state.reel ? 720 : 1280;
  canvas.height = state.reel ? 1280 : 720;
  canvas.classList.toggle("reel", state.reel);
  e.currentTarget.classList.toggle("active-mode", state.reel);
  e.currentTarget.textContent = state.reel ? "🖥 16:9 Wide Mode" : "📱 9:16 Reel Mode";
  setMsg(state.reel ? "Reel mode ON — frame khada (9:16) hai, Instagram/Shorts ke liye perfect." : "Wide mode (16:9) wapas.");
});

document.getElementById("caption-input").addEventListener("input", (e) => {
  state.caption = e.target.value;
});

// ---------- recording ----------
let recorder = null, chunks = [];
btnRecord.addEventListener("click", () => {
  if (recorder && recorder.state === "recording") { recorder.stop(); return; }
  const canvasStream = canvas.captureStream(30);
  const tracks = [...canvasStream.getVideoTracks()];
  if (state.cameraOn && video.srcObject) {
    for (const tr of video.srcObject.getAudioTracks()) tracks.push(tr);
  }
  const mixed = new MediaStream(tracks);
  const mime = ["video/mp4", "video/webm;codecs=vp9,opus", "video/webm"]
    .find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || "";
  chunks = [];
  downloadEl.hidden = true; btnRetake.hidden = true;
  recorder = new MediaRecorder(mixed, mime ? { mimeType: mime } : undefined);
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = () => {
    state.recording = false;
    const type = recorder.mimeType || "video/webm";
    const blob = new Blob(chunks, { type });
    downloadEl.href = URL.createObjectURL(blob);
    downloadEl.download = "rangmanch-scene." + (type.includes("mp4") ? "mp4" : "webm");
    downloadEl.hidden = false;
    btnRetake.hidden = false;
    btnRecord.textContent = "⏺ Record Scene";
    btnRecord.classList.remove("recording");
    setMsg("Film ban gayi — Download dabao, ya pasand na aaye toh Retake. 🎬");
  };
  recorder.start(250);
  state.recording = true;
  state.recStart = performance.now();
  btnRecord.textContent = "⏹ Stop · 0:00";
  btnRecord.classList.add("recording");
  setMsg("🔴 Recording… act karo, bolo — awaaz bhi record ho rahi hai (camera mode mein).");
});

btnRetake.addEventListener("click", () => {
  chunks = [];
  downloadEl.hidden = true;
  btnRetake.hidden = true;
  if (downloadEl.href) URL.revokeObjectURL(downloadEl.href);
  setMsg("Retake ready hai — Record dabao aur dobara act karo.");
});

// ---------- boot ----------
async function boot() {
  const selects = { body: "cast-body", left: "cast-left", right: "cast-right" };
  const thumbs = { body: "thumb-body", left: "thumb-left", right: "thumb-right" };
  const setThumb = (slot) => {
    const el = document.getElementById(thumbs[slot]);
    if (el) el.src = `assets/packs/${state.cast[slot]}/talk/base.png`;
  };
  for (const [slot, elId] of Object.entries(selects)) {
    const sel = document.getElementById(elId);
    for (const [id, name] of PACKS) {
      const o = document.createElement("option");
      o.value = id; o.textContent = name;
      sel.appendChild(o);
    }
    sel.value = state.cast[slot];
    setThumb(slot);
    sel.addEventListener("change", async () => {
      state.cast[slot] = sel.value;
      setThumb(slot);
      try { await ensurePack(sel.value); }
      catch (e) { setMsg(`Ye cast load nahi hua: ${sel.value}`); }
    });
  }
  try {
    for (const slot of Object.keys(selects)) await ensurePack(state.cast[slot]);
  } catch (e) {
    setMsg("Character packs load nahi hue — server se chalao: python3 -m http.server");
    return;
  }
  requestAnimationFrame(render);
  try {
    await initModels();
    if (!state.cameraOn) setMsg("Models ready hain — Start Camera dabao aur act karo!");
  } catch (e) {
    statusModel.textContent = "Models: load failed (net?) — Demo Mode chalega";
  }
}
boot();
