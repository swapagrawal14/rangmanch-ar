'use strict';
/* Rangmanch AR v1.0 — one-person cartoon studio.
   You stand in front of the camera and are completely replaced by a Rigpop
   character: at cast time the app estimates the character's skeleton from its
   own face geometry (the same math as Rigpop Forge's WowKit exporter), cuts
   its arms and head out of the artwork as feathered pieces, fills the holes,
   and then re-poses the puppet from your MediaPipe skeleton every frame.
   Your gaze turns its head; your mouth and blinks drive its face tiles.
   Your room is only ever shown as blurred colour — you are never on screen.
   Everything runs on-device. */

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
const VERSION = '1.0.1';

/* ---------- cast ---------- */
const CAST = [
  ['swapnil', 'Swapnil (you!)'], ['sanjay', 'Sanjay'], ['seema', 'Seema'], ['bhavishy', 'Bhavishy'],
  ['mocha', 'Mocha the Cat'], ['bunty', 'Bunty the Bot'], ['pia', 'Pia the Pineapple'],
  ['solana', 'Solana'], ['rafi', 'Rafi'], ['kiko', 'Kiko'], ['mira', 'Mira'],
  ['bubbles', 'Bubbles'], ['luna', 'Luna'], ['puni', 'Puni'], ['static', 'Static'],
  ['doodle-swapnil', 'Doodle Swapnil']
];
/* Full-body humanoid packs get the live puppet rig. The rest play as anchored
   figures (and shine as co-actors). */
const RIG_PACKS = new Set(['swapnil', 'doodle-swapnil', 'sanjay', 'seema', 'bhavishy',
  'solana', 'rafi', 'kiko', 'mira', 'bubbles', 'luna', 'static']);

const packs = {};   // id -> {manifest, img, tiles, face, rig, rigPromise}
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
  packs[id] = { manifest, img, tiles, face, rig: null, rigPromise: null, rigFailed: false };
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
  const lead = packs[cast.lead];
  if (lead && RIG_PACKS.has(cast.lead)) buildRigAsync(lead);
}
selLead.addEventListener('change', async () => {
  cast.lead = selLead.value;
  const p = await ensurePack(cast.lead); updateThumb('body', cast.lead);
  if (RIG_PACKS.has(cast.lead)) buildRigAsync(p);
});
selLeft.addEventListener('change', async () => { cast.leftHand = selLeft.value; await ensurePack(cast.leftHand); updateThumb('left', cast.leftHand); });
selRight.addEventListener('change', async () => { cast.rightHand = selRight.value; await ensurePack(cast.rightHand); updateThumb('right', cast.rightHand); });

/* ---------- skeleton estimation (Forge WowKit math, from face geometry) ---------- */
function estimateJoints(manifest, bbox, W, H) {
  const patches = (manifest.talk || {}).patches || {};
  const blink = patches.blink, mouth = patches.A;
  if (!blink || !mouth || !bbox) return null;
  const top = bbox.y, bottom = bbox.y + bbox.h;
  const faceCx = blink.x + blink.w / 2;
  const eyeY = blink.y + blink.h / 2;
  const mouthY = mouth.y + mouth.h / 2;
  const faceW = blink.w * 1.55;
  const headTopEst = Math.max(top, eyeY - faceW * 0.52);
  const chin = mouthY + faceW * 0.30;
  const headH = Math.max(24, chin - headTopEst);
  const neckY = chin + headH * 0.06;
  const shoulderY = neckY + headH * 0.24;
  const shoulderHalf = faceW * 0.60;
  const hipY = top + (bottom - top) * 0.54;
  const elbowDY = headH * 0.92, handDY = headH * 0.88;
  return {
    faceCx, faceW, headH, chin, eyeY,
    neck: [faceCx, neckY], hip: [faceCx, hipY],
    shoR: [faceCx - shoulderHalf, shoulderY], elbR: [faceCx - shoulderHalf * 1.12, shoulderY + elbowDY], wriR: [faceCx - shoulderHalf * 1.18, shoulderY + elbowDY + handDY],
    shoL: [faceCx + shoulderHalf, shoulderY], elbL: [faceCx + shoulderHalf * 1.12, shoulderY + elbowDY], wriL: [faceCx + shoulderHalf * 1.18, shoulderY + elbowDY + handDY],
    shoulderDist: shoulderHalf * 2,
    headPivot: [faceCx, chin - headH * 0.04],
    headBox: [Math.max(0, faceCx - faceW * 1.18), Math.max(0, top - 4), Math.min(W, faceCx + faceW * 1.18), Math.min(H, chin + headH * 0.38)],
    ellipse: [faceCx, eyeY + headH * 0.18, faceW * 0.48, headH * 0.53]
  };
}
function distSeg2(px, py, a, b) {
  const vx = b[0] - a[0], vy = b[1] - a[1], L2 = vx * vx + vy * vy || 1;
  let t = ((px - a[0]) * vx + (py - a[1]) * vy) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - (a[0] + t * vx), dy = py - (a[1] + t * vy);
  return dx * dx + dy * dy;
}
const tick = () => new Promise(r => setTimeout(r, 0));

/* Cut the puppet out of the pack's own base art. Region-limited pixel passes
   keep this fast; it runs chunked so the page never freezes. */
async function buildRigAsync(pack) {
  if (pack.rig || pack.rigPromise || pack.rigFailed) return pack.rig;
  pack.rigPromise = (async () => {
    const img = pack.img.base;
    if (!img) { pack.rigFailed = true; return null; }
    try {
      const W = img.naturalWidth, H = img.naturalHeight;
      const base = document.createElement('canvas'); base.width = W; base.height = H;
      const bctx = base.getContext('2d', { willReadFrequently: true });
      bctx.drawImage(img, 0, 0);
      const src = bctx.getImageData(0, 0, W, H), data = src.data;
      // tight bbox of the drawing
      let bx0 = W, by0 = H, bx1 = -1, by1 = -1;
      for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
        if (data[(y * W + x) * 4 + 3] > 30) { if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; }
      }
      if (bx1 < 0) { pack.rigFailed = true; return null; }
      const bbox = { x: bx0, y: by0, w: bx1 - bx0, h: by1 - by0 };
      const J = estimateJoints(pack.manifest, bbox, W, H);
      if (!J) { pack.rigFailed = true; return null; }
      /* Find the REAL arm line: scan skin-tone pixels in the side bands from
         the shoulder down (Forge's estimates can sit ~90px off the drawn arm).
         Works for bare arms; for sleeved characters the sleeve's own light
         fabric traces the same line. Falls back to the estimates. */
      // skin across the packs spans fair (252,232,217) to deep (167,101,60);
      // saturated garment colours (saree gold r-b≈230+) must NOT pass
      const isSkin = i => data[i + 3] > 60 && data[i] > 120 &&
        (data[i] - data[i + 2]) >= 5 && (data[i] - data[i + 2]) <= 120 &&
        (data[i] - data[i + 1]) >= -5 && (data[i] - data[i + 1]) <= 75 &&
        data[i + 1] > data[i + 2] + 5;
      const detectArm = side => {
        let xa = Math.round(J.faceCx + side * J.faceW * 0.40), xb = Math.round(J.faceCx + side * J.faceW * 1.75);
        const lo = Math.max(0, Math.min(xa, xb)), hi = Math.min(W - 1, Math.max(xa, xb));
        // a hanging wrist never passes ~84% of the shoulder-to-floor span —
        // cap the scan there so the path can't wander into the legs
        const yCap = Math.min(J.shoR[1] + J.headH * 1.9, J.shoR[1] + (bbox.y + bbox.h - J.shoR[1]) * 0.84);
        const cand = [];
        for (let y = Math.round(J.shoR[1]) + 6; y < yCap; y += 2) {
          let sum = 0, cnt = 0;
          for (let x = lo; x <= hi; x++) if (isSkin((y * W + x) * 4)) { sum += x; cnt++; }
          if (cnt >= 4) cand.push([y, sum / cnt]);
        }
        // skin specks above the arm start sparse — first take the longest
        // unbroken run of candidates, then walk it with the line-fit rule
        let bestRun = [], curRun = [];
        for (const r of cand) {
          if (curRun.length && r[0] - curRun[curRun.length - 1][0] > 14) {
            if (curRun.length > bestRun.length) bestRun = curRun;
            curRun = [];
          }
          curRun.push(r);
        }
        if (curRun.length > bestRun.length) bestRun = curRun;
        // start from the best run, then keep extending over later candidates
        // while they hug the arm's fitted line; stop at a big gap, a jump, or
        // when the centroid slides off the line (legs, feet, props)
        const rows = [];
        for (let ci = cand.indexOf(bestRun[0]); ci < cand.length; ci++) {
          const r = cand[ci];
          if (rows.length) {
            const prev = rows[rows.length - 1];
            if (r[0] - prev[0] > 60) break;
            if (Math.abs(r[1] - prev[1]) > 46) break;
            if (rows.length >= 10) {
              const tail = rows.slice(-12);
              const n = tail.length, sy = tail.reduce((s, q) => s + q[0], 0), sx = tail.reduce((s, q) => s + q[1], 0);
              const syy = tail.reduce((s, q) => s + q[0] * q[0], 0), sxy = tail.reduce((s, q) => s + q[0] * q[1], 0);
              const den = n * syy - sy * sy || 1, b = (n * sxy - sy * sx) / den, a = (sx - b * sy) / n;
              if (Math.abs(r[1] - (a + b * r[0])) > 34) break;
            }
          }
          rows.push(r);
        }
        if (rows.length < 25) return null;
        const span = rows[rows.length - 1][0] - rows[0][0];
        if (span < J.headH * 0.7) return null;
        const sm = rows.map((r, i) => {
          let s = 0, c = 0;
          for (let d = -2; d <= 2; d++) { const q = rows[i + d]; if (q) { s += q[1]; c++; } }
          return [r[0], s / c];
        });
        const at = f => sm.reduce((best, r) => Math.abs(r[0] - (sm[0][0] + span * f)) < Math.abs(best[0] - (sm[0][0] + span * f)) ? r : best, sm[0]);
        const sho = [sm[0][1], sm[0][0]], elb = at(0.52), wri = [sm[sm.length - 1][1], sm[sm.length - 1][0]];
        return { sho, elb: [elb[1], elb[0]], wri };
      };
      const armL = detectArm(1), armR = detectArm(-1); // image-right side = +x
      if (armL) { J.shoL = armL.sho; J.elbL = armL.elb; J.wriL = armL.wri; }
      if (armR) { J.shoR = armR.sho; J.elbR = armR.elb; J.wriR = armR.wri; }
      const R = Math.max(16, J.faceW * 0.157), F = Math.max(5, R * 0.3), R2 = (R + 12) * (R + 12);
      const out = new ImageData(W, H); out.data.set(data);
      const od = out.data;
      // fill arm holes with TORSO fabric: smear toward the body's centre line
      const arms = [
        { segs: [[J.shoR, J.elbR], [J.elbR, J.wriR]], shift: Math.sign(J.faceCx - J.shoR[0]) * R * 1.35 },
        { segs: [[J.shoL, J.elbL], [J.elbL, J.wriL]], shift: Math.sign(J.faceCx - J.shoL[0]) * R * 1.35 }
      ];
      // pass 1: erase the arms (smear neighbouring pixels over them)
      for (const a of arms) {
        const xs = a.segs.flatMap(s => [s[0][0], s[1][0]]), ys = a.segs.flatMap(s => [s[0][1], s[1][1]]);
        const x0 = Math.max(0, Math.floor(Math.min(...xs) - R - 16)), x1 = Math.min(W - 1, Math.ceil(Math.max(...xs) + R + 16));
        const y0 = Math.max(0, Math.floor(Math.min(...ys) - R - 16)), y1 = Math.min(H - 1, Math.ceil(Math.max(...ys) + R + 16));
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
          const d2 = Math.min(distSeg2(x, y, a.segs[0][0], a.segs[0][1]), distSeg2(x, y, a.segs[1][0], a.segs[1][1]));
          if (d2 > R2) continue;
          const i = (y * W + x) * 4;
          const sxp = Math.max(0, Math.min(W - 1, Math.round(x + a.shift)));
          let j = (y * W + sxp) * 4;
          if (data[j + 3] < 40) { const syp = Math.max(0, y - Math.round(J.headH * 0.68)); j = (syp * W + sxp) * 4; }
          od[i] = data[j]; od[i + 1] = data[j + 1]; od[i + 2] = data[j + 2]; od[i + 3] = data[j + 3];
        }
        await tick();
      }
      // pass 2: erase the face ellipse completely (no ghost features under the head)
      {
        const [ecx, ecy, erx, ery] = J.ellipse;
        const snapE = new Uint8ClampedArray(od);
        const x0 = Math.max(0, Math.floor(ecx - erx * 1.15)), x1 = Math.min(W - 1, Math.ceil(ecx + erx * 1.15));
        const y0 = Math.max(0, Math.floor(ecy - ery * 1.15)), y1 = Math.min(H - 1, Math.ceil(ecy + ery * 1.15));
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
          if (y > J.chin + J.headH * 0.08) continue; // throat/neck keep their real art
          const dE = Math.hypot((x - ecx) / erx, (y - ecy) / ery);
          if (dE >= 1.10) continue;
          const i = (y * W + x) * 4;
          if (snapE[i + 3] < 30) continue;
          const f = Math.max(0, Math.min(1, (1.10 - dE) / 0.18)), dir = x < ecx ? -1 : 1;
          let sxp = Math.max(0, Math.min(W - 1, Math.round(x + dir * erx * 1.3))), j = (y * W + sxp) * 4;
          if (snapE[j + 3] < 30) { sxp = Math.max(0, Math.min(W - 1, Math.round(x - dir * erx * 1.3))); j = (y * W + sxp) * 4; }
          const has = snapE[j + 3] >= 30;
          od[i] = Math.round((has ? snapE[j] : 58) * f + snapE[i] * (1 - f));
          od[i + 1] = Math.round((has ? snapE[j + 1] : 44) * f + snapE[i + 1] * (1 - f));
          od[i + 2] = Math.round((has ? snapE[j + 2] : 40) * f + snapE[i + 2] * (1 - f));
        }
        await tick();
      }
      // pass 3: erase remaining skin tones in the head band (jaw/neck remnants)
      {
        const NL = J.neck[1], FH = Math.max(8, J.headH * 0.06);
        const snap = new Uint8ClampedArray(od);
        const x0 = Math.max(0, Math.floor(J.headBox[0])), x1 = Math.min(W - 1, Math.ceil(J.headBox[2]));
        const y1 = Math.min(H - 1, Math.ceil(Math.min(NL + FH, J.chin + J.headH * 0.08)));
        for (let y = 0; y <= y1; y++) {
          const f = Math.max(0, Math.min(1, (NL + FH - y) / (2 * FH)));
          if (f <= 0.02) continue;
          for (let x = x0; x <= x1; x++) {
            const i = (y * W + x) * 4;
            if (snap[i + 3] < 30) continue;
            if (!(snap[i] > 120 && snap[i] > snap[i + 2] + 18)) continue;
            const dir = x < J.faceCx ? -1 : 1;
            let sxp = Math.max(0, Math.min(W - 1, Math.round(x + dir * J.faceW * 0.32))), j = (y * W + sxp) * 4;
            if (snap[j + 3] < 30) { sxp = Math.max(0, Math.min(W - 1, Math.round(x - dir * J.faceW * 0.32))); j = (y * W + sxp) * 4; }
            const has = snap[j + 3] >= 30;
            od[i] = Math.round((has ? snap[j] : 58) * f + snap[i] * (1 - f));
            od[i + 1] = Math.round((has ? snap[j + 1] : 44) * f + snap[i + 1] * (1 - f));
            od[i + 2] = Math.round((has ? snap[j + 2] : 40) * f + snap[i + 2] * (1 - f));
            od[i + 3] = Math.max(snap[i + 3], Math.round((has ? snap[j + 3] : 255) * f));
          }
        }
        await tick();
      }
      const erased = document.createElement('canvas'); erased.width = W; erased.height = H;
      erased.getContext('2d').putImageData(out, 0, 0);
      // head piece: head + flowing hair, feathered only at its bottom edge so
      // the junction hides where hair meets the dress
      const NL = J.neck[1], FH = Math.max(8, J.headH * 0.06), hb = J.headBox;
      const hw = Math.round(hb[2] - hb[0]), hh = Math.round(hb[3] - hb[1]);
      const headC = document.createElement('canvas'); headC.width = hw; headC.height = hh;
      const hctx = headC.getContext('2d', { willReadFrequently: true });
      hctx.drawImage(img, -hb[0], -hb[1]);
      const hid = hctx.getImageData(0, 0, hw, hh), hd = hid.data;
      for (let y = 0; y < hh; y++) {
        const gy = y + hb[1];
        if (gy < hb[3] - FH * 2) continue;
        const f = Math.max(0, Math.min(1, (hb[3] - gy) / (FH * 2)));
        for (let x = 0; x < hw; x++) { const i = (y * hw + x) * 4 + 3; hd[i] = Math.round(hd[i] * f); }
      }
      hctx.putImageData(hid, 0, 0);
      const head = { img: headC, box: hb, pivot: J.headPivot };
      await tick();
      // arm strips: feathered masks around each bone
      const strips = {};
      const segDefs = [['Rup', J.shoR, J.elbR], ['Rlo', J.elbR, J.wriR], ['Lup', J.shoL, J.elbL], ['Llo', J.elbL, J.wriL]];
      for (const [name, a, b] of segDefs) {
        const box = [
          Math.max(0, Math.min(a[0], b[0]) - R - 14), Math.max(0, Math.min(a[1], b[1]) - R - 14),
          Math.min(W, Math.max(a[0], b[0]) + R + 14), Math.min(H, Math.max(a[1], b[1]) + R + 14)
        ];
        const cw = Math.round(box[2] - box[0]), ch = Math.round(box[3] - box[1]);
        const c = document.createElement('canvas'); c.width = cw; c.height = ch;
        const cctx = c.getContext('2d', { willReadFrequently: true });
        cctx.drawImage(img, -box[0], -box[1]);
        const idd = cctx.getImageData(0, 0, cw, ch), dd = idd.data;
        const isUpper = name === 'Rup' || name === 'Lup';
        const vx = b[0] - a[0], vy = b[1] - a[1], L2 = vx * vx + vy * vy || 1;
        const crossC = (J.faceCx - a[0]) * vy - (((a[1] + b[1]) / 2) - a[1]) * vx;
        for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
          const gx = x + box[0], gy = y + box[1];
          let t = ((gx - a[0]) * vx + (gy - a[1]) * vy) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t;
          // taper: narrow at the shoulder (keeps dress fabric out of the strip),
          // full width at the hand; and narrower on the body-centre side, where
          // the strip would otherwise bite into the dress
          let Rt = R * (isUpper ? (0.60 + 0.40 * t) : (0.62 + 0.36 * t)) + F;
          const cross = (gx - a[0]) * vy - (gy - a[1]) * vx;
          if (crossC !== 0 && Math.sign(cross) === Math.sign(crossC)) Rt *= 0.7;
          const d = Math.sqrt(distSeg2(gx, gy, a, b));
          const f = Math.max(0, Math.min(1, (Rt - d) / (2 * F)));
          if (f < 0.999) { const i = (y * cw + x) * 4 + 3; dd[i] = Math.round(dd[i] * f); }
        }
        cctx.putImageData(idd, 0, 0);
        strips[name] = { img: c, box, from: a, to: b };
        await tick();
      }
      pack.rig = { erased, strips, head, J, W, H, bbox };
      return pack.rig;
    } catch (e) { pack.rigFailed = true; return null; }
  })();
  return pack.rigPromise;
}

/* ---------- state ---------- */
const state = {
  mode: 'idle', pose: null, face: null, hands: [],
  recording: false, chunks: [], recorder: null, stream: null,
  recUrl: null, recStart: 0, quality: 'high', reel: false, bg: null,
  hpS: { yaw: 0, pitch: 0, roll: 0 }, msgAt: 0, autoBalanced: false, lowFpsSince: 0,
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
function faceState() {
  const c = (state.face && state.face.cats) || {};
  const blink = ((c.eyeBlinkLeft || 0) + (c.eyeBlinkRight || 0)) / 2 > 0.5;
  const smile = ((c.mouthSmileLeft || 0) + (c.mouthSmileRight || 0)) / 2, jaw = c.jawOpen || 0;
  let mouth = null;
  if (jaw > 0.22) mouth = 'A';
  else if ((c.mouthFunnel || 0) > 0.3) mouth = 'O';
  else if (smile > 0.34) mouth = 'E';
  const wide = smile > 0.45 && jaw > 0.1; // laughing: the big grin wins
  if (wide) mouth = 'E';
  return { blink, mouth, wide };
}
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
function drawFaceTiles(pack, place) {
  const fs = faceState(), F = pack.face || {};
  if (fs.blink && pack.tiles.blink && F.blink) {
    const p = place(F.blink.c[0], F.blink.c[1]);
    drawTile(pack.tiles.blink, p.x, p.y, F.blink.w * place.scale, place.rot);
  }
  if (fs.mouth && pack.tiles[fs.mouth] && F[fs.mouth]) {
    const p = place(F[fs.mouth].c[0], F[fs.mouth].c[1]);
    let w = F[fs.mouth].w * place.scale;
    if (fs.wide && fs.mouth === 'E') w *= 1.2;
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
  if (ll < 4) return;
  ctx.save(); ctx.translate(liveFrom.x, liveFrom.y); ctx.rotate(la - ra); ctx.scale(ll / rl, ll / rl);
  ctx.drawImage(st.img, -(rf[0] - st.box[0]), -(rf[1] - st.box[1])); ctx.restore();
}

/* ---------- the lead: YOU, converted ---------- */
function updateHeadPose() {
  const hpR = headPoseRaw(), hp = state.hpS;
  if (hpR) { hp.yaw += (hpR.yaw - hp.yaw) * 0.5; hp.pitch += (hpR.pitch - hp.pitch) * 0.5; hp.roll += (hpR.roll - hp.roll) * 0.5; }
  else { hp.yaw *= 0.92; hp.pitch *= 0.92; hp.roll *= 0.92; }
}
function drawHeadPiece(pack, rig, imgPt, k, tilt) {
  const pv = rig.head.pivot, pivLive = imgPt(pv[0], pv[1]);
  ctx.save(); ctx.translate(pivLive.x, pivLive.y); ctx.rotate(tilt + state.hpS.roll * 0.85);
  ctx.scale(k * (1 - 0.35 * Math.abs(state.hpS.yaw)), k);
  ctx.drawImage(rig.head.img, -(pv[0] - rig.head.box[0]), -(pv[1] - rig.head.box[1]));
  const fs = faceState(), F = pack.face || {};
  const tileLocal = (imgT, c, w) => {
    if (!imgT || !c) return;
    const h = w * imgT.naturalHeight / imgT.naturalWidth;
    ctx.drawImage(imgT, c[0] - pv[0] - w / 2, c[1] - pv[1] - h / 2, w, h);
  };
  if (fs.blink && F.blink) tileLocal(pack.tiles.blink, F.blink.c, F.blink.w);
  if (fs.mouth && F[fs.mouth]) tileLocal(pack.tiles[fs.mouth], F[fs.mouth].c, F[fs.mouth].w * (fs.wide && fs.mouth === 'E' ? 1.2 : 1));
  ctx.restore();
}
/* Selfie distance: no body in frame, but a face — the performance still
   lives. The character is anchored to your face: it stands where you are,
   its head turns with yours, its mouth and blinks are yours, arms at rest. */
function drawFaceLed(pack, W, H) {
  const fl = state.face.landmarks;
  const e1 = toPx(fl[33]), e2 = toPx(fl[263]);
  const eyeC = mid(e1, e2), eyeSpan = Math.max(12, Math.hypot(e2.x - e1.x, e2.y - e1.y));
  const rig = (RIG_PACKS.has(cast.lead) && pack.rig) ? pack.rig : null;
  if (rig) {
    const J = rig.J, blinkW = (pack.manifest.talk.patches.blink || {}).w || J.faceW / 1.55;
    let k = eyeSpan / blinkW;
    k = Math.max(0.10, Math.min(k, (H * 1.25) / rig.H));
    const tilt = state.hpS.roll;
    const nox = (J.neck[0] - J.faceCx) * k, noy = (J.neck[1] - J.eyeY) * k;
    const c = Math.cos(tilt), s = Math.sin(tilt);
    const O = { x: eyeC.x + nox * c - noy * s, y: eyeC.y + nox * s + noy * c }, org = J.neck;
    const imgPt = (fx, fy) => {
      const dx = (fx - org[0]) * k, dy = (fy - org[1]) * k;
      return { x: O.x + dx * c - dy * s, y: O.y + dx * s + dy * c };
    };
    const feet = imgPt(J.hip[0], rig.bbox.y + rig.bbox.h);
    state.leadFeetY = Math.min(H - 4, feet.y); state.leadH = rig.bbox.h * k;
    shadow(feet.x, Math.min(H - 6, feet.y), 300 * k);
    drawStrip(rig.strips.Rup, imgPt(J.shoR[0], J.shoR[1]), imgPt(J.elbR[0], J.elbR[1]));
    drawStrip(rig.strips.Lup, imgPt(J.shoL[0], J.shoL[1]), imgPt(J.elbL[0], J.elbL[1]));
    ctx.save(); ctx.translate(O.x, O.y); ctx.rotate(tilt); ctx.scale(k, k);
    ctx.drawImage(rig.erased, -org[0], -org[1]); ctx.restore();
    drawStrip(rig.strips.Rlo, imgPt(J.elbR[0], J.elbR[1]), imgPt(J.wriR[0], J.wriR[1]));
    drawStrip(rig.strips.Llo, imgPt(J.elbL[0], J.elbL[1]), imgPt(J.wriL[0], J.wriL[1]));
    drawHeadPiece(pack, rig, imgPt, k, tilt);
  } else {
    if (RIG_PACKS.has(cast.lead) && !pack.rigFailed) buildRigAsync(pack);
    const img = pack.img.base, blinkW = ((pack.manifest.talk || {}).patches || {}).blink ? pack.manifest.talk.patches.blink.w : 130;
    const charH = Math.min(H * 1.5, eyeSpan / blinkW * img.naturalHeight), charW = charH * img.naturalWidth / img.naturalHeight;
    const top = eyeC.y - charH * 0.22;
    state.leadFeetY = Math.min(H - 4, top + charH); state.leadH = charH;
    shadow(eyeC.x, Math.min(H - 6, top + charH), charW * 0.8);
    ctx.drawImage(img, eyeC.x - charW / 2, top, charW, charH);
    const place = (fx, fy) => ({ x: eyeC.x - charW / 2 + fx / img.naturalWidth * charW, y: top + fy / img.naturalHeight * charH });
    place.scale = charW / img.naturalWidth; place.rot = 0;
    drawFaceTiles(pack, place);
  }
}
function drawLead() {
  const pack = packs[cast.lead];
  if (!pack || !pack.img.base) return;
  const W = stage.width, H = stage.height, lm = state.pose;
  updateHeadPose();
  if (!lm && state.face && state.face.landmarks) { drawFaceLed(pack, W, H); return; }
  if (!lm) {
    const img = pack.img.base, h = H * 0.94, w = h * img.naturalWidth / img.naturalHeight;
    state.leadH = h; state.leadFeetY = H - 4;
    shadow(W / 2, H - 6, w * 0.7);
    ctx.drawImage(img, (W - w) / 2, H - h, w, h);
    return;
  }
  const P = i => toPx(lm[i]);
  const hip = mid(P(23), P(24)), neckC = mid(P(11), P(12));
  const torsoVec = { x: neckC.x - hip.x, y: neckC.y - hip.y };
  const torsoLen = Math.max(30, Math.hypot(torsoVec.x, torsoVec.y));
  const tilt = Math.atan2(torsoVec.x, -torsoVec.y);
  const rig = (RIG_PACKS.has(cast.lead) && pack.rig) ? pack.rig : null;
  if (rig) {
    const J = rig.J;
    const liveShoulder = Math.max(24, Math.hypot(P(11).x - P(12).x, P(11).y - P(12).y));
    let k = liveShoulder / J.shoulderDist;
    k = Math.max(0.10, Math.min(k, (H * 1.35) / rig.H));
    const relScale = k * J.shoulderDist / liveShoulder;
    const O = neckC, org = J.neck;
    const imgPt = (fx, fy) => {
      const dx = (fx - org[0]) * k, dy = (fy - org[1]) * k;
      const c = Math.cos(tilt), s = Math.sin(tilt);
      return { x: O.x + dx * c - dy * s, y: O.y + dx * s + dy * c };
    };
    const rel = i => { const p = P(i); return { x: O.x + (p.x - O.x) * relScale, y: O.y + (p.y - O.y) * relScale }; };
    const feet = imgPt(J.hip[0], rig.bbox.y + rig.bbox.h);
    state.leadFeetY = Math.min(H - 4, feet.y);
    state.leadH = rig.bbox.h * k;
    shadow(feet.x, Math.min(H - 6, feet.y), 300 * k);
    // upper arms go UNDER the torso (their tops tuck behind the dress),
    // forearms and head ride on top
    drawStrip(rig.strips.Rup, imgPt(J.shoR[0], J.shoR[1]), rel(14));
    drawStrip(rig.strips.Lup, imgPt(J.shoL[0], J.shoL[1]), rel(13));
    ctx.save(); ctx.translate(O.x, O.y); ctx.rotate(tilt); ctx.scale(k, k);
    ctx.drawImage(rig.erased, -org[0], -org[1]); ctx.restore();
    drawStrip(rig.strips.Rlo, rel(14), rel(16));
    drawStrip(rig.strips.Llo, rel(13), rel(15));
    // head: own piece, gaze-driven, face tiles drawn inside its transform
    drawHeadPiece(pack, rig, imgPt, k, tilt);
  } else {
    if (RIG_PACKS.has(cast.lead) && !pack.rigFailed) buildRigAsync(pack); // still cutting the puppet: anchored meanwhile
    const img = pack.img.base;
    const ankY = Math.max(P(27).y, P(28).y), span = Math.max(80, ankY - P(0).y);
    const charH = Math.min(H * 1.05, span * 1.5), charW = charH * img.naturalWidth / img.naturalHeight;
    const cx = hip.x, feetY = Math.min(H - 4, ankY + charH * 0.06);
    state.leadFeetY = feetY; state.leadH = charH;
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
  drawLead();
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
window.__rangmanch = { version: VERSION, state, raw, cast, packs, ensurePack, buildRigAsync, stage };

fillCastSelects();
requestAnimationFrame(loop);
