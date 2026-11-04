#!/usr/bin/env node
/* Rangmanch AR v2.3 tests — Free arms. Assert-based, exit code 1 on failure.
   Part 1 (Node): the arm rig in freearms.js on synthetic landmarks — limb
   lengths never change (no detaching), both hands up puts both wrists above
   the shoulders, a heart (two hands touching) stays touching, the mirror is
   right, a lost hand is held 300 ms and then the arm eases down to rest.
   Part 2 (Chromium, 390x844): Doodle Swapnil performs on the armless torso
   with Free arms on by default, the toggle brings the pose drawings back,
   other characters keep the pose system, and the mouth + head warp still
   work with free arms.
   Run: node tests/v23.test.mjs   (see tests/_rig.mjs for env options) */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FreeArms, solveArm } from '../freearms.js';

let failed = 0, passed = 0;
const ok = (cond, name, detail) => {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
};
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/packs/doodle-swapnil/character.rigpop.json'), 'utf8'));
const rig = man.talk.freeArms;
const D = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

console.log('rig + asset');
ok(rig && rig.shoulders && rig.upper > 0 && rig.fore > 0 && /^#/.test(rig.sleeve) && /^#/.test(rig.skin), 'doodle-swapnil has an arm rig with colours sampled from the art', rig);
ok(fs.existsSync(path.join(ROOT, 'assets/packs/doodle-swapnil', man.talk.torso)), 'the armless torso drawing exists');
{
  // the torso has no arm pixels left: nothing opaque outside the body columns below the shoulders
  const png = fs.readFileSync(path.join(ROOT, 'assets/packs/doodle-swapnil', man.talk.torso));
  ok(png.length > 20000, 'torso.png is a real drawing', png.length);
}

console.log('2-bone IK');
{
  const S = { x: 0, y: 0 };
  let worst = 0;
  for (let i = 0; i < 200; i++) {
    const T = { x: Math.cos(i) * (40 + (i * 7) % 380), y: Math.sin(i * 1.7) * (40 + (i * 11) % 380) };
    const s = solveArm(S, T, 225, 195, i % 2 ? 1 : -1);
    worst = Math.max(worst, Math.abs(D(S, s.E) - s.a), Math.abs(D(s.E, s.W) - s.b));
    if (s.a > 225 * 1.121 || s.b > 195 * 1.121) worst = 999;
  }
  ok(worst < 0.01, 'upper and forearm keep their lengths for any target (stretch ≤ 12 %)', worst);
  const far = solveArm(S, { x: 0, y: 2000 }, 225, 195, 1);
  ok(Math.abs(D(S, far.W) - 420 * 1.12) < 1, 'an out-of-reach target clamps the wrist (no detaching)', D(S, far.W));
}

/* A synthetic performer in drawing pixels: shoulders 200 px apart around
   (360, 500), face above. Pose index 11 = your left shoulder, which the
   mirrored stage shows on the left. */
function performer({ lw, rw, le, re, hands = [], face = true }) {
  const P = new Array(33).fill(null).map(() => ({ x: 360, y: 500, z: 0, v: 0.1 }));
  const set = (i, x, y, v = 0.95) => { P[i] = { x, y, z: 0, v }; };
  set(11, 260, 500); set(12, 460, 500);
  if (le) set(13, le.x, le.y); if (re) set(14, re.x, re.y);
  if (lw) set(15, lw.x, lw.y); if (rw) set(16, rw.x, rw.y);
  const f = face ? { eyes: { x: 360, y: 340 }, mouth: { x: 360, y: 380 } } : null;
  return { P, hands, f };
}
function hand(wx, wy, dir = -1, spread = 1) { // an open hand, fingers along dir (−1 up)
  const h = [{ x: wx, y: wy, z: 0 }];
  const base = [[-14, 10], [-22, 22], [-26, 34], [-28, 44]];
  for (const [x, y] of base) h.push({ x: wx + x * spread, y: wy + dir * y, z: 0 });
  for (let f = 0; f < 4; f++) { const ox = (-18 + f * 12) * spread; for (let j = 0; j < 4; j++) h.push({ x: wx + ox, y: wy + dir * (40 + j * 16), z: 0 }); }
  return h;
}
const charFace = { eyes: man.talk.patches ? [360, 176] : [360, 176], mouth: [362, 244] };
const run = (fa, perf, t0, ms = 600, step = 16) => { for (let t = 0; t <= ms; t += step) fa.update(perf.P, perf.hands, perf.f, t0 + t); return fa.dbg; };

console.log('mapping');
{
  const fa = new FreeArms(rig, charFace);
  const up = performer({ lw: { x: 220, y: 300 }, rw: { x: 500, y: 300 }, le: { x: 210, y: 410 }, re: { x: 510, y: 410 },
    hands: [hand(220, 300), hand(500, 300)] });
  const d = run(fa, up, 0);
  ok(d.hands === 2, 'both hands are assigned to arms', d.hands);
  ok(d.L.W.y < rig.shoulders.L[1] - 80 && d.R.W.y < rig.shoulders.R[1] - 80, 'both hands up → both wrists well above the shoulders', [d.L.W, d.R.W]);
  ok(d.L.hand[12].y < d.L.W.y - 30 && d.R.hand[12].y < d.R.W.y - 30, 'fingers point up with the hands', [d.L.hand[12].y, d.L.W.y]);
  const S = rig.shoulders, k = d.k;
  const uL = D(d.L.E, { x: S.L[0], y: S.L[1] }), fL = D(d.L.E, d.L.W);
  ok(uL <= rig.upper + 1 && uL >= rig.upper * 0.4 - 1 && fL <= rig.fore * 1.12 + 1, 'the arm stays attached at the shoulder, never longer than its own lengths (+12 %)', [uL, fL, rig.upper, rig.fore]);
  ok(Math.abs(k - (S.R[0] - S.L[0]) / 200) < 0.05, 'one scale k = character shoulder width / yours', k);

  // mirror: only your right wrist (pose 16, stage right) up → the character's stage-right arm goes up
  const fa2 = new FreeArms(rig, charFace);
  const one = performer({ lw: { x: 250, y: 720 }, rw: { x: 500, y: 300 }, le: { x: 240, y: 610 }, re: { x: 510, y: 410 }, hands: [hand(500, 300)] });
  const d2 = run(fa2, one, 0);
  ok(d2.R.W.y < S.R[1] - 80 && d2.L.W.y > S.L[1] + 100, 'mirrored right: your stage-right hand raises the stage-right arm only', [d2.R.W.y, d2.L.W.y]);
  ok(d2.R.live && !d2.L.live, 'the hand landmarks went to the right arm', [d2.R.live, d2.L.live]);

  // heart: two hands whose finger tips touch at the chest stay touching
  const hl = hand(330, 470, -1, 0.8), hr = hand(390, 470, -1, 0.8);
  hl[8] = { x: 357, y: 420, z: 0 }; hr[8] = { x: 363, y: 420, z: 0 }; hl[4] = { x: 356, y: 500, z: 0 }; hr[4] = { x: 364, y: 500, z: 0 };
  const fa3 = new FreeArms(rig, charFace);
  const heart = performer({ lw: { x: 330, y: 470 }, rw: { x: 390, y: 470 }, le: { x: 250, y: 600 }, re: { x: 470, y: 600 }, hands: [hl, hr] });
  const d3 = run(fa3, heart, 0, 800);
  const tipGap = D(d3.L.hand[8], d3.R.hand[8]), thumbGap = D(d3.L.hand[4], d3.R.hand[4]);
  ok(tipGap < 8 * d3.k + 3 && thumbGap < 8 * d3.k + 3, 'heart: index tips and thumbs still meet on the character', { tipGap, thumbGap, k: d3.k });
  ok(d3.L.E.y > d3.L.W.y && d3.R.E.y > d3.R.W.y, 'heart: elbows hang below the hands (bend side read from your elbows)', [d3.L.E, d3.R.E]);
  // noisy pose wrists swapped (as when the hands meet): the arms must not cross
  const fa3b = new FreeArms(rig, charFace);
  const swapped = performer({ lw: { x: 392, y: 470 }, rw: { x: 328, y: 470 }, le: { x: 250, y: 600 }, re: { x: 470, y: 600 }, hands: [hr, hl] });
  const d3b = run(fa3b, swapped, 0, 800);
  ok(d3b.L.W.x < d3b.R.W.x && d3b.L.E.x < d3b.R.E.x, 'heart with swapped pose wrists: stage-left hand stays on the stage-left arm, elbows out (no crossed arms)', [d3b.L.W, d3b.R.W, d3b.L.E, d3b.R.E]);

  // hand at the face lands on the cartoon face (its head is bigger than yours)
  const fa4 = new FreeArms(rig, charFace);
  const hf = hand(360, 380, -1, 0.8);
  const cover = performer({ lw: { x: 250, y: 720 }, rw: { x: 360, y: 380 }, le: { x: 240, y: 610 }, re: { x: 470, y: 480 }, hands: [hf] });
  const d4 = run(fa4, cover, 0, 800);
  const palmC = d4.R.hand[9];
  ok(Math.abs(palmC.y - 210) < 70 && Math.abs(palmC.x - 361) < 70, 'a hand over your mouth/face covers the character\'s face', palmC);

  // drop-out: held for 300 ms, then eased down to rest
  const fa5 = new FreeArms(rig, charFace);
  run(fa5, up, 0, 600);
  const held = performer({ hands: [] }); held.P = null;
  fa5.update(null, [], null, 800); const a = fa5.dbg.R.W.y;
  fa5.update(null, [], null, 880); const b = fa5.dbg.R.W.y;
  for (let t = 900; t <= 2200; t += 16) fa5.update(null, [], null, t);
  const c = fa5.dbg.R.W.y;
  ok(a < rig.shoulders.R[1] && b < rig.shoulders.R[1], 'hands lost: the arm holds its last place for 300 ms', [a, b]);
  ok(c > rig.shoulders.R[1] + rig.upper, '…then eases down to rest', c);
}

/* ---------- the app in Chromium ---------- */
const { getChromium, routeMediapipe } = await import('./_rig.mjs');
const chromium = await getChromium();
const PORT = 8923;
const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(700);
const browser = await chromium.launch({ args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
await routeMediapipe(page);
const errors = []; page.on('pageerror', e => errors.push(String(e)));
await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__rangmanch && window.__rangmanch.packs.swapnil, null, { timeout: 30000 });
console.log('app');
{
  const v = await page.evaluate(() => window.__rangmanch.version);
  ok(v === '2.3.0', 'version 2.3.0', v);
  const r0 = await page.evaluate(async () => { const R = window.__rangmanch; await R.setLead('swapnil'); await new Promise(r => setTimeout(r, 400));
    return { draw: R.state.drawKey, toggle: !document.querySelector('#fa-wrap').hidden }; });
  ok(r0.draw !== 'free' && !r0.toggle, 'Swapnil keeps the pose system (no Free arms toggle)', r0);
  const r1 = await page.evaluate(async () => {
    const R = window.__rangmanch; await R.setLead('doodle-swapnil'); await new Promise(r => setTimeout(r, 600));
    return { draw: R.state.drawKey, toggle: !document.querySelector('#fa-wrap').hidden, checked: document.querySelector('#freearms').checked, arms: !!R.state.armsDbg };
  });
  ok(r1.draw === 'free' && r1.toggle && r1.checked && r1.arms, 'Doodle Swapnil: Free arms on by default, toggle shown', r1);
  // live: synthetic both-hands-up performer straight into the app (camera space)
  const r2 = await page.evaluate(async () => {
    const R = window.__rangmanch, asp = R.MAP.sw / R.MAP.sh;
    R.state.mode = 'camera'; R.state.testAspect = 4 / 3;
    const pose = new Array(33).fill(0).map(() => ({ x: 0.5, y: 0.9, z: 0, visibility: 0.2 }));
    const set = (i, x, y) => { pose[i] = { x, y, z: 0, visibility: 0.95 }; };
    // camera space (un-mirrored): your left shoulder (11) is at larger x
    set(11, 0.6, 0.62); set(12, 0.4, 0.62); set(13, 0.66, 0.5); set(14, 0.34, 0.5); set(15, 0.64, 0.33); set(16, 0.36, 0.33);
    set(0, 0.5, 0.36); set(2, 0.47, 0.33); set(5, 0.53, 0.33); set(23, 0.56, 1.2); set(24, 0.44, 1.2);
    R.raw.pose = pose; R.raw.face = { landmarks: R.synthFace({ x: 0.5, y: 0.38, w: 0.14, aspect: asp }), cats: { jawOpen: 0.6 } };
    R.raw.hands = [R.synthHand({ x: 0.64, y: 0.33, size: 0.05, aspect: asp }), R.synthHand({ x: 0.36, y: 0.33, size: 0.05, aspect: asp })];
    await new Promise(r => setTimeout(r, 1200));
    const a = R.state.armsDbg;
    return { draw: R.state.drawKey, hands: a.hands, L: a.L, R: a.R, mouth: R.state.mouthDbg, img: document.querySelector('#stage').toDataURL('image/jpeg', 0.8) };
  });
  fs.mkdirSync(path.join(ROOT, 'tests/shots'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'tests/shots/30-freearms-hands-up.jpg'), Buffer.from(r2.img.split(',')[1], 'base64'));
  ok(r2.draw === 'free' && r2.hands === 2, 'live: both hands drive the arms', { draw: r2.draw, hands: r2.hands });
  ok(r2.L.W[1] < r2.L.S[1] - 40 && r2.R.W[1] < r2.R.S[1] - 40, 'live: both hands up on stage', [r2.L.S, r2.L.W, r2.R.S, r2.R.W]);
  ok(r2.mouth === 'A', 'live: the mouth still talks with free arms', r2.mouth);
  const r3 = await page.evaluate(async () => {
    const R = window.__rangmanch, asp = R.MAP.sw / R.MAP.sh;
    R.raw.face = { landmarks: R.synthFace({ x: 0.5, y: 0.38, w: 0.14, aspect: asp, roll: 0.3 }), cats: {} };
    await new Promise(r => setTimeout(r, 1500));
    return { warp: R.state.warpOn, draw: R.state.drawKey };
  });
  ok(r3.warp && r3.draw === 'free', 'live: the head warp still follows a tilt with free arms', r3);
  const r4 = await page.evaluate(async () => {
    const R = window.__rangmanch; R.setFreeArms(false); await new Promise(r => setTimeout(r, 300));
    const off = { draw: R.state.drawKey, arms: R.state.armsDbg }; R.setFreeArms(true); await new Promise(r => setTimeout(r, 300));
    return { off, on: R.state.drawKey };
  });
  ok(r4.off.draw !== 'free' && r4.off.arms === null && r4.on === 'free', 'toggle off → the pose drawings again; on → free arms', r4);
  ok(errors.length === 0, 'no page errors', errors);
}
await browser.close();
server.kill();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
