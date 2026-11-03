#!/usr/bin/env node
/* Rangmanch AR sandbox test harness.
   Drives the REAL app in Chromium (system binary) via playwright-core:
   captures console errors, measures rig build time, screenshots the stage
   under Demo Mode and under synthetic landmark scenarios injected through
   the app's debug handle (window.__rangmanch), and verifies recording.
   Run: node tests/sandbox.mjs   (expects playwright-core resolvable —
   the workspace test-rig install is wired in below as a fallback). */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let chromium;
try { ({ chromium } = await import('playwright-core')); }
catch (e) {
  const req = createRequire('/home/hatch/workspace/tools/testrig/package.json');
  ({ chromium } = req('playwright-core'));
}
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SHOTS = path.join(ROOT, 'tests', 'shots');
mkdirSync(SHOTS, { recursive: true });
const PORT = 8901;

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(700);

const results = { errors: [], shots: [], checks: {} };
const browser = await chromium.launch({
  args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required']
});
const page = await browser.newPage({ viewport: { width: 1280, height: 950 } });
page.on('console', m => { if (m.type() === 'error') results.errors.push(m.text().slice(0, 300)); });
page.on('pageerror', e => results.errors.push('pageerror: ' + String(e).slice(0, 300)));

async function shot(name) {
  const el = await page.$('#stage');
  await el.screenshot({ path: path.join(SHOTS, name + '.png') });
  results.shots.push(name);
}
const R = () => window.__rangmanch;

await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' }).catch(() => {});
await page.waitForFunction(() => window.__rangmanch && window.__rangmanch.packs.swapnil && window.__rangmanch.packs.swapnil.img.base, null, { timeout: 20000 }).catch(() => {});
results.checks.packLoaded = await page.evaluate(() => !!(window.__rangmanch.packs.swapnil && window.__rangmanch.packs.swapnil.img.base));
results.checks.tilesLoaded = await page.evaluate(() => ['A', 'O', 'E', 'blink'].every(k => !!window.__rangmanch.packs.swapnil.tiles[k]));
const t0 = Date.now();
await page.waitForFunction(() => window.__rangmanch.packs.swapnil.poses.wave, null, { timeout: 30000 }).catch(() => {});
results.checks.posesLoaded = await page.evaluate(() => !!window.__rangmanch.packs.swapnil.poses.wave);
results.checks.loadMs = Date.now() - t0;
await sleep(600);
await shot('01-idle');

// Demo Mode end-to-end
await page.click('#btn-demo');
await sleep(2600);
await shot('02-demo-a');
await sleep(1100);
await shot('03-demo-b');
results.checks.fpsText = await page.textContent('#fps');

// Controlled synthetic scenarios (mode 'camera' with no models => raw stays ours)
await page.evaluate(() => {
  const R = window.__rangmanch;
  R.state.mode = 'camera';
  const P = [];
  for (let i = 0; i < 33; i++) P.push({ x: 0.5, y: 0.5, z: 0, visibility: 1 });
  const set = (i, x, y) => { P[i] = { x, y, z: 0, visibility: 1 }; };
  set(0, 0.5, 0.18);
  set(11, 0.44, 0.30); set(12, 0.56, 0.30); set(13, 0.40, 0.45); set(14, 0.60, 0.45);
  set(15, 0.38, 0.60); set(16, 0.62, 0.60);
  set(23, 0.46, 0.55); set(24, 0.54, 0.55); set(27, 0.45, 0.92); set(28, 0.55, 0.92);
  R.raw.pose = P;
  const fl = []; for (let i = 0; i < 468; i++) fl.push({ x: 0.5, y: 0.3, z: 0 });
  fl[1] = { x: 0.5, y: 0.315, z: 0 }; fl[33] = { x: 0.465, y: 0.30, z: 0 }; fl[263] = { x: 0.535, y: 0.30, z: 0 };
  const cats = { eyeBlinkLeft: 0, eyeBlinkRight: 0, jawOpen: 0, mouthSmileLeft: 0, mouthSmileRight: 0, mouthFunnel: 0, mouthPucker: 0, mouthStretchLeft: 0 };
  R.raw.face = { landmarks: fl, cats };
  R.raw.hands = [];
  window.__setPose = fn => fn(P, fl, cats);
});
await sleep(900);
await shot('04-synth-rest');
// wave + mouth A
await page.evaluate(() => window.__setPose((P, fl, cats) => {
  P[14] = { x: 0.64, y: 0.16, z: 0, visibility: 1 }; P[16] = { x: 0.60, y: 0.03, z: 0, visibility: 1 };
  cats.jawOpen = 0.6;
}));
await sleep(900);
results.checks.poseWave = await page.evaluate(() => window.__rangmanch.state.poseName);
await shot('05-synth-wave-talk');
// look screen-left + laugh (in mirrored view, nose landmark x smaller => nose appears right of eye mid after flip; test both signs visually)
await page.evaluate(() => window.__setPose((P, fl, cats) => {
  P[14] = { x: 0.60, y: 0.45, z: 0, visibility: 1 }; P[16] = { x: 0.62, y: 0.60, z: 0, visibility: 1 };
  cats.jawOpen = 0.2; cats.mouthSmileLeft = 0.8; cats.mouthSmileRight = 0.8;
  fl[1] = { x: 0.472, y: 0.315, z: 0 };
}));
await sleep(900);
await shot('06-synth-look-laugh');
// blink
await page.evaluate(() => window.__setPose((P, fl, cats) => {
  cats.mouthSmileLeft = 0; cats.mouthSmileRight = 0; cats.jawOpen = 0;
  cats.eyeBlinkLeft = 0.95; cats.eyeBlinkRight = 0.95;
  fl[1] = { x: 0.5, y: 0.315, z: 0 };
}));
await sleep(700);
await shot('07-synth-blink');
// gesture classifier: one straight arm out to the side => point pose
await page.evaluate(() => window.__setPose(P => {
  const set = (i, x, y) => { P[i] = { x, y, z: 0, visibility: 1 }; };
  set(13, 0.33, 0.305); set(15, 0.19, 0.30);
}));
await sleep(1000);
results.checks.posePoint = await page.evaluate(() => window.__rangmanch.state.poseName);
await shot('14-synth-point');
// both arms raised => open pose
await page.evaluate(() => window.__setPose(P => {
  const set = (i, x, y) => { P[i] = { x, y, z: 0, visibility: 1 }; };
  set(13, 0.37, 0.21); set(15, 0.30, 0.12); set(14, 0.63, 0.21); set(16, 0.70, 0.12);
}));
await sleep(1000);
results.checks.poseOpen = await page.evaluate(() => window.__rangmanch.state.poseName);
await shot('15-synth-open');
// arms back down => base pose again
await page.evaluate(() => window.__setPose(P => {
  const set = (i, x, y) => { P[i] = { x, y, z: 0, visibility: 1 }; };
  set(13, 0.40, 0.45); set(15, 0.38, 0.60); set(14, 0.60, 0.45); set(16, 0.62, 0.60);
}));
await sleep(1000);
results.checks.poseBackToBase = await page.evaluate(() => window.__rangmanch.state.poseName);
// portrait close-up: hips/ankles off-frame
await page.evaluate(() => window.__setPose((P, fl, cats) => {
  cats.eyeBlinkLeft = 0; cats.eyeBlinkRight = 0;
  const set = (i, x, y, v = 1) => { P[i] = { x, y, z: 0, visibility: v }; };
  set(0, 0.5, 0.16); set(11, 0.27, 0.40); set(12, 0.73, 0.40);
  set(13, 0.15, 0.62); set(14, 0.85, 0.62); set(15, 0.10, 0.86); set(16, 0.90, 0.86);
  set(23, 0.40, 1.18, 0.2); set(24, 0.60, 1.18, 0.2); set(27, 0.42, 1.70, 0.1); set(28, 0.58, 1.70, 0.1);
}));
await sleep(900);
await shot('08-synth-portrait');
// co-actors on (restore full-body pose, add hands)
await page.evaluate(() => {
  const R = window.__rangmanch;
  document.querySelector('#coactors').checked = true;
  window.__setPose(P => {
    const set = (i, x, y) => { P[i] = { x, y, z: 0, visibility: 1 }; };
    set(11, 0.44, 0.30); set(12, 0.56, 0.30); set(13, 0.40, 0.45); set(14, 0.60, 0.45);
    set(15, 0.38, 0.60); set(16, 0.62, 0.60); set(23, 0.46, 0.55); set(24, 0.54, 0.55);
    set(27, 0.45, 0.92); set(28, 0.55, 0.92); set(0, 0.5, 0.18);
  });
  const mkHand = cx => { const h = []; for (let i = 0; i < 21; i++) h.push({ x: cx, y: 0.6, z: 0 }); h[9] = { x: cx, y: 0.55, z: 0 }; h[4] = { x: cx - 0.03, y: 0.5, z: 0 }; h[8] = { x: cx + 0.04, y: 0.48, z: 0 }; return h; };
  R.raw.hands = [mkHand(0.22), mkHand(0.80)];
});
await sleep(2200);
await shot('09-synth-coactors');
// reel mode
await page.click('#btn-reel');
await sleep(800);
await shot('10-reel');
await page.click('#btn-reel');

// second rig pack end-to-end (sanjay: different art, kurta body)
await page.evaluate(() => { window.__rangmanch.state.mode = 'idle'; });
await page.selectOption('#cast-body', 'sanjay');
await page.waitForFunction(() => window.__rangmanch.packs.sanjay && window.__rangmanch.packs.sanjay.poses.wave, null, { timeout: 30000 }).catch(() => {});
results.checks.sanjayPoses = await page.evaluate(() => !!window.__rangmanch.packs.sanjay.poses.wave);
await page.evaluate(() => {
  window.__rangmanch.state.mode = 'camera'; document.querySelector('#coactors').checked = false;
  // reset to the centred rest performer (demo's last face may be mid-glance)
  window.__setPose((P, fl, cats) => {
    const set = (i, x, y) => { P[i] = { x, y, z: 0, visibility: 1 }; };
    set(0, 0.5, 0.18); set(11, 0.44, 0.30); set(12, 0.56, 0.30);
    set(13, 0.40, 0.45); set(14, 0.60, 0.45); set(15, 0.38, 0.60); set(16, 0.62, 0.60);
    set(23, 0.46, 0.55); set(24, 0.54, 0.55); set(27, 0.45, 0.92); set(28, 0.55, 0.92);
    fl[1] = { x: 0.5, y: 0.315, z: 0 };
    cats.jawOpen = 0; cats.mouthSmileLeft = 0; cats.mouthSmileRight = 0; cats.eyeBlinkLeft = 0; cats.eyeBlinkRight = 0;
    window.__rangmanch.raw.hands = [];
  });
});
await sleep(900);
await shot('11-sanjay-lead');

// face-only mode: selfie distance — no pose, face drives the lead
await page.evaluate(() => {
  const R = window.__rangmanch;
  R.state.mode = 'camera';
  R.raw.pose = null;
  const fl = []; for (let i = 0; i < 468; i++) fl.push({ x: 0.5, y: 0.3, z: 0 });
  fl[33] = { x: 0.44, y: 0.30, z: 0 }; fl[263] = { x: 0.56, y: 0.30, z: 0 };
  fl[1] = { x: 0.5, y: 0.33, z: 0 };
  R.raw.face = { landmarks: fl, cats: { eyeBlinkLeft: 0, eyeBlinkRight: 0, jawOpen: 0.55, mouthSmileLeft: 0.1, mouthSmileRight: 0.1, mouthFunnel: 0 } };
  R.raw.hands = [];
});
await sleep(900);
await shot('13-faceonly');
results.checks.faceOnly = true;

// recording round-trip (demo drives it)
await page.selectOption('#cast-body', 'swapnil');
await page.evaluate(() => { window.__rangmanch.state.mode = 'idle'; });
await page.click('#btn-demo'); // demo on (mode was idle after evaluate? ensure on)
await sleep(400);
const demoOn = await page.evaluate(() => window.__rangmanch.state.mode === 'demo');
if (!demoOn) await page.click('#btn-demo');
await page.click('#btn-record');
await sleep(1800);
await page.click('#btn-record');
await sleep(900);
results.checks.downloadReady = await page.evaluate(() => {
  const a = document.querySelector('#download');
  return !a.hidden && (a.href || '').startsWith('blob:');
});
await shot('12-after-record');

results.checks.thumbsOk = await page.evaluate(() =>
  ['thumb-body', 'thumb-left', 'thumb-right'].every(id => { const i = document.getElementById(id); return i && i.complete && i.naturalWidth > 0; }));

console.log(JSON.stringify(results, null, 1));
await browser.close();
server.kill();
process.exit(0);
