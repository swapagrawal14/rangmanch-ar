#!/usr/bin/env node
/* Rangmanch AR v2.1 regression tests — assert-based, exit code 1 on failure.
   Drives the real app in Chromium at phone size (390x844) and checks every
   v2.1 fix: light first load, phone layout, per-arm gestures with mirroring,
   pose normalisation (no size jump on a swap), face anchors for all 16
   packs, face-hold placement, camera-denied message, recording format and
   the WebM duration fix.
   Run: node tests/v21.test.mjs   (see tests/_rig.mjs for env options) */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getChromium, routeMediapipe } from './_rig.mjs';

const chromium = await getChromium();
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 8911;
const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(700);
const URL0 = `http://localhost:${PORT}/`;

let failed = 0, passed = 0;
const ok = (cond, name, detail) => {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
};

const browser = await chromium.launch({
  args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required']
});
const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

/* ---------- 1. first load + phone layout ---------- */
console.log('first load + phone layout');
{
  const ctx = await browser.newContext(phone);
  const page = await ctx.newPage();
  await routeMediapipe(page);
  let packBytes = 0; const packFiles = new Set();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('response', async r => { if (r.url().includes('/assets/packs/')) { packFiles.add(r.url().split('/assets/packs/')[1].split('/')[0]); try { packBytes += (await r.body()).length; } catch (e) { /* */ } } });
  await page.goto(URL0, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__rangmanch && window.__rangmanch.packs.swapnil && window.__rangmanch.packs.swapnil.poses.wave, null, { timeout: 30000 });
  await sleep(800);
  ok(errors.length === 0, 'no page errors on load', errors);
  ok([...packFiles].every(id => id === 'swapnil'), 'only the lead pack is downloaded on load (not all 16)', [...packFiles]);
  ok(packBytes < 4.5e6, 'first-load pack weight under 4.5 MB', packBytes);
  const L = await page.evaluate(() => {
    const r = s => document.querySelector(s).getBoundingClientRect();
    const st = r('#stage'), cam = r('#btn-camera'), rec = r('#btn-record');
    return { docW: document.documentElement.scrollWidth, stage: [st.top, st.bottom, st.width, st.height], cam: cam.bottom, rec: rec.bottom,
      canvas: [document.querySelector('#stage').width, document.querySelector('#stage').height], reel: window.__rangmanch.state.reel,
      videoDisplay: getComputedStyle(document.querySelector('#cam')).display,
      thumbs: [...document.querySelectorAll('.lead-pick img')].length };
  });
  ok(L.docW <= 390, 'no horizontal overflow at 390 px', L.docW);
  ok(L.reel && L.canvas[0] === 720 && L.canvas[1] === 1280, 'portrait phone opens on the 9:16 stage', L.canvas);
  ok(L.stage[3] > 500 && L.stage[2] > 280, 'stage fills most of the phone screen', L.stage);
  ok(L.cam <= 844 && L.rec <= 844, 'Start Camera and Record are visible without scrolling', [L.cam, L.rec]);
  ok(L.videoDisplay !== 'none', 'camera <video> is not display:none (iOS stops decoding those)', L.videoDisplay);
  ok(L.thumbs === 16, 'lead picker shows all 16 characters', L.thumbs);
  const thumbsW = await page.evaluate(async () => { const r = await fetch('assets/thumbs/swapnil.webp'); return (await r.arrayBuffer()).byteLength; });
  ok(thumbsW < 40000, 'picker thumbnails are small (<40 KB)', thumbsW);
  // tapping a character swaps the lead and loads only that pack
  await page.click('.lead-pick[data-id="mira"]');
  await page.waitForFunction(() => window.__rangmanch.packs.mira && window.__rangmanch.cast.lead === 'mira', null, { timeout: 20000 });
  ok(await page.evaluate(() => document.querySelector('.lead-pick[data-id="mira"]').getAttribute('aria-pressed') === 'true'), 'lead picker selects on tap');
  await ctx.close();
}

/* ---------- 2. face anchors + pose normalisation for every pack ---------- */
console.log('face anchors + pose normalisation');
{
  const ctx = await browser.newContext(phone);
  const page = await ctx.newPage();
  await routeMediapipe(page);
  await page.goto(URL0, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__rangmanch && window.__rangmanch.packs.swapnil, null, { timeout: 30000 });
  const info = await page.evaluate(async () => {
    const R = window.__rangmanch, out = {};
    for (const id of ['bhavishy', 'bubbles', 'bunty', 'doodle-swapnil', 'kiko', 'luna', 'mira', 'mocha', 'pia', 'puni', 'rafi', 'sanjay', 'seema', 'solana', 'static', 'swapnil']) {
      const p = await R.ensurePack(id);
      out[id] = p.poseInfo;
    }
    return out;
  });
  const ids = Object.keys(info);
  ok(ids.every(id => info[id].base.mouth && info[id].base.eyes), 'every pack has base mouth + eye anchors (12 had none before v2.1)', ids.filter(id => !info[id].base.mouth));
  const withPoseFace = ids.map(id => ['wave', 'point', 'open', 'thumbs'].filter(k => info[id][k].mouth).length).reduce((a, b) => a + b, 0);
  ok(withPoseFace >= 50, 'most pose drawings have a face anchor (talking/blinking works on poses)', withPoseFace);
  ok(ids.every(id => ['wave', 'point', 'open', 'thumbs'].every(k => info[id][k].scale >= 0.6 && info[id][k].scale <= 1.4)), 'drawing scales are plausible');
  // render: bunty's 'open' drawing is ~0.72x the base — after normalisation the face
  // must land where the base face is, i.e. the character does not shrink on the swap
  const face = await page.evaluate(async () => {
    const R = window.__rangmanch;
    await R.setLead('bunty');
    const p = R.packs.bunty; await p.posesLoading;
    R.state.mode = 'camera';
    const P = []; for (let i = 0; i < 33; i++) P.push({ x: 0.5, y: 0.5, z: 0, visibility: 1 });
    const set = (i, x, y) => { P[i] = { x, y, z: 0, visibility: 1 }; };
    set(0, 0.5, 0.2); set(11, 0.58, 0.32); set(12, 0.42, 0.32); set(13, 0.62, 0.45); set(14, 0.38, 0.45); set(15, 0.63, 0.58); set(16, 0.37, 0.58);
    set(23, 0.55, 0.58); set(24, 0.45, 0.58); set(27, 0.55, 0.92); set(28, 0.45, 0.92);
    R.raw.pose = P; R.raw.face = null; R.raw.hands = [];
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    await sleep(1500);
    // where does the face centre of the CURRENT drawing land on the stage?
    const where = () => {
      const st = R.state, G = R.packGeom(p), key = st.poseName, pi = p.poseInfo[key], bi = p.poseInfo.base;
      return { key, face: st.faceDbg, bbox: G.bbox };
    };
    const a = where();
    // both arms up -> open
    set(13, 0.64, 0.22); set(15, 0.68, 0.10); set(14, 0.36, 0.22); set(16, 0.32, 0.10);
    await sleep(1500);
    const b = where();
    return { a, b };
  });
  ok(face.a.key === 'base' && face.b.key === 'open', 'both arms up switches bunty to open', [face.a.key, face.b.key]);
  if (face.a.face && face.b.face) {
    const d = Math.hypot(face.a.face[0] - face.b.face[0], face.a.face[1] - face.b.face[1]);
    const ds = Math.abs(face.a.face[2] - face.b.face[2]) / face.a.face[2];
    ok(d < 30, 'face stays put across the pose swap (no teleport)', d);
    ok(ds < 0.12, 'face size stays the same across the swap (no shrink)', ds);
  } else ok(false, 'face position reported', face);
  await ctx.close();
}

/* ---------- 3. gestures: per arm, selfie framing, mirroring, hysteresis ---------- */
console.log('gestures');
{
  const ctx = await browser.newContext(phone);
  const page = await ctx.newPage();
  await routeMediapipe(page);
  await page.goto(URL0, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__rangmanch && window.__rangmanch.packs.swapnil && window.__rangmanch.packs.swapnil.poses.wave, null, { timeout: 30000 });
  await page.evaluate(() => {
    const R = window.__rangmanch; R.state.mode = 'camera';
    const P = []; for (let i = 0; i < 33; i++) P.push({ x: 0.5, y: 0.5, z: 0, visibility: 0.05 });
    window.__P = P;
    window.__set = (i, x, y, v = 0.95) => { P[i] = { x, y, z: 0, visibility: v }; };
    // selfie: face + shoulders, the phone-holding arm (person's left = 11/13/15) out of frame
    window.__set(0, 0.5, 0.25); window.__set(11, 0.66, 0.42); window.__set(12, 0.34, 0.42);
    window.__set(13, 0.8, 1.2, 0.1); window.__set(15, 0.9, 1.4, 0.05);
    window.__set(14, 0.27, 0.62); window.__set(16, 0.25, 0.80);
    R.raw.pose = P; R.raw.hands = [];
    const fl = []; for (let i = 0; i < 468; i++) fl.push({ x: 0.5, y: 0.25, z: 0 });
    fl[33] = { x: 0.56, y: 0.24, z: 0 }; fl[263] = { x: 0.44, y: 0.24, z: 0 }; fl[1] = { x: 0.5, y: 0.27, z: 0 };
    R.raw.face = { landmarks: fl, cats: { jawOpen: 0, eyeBlinkLeft: 0, eyeBlinkRight: 0 } };
  });
  await sleep(1200);
  ok(await page.evaluate(() => window.__rangmanch.state.poseName) === 'base', 'selfie rest = base pose');
  // free arm (person's right, appears on the stage's right in the mirrored view) raised high
  await page.evaluate(() => { window.__set(14, 0.22, 0.30); window.__set(16, 0.24, 0.12); });
  await sleep(1200);
  const w = await page.evaluate(() => ({ p: window.__rangmanch.state.poseName, s: window.__rangmanch.state.poseSide }));
  ok(w.p === 'wave', 'one free arm waves even with the other arm out of frame (selfie)', w);
  ok(w.s === 'R', 'wave side is the stage side of the raised arm', w);
  const mir = await page.evaluate(() => { const p = window.__rangmanch.packs.swapnil; return p.poseInfo.wave.side; });
  ok(mir === 'L', "swapnil's wave drawing waves its left arm, so a right-arm wave is mirrored", mir);
  // flicker: one stray frame of 'no gesture' must not drop the pose
  const flick = await page.evaluate(async () => {
    const R = window.__rangmanch, seen = new Set();
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    window.__set(16, 0.25, 0.80); await sleep(120); window.__set(16, 0.24, 0.12);
    for (let i = 0; i < 10; i++) { seen.add(R.state.poseName); await sleep(40); }
    return [...seen];
  });
  ok(flick.length === 1 && flick[0] === 'wave', 'a 120 ms tracking blip does not flicker the pose', flick);
  // point: straight arm out sideways at shoulder height
  await page.evaluate(() => { window.__set(14, 0.20, 0.43); window.__set(16, 0.06, 0.43); });
  await sleep(1300);
  ok(await page.evaluate(() => window.__rangmanch.state.poseName) === 'point', 'straight arm out = point');
  // both arms open (step back so both arms are in frame)
  await page.evaluate(() => { window.__set(13, 0.76, 0.30); window.__set(15, 0.80, 0.14); window.__set(14, 0.24, 0.30); window.__set(16, 0.20, 0.14); });
  await sleep(1300);
  ok(await page.evaluate(() => window.__rangmanch.state.poseName) === 'open', 'both arms up = open');
  // arms down -> base again
  await page.evaluate(() => { window.__set(13, 0.72, 0.62); window.__set(15, 0.74, 0.80); window.__set(14, 0.28, 0.62); window.__set(16, 0.26, 0.80); });
  await sleep(1500);
  ok(await page.evaluate(() => window.__rangmanch.state.poseName) === 'base', 'arms down = back to base');
  // face drop-out for one inference: placement stays in face mode (no jump)
  const hold = await page.evaluate(async () => {
    const R = window.__rangmanch, sleep = ms => new Promise(r => setTimeout(r, ms));
    const f = R.raw.face; await sleep(300);
    const before = R.state.figDbg.how;
    R.raw.face = null; await sleep(150); const during = R.state.figDbg.how; R.raw.face = f; await sleep(200);
    return { before, during };
  });
  ok(hold.before === 'face' && hold.during === 'face', 'a missed face frame does not switch placement mode', hold);
  // head stays on stage even when the face is near the top of the camera frame
  const top = await page.evaluate(async () => {
    const R = window.__rangmanch, sleep = ms => new Promise(r => setTimeout(r, ms));
    const fl = R.raw.face.landmarks; fl[33] = { x: 0.56, y: 0.04, z: 0 }; fl[263] = { x: 0.44, y: 0.04, z: 0 }; fl[1] = { x: 0.5, y: 0.07, z: 0 };
    await sleep(1500); return R.state.figDbg.headTop;
  });
  ok(top >= 0, 'character head never leaves the top of the stage', top);
  await ctx.close();
}

/* ---------- 3b. co-actors stand beside the lead on the 9:16 stage ---------- */
console.log('co-actors');
{
  const ctx = await browser.newContext(phone);
  const page = await ctx.newPage();
  await routeMediapipe(page);
  await page.goto(URL0, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__rangmanch && window.__rangmanch.packs.swapnil, null, { timeout: 30000 });
  await page.click('#coactors');
  const r = await page.evaluate(async () => {
    const R = window.__rangmanch, sleep = ms => new Promise(r => setTimeout(r, ms));
    R.state.mode = 'camera';
    const P = []; for (let i = 0; i < 33; i++) P.push({ x: 0.5, y: 0.5, z: 0, visibility: 1 });
    const set = (i, x, y) => { P[i] = { x, y, z: 0, visibility: 1 }; };
    set(0, 0.5, 0.2); set(2, 0.52, 0.18); set(5, 0.48, 0.18); set(11, 0.58, 0.3); set(12, 0.42, 0.3); set(13, 0.6, 0.45); set(14, 0.4, 0.45); set(15, 0.6, 0.58); set(16, 0.4, 0.58);
    set(23, 0.55, 0.56); set(24, 0.45, 0.56); set(27, 0.55, 0.9); set(28, 0.45, 0.9);
    R.raw.pose = P; R.raw.face = null;
    const mkHand = cx => { const h = []; for (let i = 0; i < 21; i++) h.push({ x: cx, y: 0.6, z: 0 }); h[9] = { x: cx, y: 0.55, z: 0 }; h[4] = { x: cx - 0.03, y: 0.5, z: 0 }; h[8] = { x: cx + 0.04, y: 0.48, z: 0 }; return h; };
    R.raw.hands = [mkHand(0.40), mkHand(0.60)]; // hands right in front of the body
    await sleep(3000);
    return { lead: R.state.leadCx, leadW: R.state.leadW, l: R.state.actors.left.x, r: R.state.actors.right.x, lp: R.state.actors.left.p, loaded: !!R.packs.mocha && !!R.packs.bunty };
  });
  ok(r.loaded && r.lp > 0.5, 'co-actor packs load on first use and walk on', r);
  ok(r.l < r.lead - r.leadW * 0.5 && r.r > r.lead + r.leadW * 0.5, 'co-actors stand beside the lead, not on top of them', r);
  await ctx.close();
}

/* ---------- 4. camera denied ---------- */
console.log('camera permission denied');
{
  const b2 = await chromium.launch({ args: ['--no-sandbox', '--deny-permission-prompts'] });
  const ctx = await b2.newContext(phone);
  const page = await ctx.newPage();
  await routeMediapipe(page);
  await page.goto(URL0, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__rangmanch, null, { timeout: 20000 });
  await page.click('#btn-camera');
  await sleep(2500);
  const msg = await page.textContent('#stage-msg');
  ok(/camera/i.test(msg) && !/Models: failed/i.test(msg), 'denied/missing camera gives a camera message, not a model failure', msg);
  ok(!(await page.isDisabled('#btn-camera')), 'Start Camera can be tapped again after a denial');
  await b2.close();
}

/* ---------- 5. recording ---------- */
console.log('recording');
{
  const ctx = await browser.newContext({ ...phone, acceptDownloads: true });
  const page = await ctx.newPage();
  await routeMediapipe(page);
  await page.goto(URL0, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__rangmanch && window.__rangmanch.packs.swapnil && window.__rangmanch.packs.swapnil.poses.wave, null, { timeout: 30000 });
  const picked = await page.evaluate(() => window.__rangmanch.pickRecType());
  ok(/^video\/mp4/.test(picked), 'MP4 is preferred when the browser can record it (iPhone Safari only can)', picked);
  await page.click('#btn-demo');
  await sleep(500);
  await page.click('#btn-record');
  await sleep(2600);
  ok(await page.evaluate(() => window.__rangmanch.state.recording), 'recording runs');
  ok(await page.isDisabled('#btn-reel') === false, 'reel button stays tappable');
  await page.click('#btn-reel'); // must refuse while recording
  ok(await page.evaluate(() => window.__rangmanch.state.reel === true), 'frame shape cannot change mid-recording');
  await page.click('#btn-record');
  await page.waitForFunction(() => !document.querySelector('#download').hidden, null, { timeout: 10000 });
  const dl = page.waitForEvent('download');
  await page.click('#download');
  const d = await dl;
  const f = path.join(os.tmpdir(), d.suggestedFilename());
  await d.saveAs(f);
  ok(/^rangmanch-\d{8}-\d{4}\.mp4$/.test(d.suggestedFilename()), 'download is named .mp4 with a timestamp', d.suggestedFilename());
  try {
    const pr = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', f]).toString());
    const v = pr.streams.find(s => s.codec_type === 'video');
    ok(v && v.width === 720 && v.height === 1280, 'film is 720x1280 (9:16)', v);
    ok(+pr.format.duration > 1.5, 'film has a real duration', pr.format.duration);
  } catch (e) { console.log('  (ffprobe not available — skipped file checks)'); }
  // WebM fallback: duration is written into the header
  const wb = await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 64; c.height = 64; const g = c.getContext('2d');
    let n = 0; const iv = setInterval(() => { g.fillStyle = `hsl(${n++ * 20},80%,50%)`; g.fillRect(0, 0, 64, 64); }, 33);
    const rec = new MediaRecorder(c.captureStream(30), { mimeType: 'video/webm' }); const ch = [];
    rec.ondataavailable = e => ch.push(e.data); rec.start(500);
    await new Promise(r => setTimeout(r, 1500)); rec.stop(); await new Promise(r => { rec.onstop = r; }); clearInterval(iv);
    const fixed = await window.__rangmanch.fixWebmDuration(new Blob(ch, { type: 'video/webm' }), 1500);
    return Array.from(new Uint8Array(await fixed.arrayBuffer()));
  });
  const wf = path.join(os.tmpdir(), 'rm-fixed.webm'); fs.writeFileSync(wf, Buffer.from(wb));
  try {
    const dur = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', wf]).toString().trim();
    ok(Math.abs(parseFloat(dur) - 1.5) < 0.2, 'WebM fallback gets a real duration (MediaRecorder WebM has none)', dur);
  } catch (e) { console.log('  (ffprobe not available — skipped webm check)'); }
  await ctx.close();
}

await browser.close();
server.kill();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
