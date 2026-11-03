// Rangmanch AR v0.1 — one-person cartoon studio.
// MediaPipe Pose + Hands + Face (on-device) -> body-part casting of Rigpop Forge packs -> AR canvas -> record.
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

const PACK_IDS = ["swapnil", "mocha", "bunty"];
const canvas = document.getElementById("stage");
const ctx = canvas.getContext("2d");
const video = document.getElementById("cam");
const msgEl = document.getElementById("stage-msg");
const statusModel = document.getElementById("status-model");

const state = {
  packs: {},            // id -> { manifest, img:{}, tile:{} }
  cast: { body: "swapnil", left: "mocha", right: "bunty" },
  pose: null,           // array of 33 landmarks (normalised, source orientation)
  hands: [],            // [{ landmarks, handedness }]
  face: null,           // Map categoryName -> score
  demo: false,
  cameraOn: false,
  frame: 0,
  lastVideoTime: -1,
  fps: 0,
  mouth: null,          // 'A' | 'O' | 'E' | null
  blink: false,
};

// ---------- helpers ----------
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
// selfie view: flip x so the user sees a mirror
const toPx = (p) => ({ x: (1 - p.x) * canvas.width, y: p.y * canvas.height });
const setMsg = (t) => { msgEl.textContent = t || ""; };
const setDot = (id, on) => document.getElementById(id).classList.toggle("on", !!on);

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

// ---------- MediaPipe ----------
let poseLM, handLM, faceLM;
async function initModels() {
  statusModel.textContent = "Models: downloading (on-device)…";
  const vision = await FilesetResolver.forVisionTasks(WASM_URL);
  const opts = (modelAssetPath) => ({
    baseOptions: { modelAssetPath, delegate: "GPU" },
    runningMode: "VIDEO",
  });
  try {
    poseLM = await PoseLandmarker.createFromOptions(vision, { ...opts(MODELS.pose), numPoses: 1 });
    handLM = await HandLandmarker.createFromOptions(vision, { ...opts(MODELS.hand), numHands: 2 });
    faceLM = await FaceLandmarker.createFromOptions(vision, {
      ...opts(MODELS.face), numFaces: 1, outputFaceBlendshapes: true,
    });
  } catch (e) {
    // GPU delegate can fail on some devices — retry on CPU once.
    poseLM = await PoseLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODELS.pose, delegate: "CPU" }, runningMode: "VIDEO", numPoses: 1,
    });
    handLM = await HandLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODELS.hand, delegate: "CPU" }, runningMode: "VIDEO", numHands: 2,
    });
    faceLM = await FaceLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODELS.face, delegate: "CPU" }, runningMode: "VIDEO",
      numFaces: 1, outputFaceBlendshapes: true,
    });
  }
  statusModel.textContent = "Models: ready ✅ (on-device)";
}

// ---------- tracking ----------
function runTracking(now) {
  if (!state.cameraOn || video.readyState < 2 || video.currentTime === state.lastVideoTime) return;
  state.lastVideoTime = video.currentTime;
  state.frame++;
  try {
    if (poseLM) {
      const r = poseLM.detectForVideo(video, now);
      state.pose = r.landmarks && r.landmarks[0] ? r.landmarks[0] : null;
    }
    if (handLM && state.frame % 2 === 0) {
      const r = handLM.detectForVideo(video, now);
      const hands = [];
      const labels = r.handednesses || r.handedness || [];
      (r.landmarks || []).forEach((lm, i) => {
        hands.push({ landmarks: lm, handedness: labels[i]?.[0]?.categoryName || labels[i]?.categoryName || "" });
      });
      state.hands = hands;
    }
    if (faceLM && state.frame % 3 === 0) {
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
  const raiseR = Math.sin(t * 0.5) > 0.55;   // periodically raise one arm
  const raiseBoth = Math.sin(t * 0.23) > 0.86;
  const P = (x, y) => ({ x, y, z: 0, visibility: 1 });
  const lm = new Array(33).fill(null).map(() => P(cx, 0.5));
  lm[0] = P(cx, 0.14 + bob);
  lm[11] = P(cx - 0.09, 0.26 + bob); lm[12] = P(cx + 0.09, 0.26 + bob);
  lm[13] = P(cx - 0.14, 0.4); lm[14] = P(cx + 0.14, 0.4);
  lm[15] = P(cx - 0.15, raiseBoth ? 0.1 : 0.52);                       // left wrist
  lm[16] = P(cx + 0.15, raiseR || raiseBoth ? 0.1 : 0.52);             // right wrist
  lm[23] = P(cx - 0.055, 0.52 + bob); lm[24] = P(cx + 0.055, 0.52 + bob);
  lm[25] = P(cx - 0.065, 0.72); lm[26] = P(cx + 0.065, 0.72);
  lm[27] = P(cx - 0.07, 0.92); lm[28] = P(cx + 0.07, 0.92);
  state.pose = lm;
  const handLm = [];
  const hx = 0.3 + Math.sin(t * 0.8) * 0.05, hy = 0.62 + Math.cos(t * 1.1) * 0.04;
  for (let i = 0; i < 21; i++) handLm.push(P(hx, hy));
  handLm[0] = P(hx, hy + 0.09); handLm[9] = P(hx, hy); handLm[4] = P(hx - 0.03, hy + 0.03);
  handLm[8] = P(hx + (Math.sin(t * 2) > 0.7 ? 0.005 : 0.045), hy - 0.05); // pinch sometimes
  state.hands = [{ landmarks: handLm, handedness: "Left" }];
  // cycle expressions
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
  // Rigpop Talk patch compositing: mouth + blink tiles, placed by per-pose anchors when the pack has them
  const scale = w / talk.canvas.w;
  const anchors = talk.poseAnchors && talk.poseAnchors[poseKey];
  // anchor-based placement, in image space relative to the drawn box
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
  const spanPx = Math.max(120, Math.abs(ank.y - sho.y));
  const heightPx = Math.min(canvas.height * 1.05, spanPx * 1.45);
  const lsPx = toPx(lm[11]), rsPx = toPx(lm[12]);
  const tilt = Math.atan2(rsPx.y - lsPx.y, rsPx.x - lsPx.x) * 0.45;
  // floor shadow at the ankle line
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.28)";
  ctx.beginPath();
  ctx.ellipse(hip.x, ank.y + 12, heightPx * 0.26, 13, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  const poseKey = classifyPose(lm);
  drawPackFigure(pack, poseKey, hip.x, ank.y + 14, heightPx, tilt);
}

function drawHandPuppet(hand, t) {
  const lm = hand.landmarks;
  const mcp = toPx(lm[9]);
  const wrist = toPx(lm[0]);
  const isLeftSide = mcp.x < canvas.width / 2;
  const pack = state.packs[isLeftSide ? state.cast.left : state.cast.right];
  if (!pack) return;
  const handPx = Math.max(28, dist(wrist, mcp));
  const heightPx = Math.max(95, Math.min(280, handPx * 2.3));
  const tilt = Math.atan2(mcp.x - wrist.x, -(mcp.y - wrist.y)) * 0.55;
  const pinchRatio = dist(toPx(lm[4]), toPx(lm[8])) / handPx;
  const talking = pinchRatio < 0.4;
  const bounce = talking ? Math.sin(t * 18) * 4 : Math.sin(t * 2.4 + mcp.x) * 2;
  // shadow on the "table"
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
  }
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (state.cameraOn && video.readyState >= 2) {
    // cover-fit mirrored camera feed as the AR room
    const vw = video.videoWidth, vh = video.videoHeight;
    const s = Math.max(canvas.width / vw, canvas.height / vh);
    const dw = vw * s, dh = vh * s;
    ctx.save();
    ctx.translate(canvas.width, 0); ctx.scale(-1, 1);
    ctx.drawImage(video, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
    ctx.restore();
  } else {
    const g = ctx.createLinearGradient(0, 0, 0, canvas.height);
    g.addColorStop(0, "#241d4d"); g.addColorStop(0.78, "#2e2566"); g.addColorStop(0.781, "#3a2c22"); g.addColorStop(1, "#4a3826");
    ctx.fillStyle = g; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.font = "600 22px system-ui";
    ctx.fillText(state.demo ? "🪄 Demo stage — yahi cast camera pe bhi chalegi" : "Rangmanch stage", 24, 40);
  }
  // hand puppets behind the main character, then the star
  for (const h of state.hands) drawHandPuppet(h, t);
  drawMainCharacter();
  requestAnimationFrame(render);
}

// ---------- camera / demo controls ----------
const btnCamera = document.getElementById("btn-camera");
const btnDemo = document.getElementById("btn-demo");
const btnRecord = document.getElementById("btn-record");

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
  recorder = new MediaRecorder(mixed, mime ? { mimeType: mime } : undefined);
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = () => {
    const type = recorder.mimeType || "video/webm";
    const blob = new Blob(chunks, { type });
    const a = document.getElementById("download");
    a.href = URL.createObjectURL(blob);
    a.download = "rangmanch-scene." + (type.includes("mp4") ? "mp4" : "webm");
    a.hidden = false;
    btnRecord.textContent = "⏺ Record Scene";
    btnRecord.classList.remove("recording");
    setMsg("Film ban gayi — Download dabao. 🎬");
  };
  recorder.start(250);
  btnRecord.textContent = "⏹ Stop Recording";
  btnRecord.classList.add("recording");
  setMsg("🔴 Recording… act karo, bolo — awaaz bhi record ho rahi hai (camera mode mein).");
});

// ---------- boot ----------
async function boot() {
  const selects = { body: "cast-body", left: "cast-left", right: "cast-right" };
  for (const [slot, elId] of Object.entries(selects)) {
    const sel = document.getElementById(elId);
    for (const id of PACK_IDS) {
      const o = document.createElement("option");
      o.value = id; o.textContent = id[0].toUpperCase() + id.slice(1);
      sel.appendChild(o);
    }
    sel.value = state.cast[slot];
    sel.addEventListener("change", () => { state.cast[slot] = sel.value; });
  }
  try {
    for (const id of PACK_IDS) state.packs[id] = await loadPack(id);
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
