#!/usr/bin/env node
/* Rangmanch AR v2.2 tests — assert-based, exit code 1 on failure.
   Part 1 runs the pure modules in Node: the hand + face gesture classifier
   on synthetic landmark fixtures (tests/fixtures.mjs), the head tracker
   (tilt / turn / nod / shake) and the head warp (identity, pivot, no fold,
   no seam, 2.5D parallax).
   Part 2 drives the real app in Chromium at 390x844: light first load, lazy
   v2.2 art, the new poses on stage with the right face tiles, fallbacks for
   characters without the art, the two-frame wave, the head following, and
   no flicker.
   Run: node tests/v22.test.mjs   (see tests/_rig.mjs for env options) */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyHandsFace, makeGestureMemory, handInfo } from '../gestures.js';
import { HeadTracker, rawHeadAngles, warpPoint, swings } from '../headwarp.js';
import { synthFace, synthHand } from '../synth.js';
import { fixture, px, toPx, STAGE } from './fixtures.mjs';

let failed = 0, passed = 0;
const ok = (cond, name, detail) => {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
};
const run = (f, cur = 'base', mem = makeGestureMemory(), now = 1000) =>
  classifyHandsFace({ hands: f.hands.map(px), face: f.face ? px(f.face) : null, cur, now, mem, stageW: STAGE.W });

/* ---------- 1. hand shapes ---------- */
console.log('hand shapes');
{
  const s = shape => handInfo(synthHand({ shape, angle: shape === 'point' || shape === 'thumbs' ? -Math.PI / 2 : 0 }).map(toPx));
  ok(s('open').open && !s('open').fist, 'open hand reads open');
  ok(s('fist').fist && !s('fist').open, 'closed hand reads fist');
  ok(s('point').pointing && !s('point').open, 'index only reads pointing');
  ok(s('thumbs').thumbsUp && !s('thumbs').fist, 'thumb up, fingers curled reads thumbs-up');
}

/* ---------- 2. gesture classifier on fixtures ---------- */
console.log('gesture classifier (synthetic landmark fixtures)');
{
  const expect = { mouth: 'mouth', shh: 'shh', think: 'think', 'think-cheek': 'think', facepalm: 'facepalm', salute: 'salute',
    cover: 'cover', head: 'head', namaste: 'namaste', fist: 'fist', thumbs: 'thumbs', point: 'point', palm: 'palm' };
  for (const [fx, want] of Object.entries(expect)) {
    const near = run(fixture(fx, 1)), far = run(fixture(fx, 0.55));
    ok(near && near.name === want, `${fx} → ${want}`, near);
    ok(far && far.name === want, `${fx} → ${want} at half the distance-scale (thresholds in face widths)`, far);
  }
  ok(run(fixture('rest')) === null, 'hands down at the waist → no gesture', run(fixture('rest')));
  ok(run(fixture('none')) === null, 'no hands → no hand gesture');
  ok(run(fixture('apart')) === null, 'two hands apart (not touching) → no namaste', run(fixture('apart')));
  // the gesturing side follows the hand: the same gesture with the other hand mirrors
  const m = fixture('mouth'), mm = { face: m.face, hands: m.hands.map(h => h.map(p => ({ x: 1 - p.x + 0, y: p.y, z: 0 }))) };
  const a = run(m), b = run(mm);
  ok(a && b && a.name === 'mouth' && b.name === 'mouth' && a.side !== b.side, 'hand on mouth with the other hand flips the side (drawing mirrors)', [a, b]);
  // spatial hysteresis: a hand drifting just off the mouth keeps the pose once it is on
  const drift = fixture('mouth'); drift.hands[0] = drift.hands[0].map(p => ({ x: p.x - 0.07, y: p.y, z: 0 }));
  const off = run(drift, 'base'), keep = run(drift, 'mouth');
  ok((!off || off.name !== 'mouth') && keep && keep.name === 'mouth', 'near the edge: not entered from base, but held once on (no flicker)', [off && off.name, keep && keep.name]);
  // clap: hands meet, part, meet again within 1.5 s
  const mem = makeGestureMemory(); let got = [];
  const seq = ['apart', 'namaste', 'apart', 'namaste', 'apart'];
  seq.forEach((fx, i) => { const r = run(fixture(fx), 'base', mem, 1000 + i * 220); got.push(r && r.name); });
  ok(got.slice(3).includes('clap'), 'meet-part-meet within 1.5 s → clap', got);
  const mem2 = makeGestureMemory(); const held = [];
  for (let i = 0; i < 6; i++) { const r = run(fixture('namaste'), 'base', mem2, 1000 + i * 220); held.push(r && r.name); }
  ok(held.every(n => n === 'namaste'), 'palms held together → namaste, not clap', held);
  // waving palm: the open hand swings left-right
  const mem3 = makeGestureMemory(); let last = null;
  for (let i = 0; i < 14; i++) {
    const f = fixture('palm'); const dx = Math.sin(i * 1.4) * 0.05;
    f.hands[0] = f.hands[0].map(p => ({ x: p.x + dx, y: p.y, z: 0 }));
    last = run(f, 'base', mem3, 1000 + i * 60);
  }
  ok(last && last.name === 'wave', 'a swinging open palm → wave', last);
}

/* ---------- 3. head tracker ---------- */
console.log('head tracker');
{
  const A = 4 / 3;
  const ang = o => rawHeadAngles(px(synthFace({ x: 0.5, y: 0.3, w: 0.2, aspect: A, ...o })));
  const r0 = ang({}), rr = ang({ roll: 0.3 }), ry = ang({ yaw: 0.6 }), ryr = ang({ yaw: 0.6, roll: 0.3 });
  ok(Math.abs(r0.roll) < 0.01 && Math.abs(r0.yaw) < 0.02, 'frontal face → no tilt, no turn', r0);
  ok(Math.abs(Math.abs(rr.roll) - 0.3) < 0.03, 'a 0.3 rad tilt reads as 0.3 rad', rr.roll);
  ok(rr.roll < 0, 'tilt is mirrored like a selfie (camera-clockwise reads stage-anticlockwise)', rr.roll);
  ok(ry.yaw < -0.3, 'turning reads as yaw, mirrored to the stage', ry.yaw);
  ok(Math.abs(ryr.yaw - ry.yaw) < 0.05, 'yaw is measured in the head frame (a tilt does not leak into the turn)', [ry.yaw, ryr.yaw]);
  // smoothing without lag: a step to 0.3 rad is followed within ~150 ms
  const T = new HeadTracker(); let t = 0;
  for (; t < 500; t += 33) T.update(px(synthFace({ w: 0.2, aspect: A })), t);
  let reach = null;
  for (let i = 0; i < 20; i++, t += 33) { T.update(px(synthFace({ w: 0.2, aspect: A, roll: 0.3 })), t); if (reach === null && Math.abs(T.roll) > 0.24) reach = i * 33; }
  ok(reach !== null && reach <= 170, 'a sudden tilt is followed within ~150 ms (One Euro: no lag)', reach);
  // jitter when still is damped
  const T2 = new HeadTracker(); const vals = [];
  for (let i = 0; i < 60; i++) { T2.update(px(synthFace({ w: 0.2, aspect: A, roll: (i % 2 ? 1 : -1) * 0.01 })), i * 33); if (i > 20) vals.push(T2.roll); }
  ok(Math.max(...vals) - Math.min(...vals) < 0.012, 'tracking jitter when still is damped', Math.max(...vals) - Math.min(...vals));
  // nod and shake
  const gestOf = (axis, amp, hz) => {
    const Tn = new HeadTracker(); let g = null;
    for (let i = 0; i < 20; i++) Tn.update(px(synthFace({ w: 0.2, aspect: A })), i * 33);
    for (let i = 0; i < 40; i++) {
      const v = Math.sin(i * 33 / 1000 * 2 * Math.PI * hz) * amp;
      Tn.update(px(synthFace({ w: 0.2, aspect: A, [axis]: v })), 660 + i * 33);
      g = Tn.params().gest || g;
    }
    return g;
  };
  ok(gestOf('pitch', 0.35, 2.2) === 'nod', 'a nod is detected', gestOf('pitch', 0.35, 2.2));
  ok(gestOf('yaw', 0.5, 2.2) === 'shake', 'a head shake is detected', gestOf('yaw', 0.5, 2.2));
  ok(gestOf('roll', 0.2, 0.4) === null, 'a slow tilt is neither a nod nor a shake', gestOf('roll', 0.2, 0.4));
  const T3 = new HeadTracker(); for (let i = 0; i < 20; i++) T3.update(px(synthFace({ w: 0.2, aspect: A })), i * 33);
  for (let i = 0; i < 30; i++) T3.update(px(synthFace({ w: 0.2, aspect: A, pitch: Math.sin(i * 0.48) * 0.35 })), 660 + i * 33);
  ok(Math.abs(T3.params().pitch) <= 1 && T3.params().gest === 'nod', 'a detected nod is exaggerated, but clamped', T3.params());
  ok(swings([{ v: 0 }, { v: 1 }].map(o => ({ p: o.v })), 'p', 0.5) === 0, 'one movement is not a swing');
}

/* ---------- 4. head warp ---------- */
console.log('head warp');
{
  const H = { c: [360, 180], r: [100, 140], pivot: [360, 340] };
  const same = (a, b, e = 0.01) => Math.hypot(a[0] - b[0], a[1] - b[1]) < e;
  const z = { roll: 0, yaw: 0, pitch: 0 };
  ok([[360, 60], [300, 200], [600, 800]].every(p => same(warpPoint(p, H, z), p)), 'zero head motion → identity');
  const k = { roll: 0.35, yaw: 0.9, pitch: -0.8 };
  ok([[360, 560], [100, 700], [620, 900], [360, 935]].every(p => same(warpPoint(p, H, k), p)), 'shoulders and body never move (the warp is head-only)');
  const top = warpPoint([360, 40], H, { roll: 0.3, yaw: 0, pitch: 0 });
  const a = Math.atan2(top[0] - 360, 340 - top[1]);
  ok(Math.abs(a - 0.3) < 0.04, 'a tilt rotates the head about the neck pivot', a);
  ok(same(warpPoint(H.pivot, H, { roll: 0.3, yaw: 0, pitch: 0 }), H.pivot, 0.5), 'the neck pivot stays put');
  // 2.5D: the face centre slides further than the head outline when turning
  const fc = warpPoint([360, 190], H, { roll: 0, yaw: 0.8, pitch: 0 })[0] - 360;
  const edge = warpPoint([360 + 100, 190], H, { roll: 0, yaw: 0.8, pitch: 0 })[0] - 460;
  ok(fc > edge * 1.5 && fc > 8, 'turning slides the features more than the outline (2.5D read)', [fc, edge]);
  const nod = warpPoint([360, 210], H, { roll: 0, yaw: 0, pitch: 0.9 })[1] - 210;
  ok(nod > 10, 'a nod moves the face down', nod);
  // no fold, no seam: positive Jacobian and small neighbour differences over the whole drawing
  let minJ = 1e9, maxStep = 0;
  for (const kk of [k, { roll: -0.45, yaw: -1, pitch: 1 }, { roll: 0.45, yaw: 1, pitch: 1 }, { roll: 0.45, yaw: -1, pitch: -1 }]) {
    for (let y = -90; y < 1026; y += 6) for (let x = -90; x < 810; x += 6) {
      const p = warpPoint([x, y], H, kk), px1 = warpPoint([x + 1, y], H, kk), py1 = warpPoint([x, y + 1], H, kk);
      const J = (px1[0] - p[0]) * (py1[1] - p[1]) - (px1[1] - p[1]) * (py1[0] - p[0]);
      minJ = Math.min(minJ, J); maxStep = Math.max(maxStep, Math.hypot(px1[0] - p[0], px1[1] - p[1]), Math.hypot(py1[0] - p[0], py1[1] - p[1]));
    }
  }
  ok(minJ > 0.05, 'the warp never folds over itself at the extremes (Jacobian > 0)', minJ);
  ok(maxStep < 2.4, 'neighbouring pixels stay neighbours (no tear, no seam)', maxStep);
}

/* ---------- 5. the app in Chromium ---------- */
const { getChromium, routeMediapipe } = await import('./_rig.mjs');
const chromium = await getChromium();
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 8912;
const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(700);
const URL0 = `http://localhost:${PORT}/`;
const browser = await chromium.launch({ args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const LEADS = ['doodle-swapnil', 'bunty', 'swapnil', 'sanjay'];
const NEW = ['wave2', 'mouth', 'think', 'head', 'cover', 'namaste', 'clap', 'salute', 'shh', 'facepalm', 'fist'];

console.log('first load + lazy v2.2 art');
{
  const ctx = await browser.newContext(phone);
  const page = await ctx.newPage();
  await routeMediapipe(page);
  const v22 = []; const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('request', r => { if (r.url().includes('/talk/v22/')) v22.push(r.url()); });
  await page.goto(URL0, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__rangmanch && window.__rangmanch.packs.swapnil && window.__rangmanch.packs.swapnil.poses.wave, null, { timeout: 30000 });
  await sleep(800);
  ok(errors.length === 0, 'no page errors', errors);
  ok(v22.length === 0, 'no v2.2 gesture art is fetched on first load', v22.length);
  await page.click('#btn-demo');
  await page.waitForFunction(() => window.__rangmanch.packs.swapnil.extraLoading, null, { timeout: 5000 });
  await page.evaluate(() => window.__rangmanch.packs.swapnil.extraLoading);
  const got = await page.evaluate(() => Object.keys(window.__rangmanch.packs.swapnil.poses));
  ok(NEW.every(k => got.includes(k)), 'going live fetches the lead\'s v2.2 drawings', got);
  ok(v22.every(u => u.includes('/swapnil/')), 'only the lead\'s v2.2 art is fetched', v22.filter(u => !u.includes('/swapnil/')));
  const dims = await page.evaluate(async (leads) => {
    const R = window.__rangmanch, out = {};
    for (const id of leads) { const p = await R.ensurePack(id, true); await R.loadExtraPoses(p); await p.posesLoading;
      out[id] = Object.fromEntries(Object.entries(p.poses).map(([k, i]) => [k, [i.naturalWidth, i.naturalHeight]])); }
    return out;
  }, LEADS);
  ok(LEADS.every(id => NEW.every(k => dims[id][k] && dims[id][k][0] === 720 && dims[id][k][1] === 936)), 'all new drawings exist for the 4 leads, on the pack canvas (720x936)', dims);
  await ctx.close();
}

console.log('new poses on stage');
{
  const ctx = await browser.newContext(phone);
  const page = await ctx.newPage();
  await routeMediapipe(page);
  await page.goto(URL0, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__rangmanch && window.__rangmanch.packs.swapnil, null, { timeout: 30000 });
  // the harness feeds camera-space landmarks straight into the app (no models)
  await page.exposeFunction('__fixture', (name, s) => fixture(name, s));
  const perform = async (lead, name, ms = 1100, cats = {}) => page.evaluate(async ([lead, name, ms, cats]) => {
    const R = window.__rangmanch;
    if (R.cast.lead !== lead) { await R.setLead(lead); }
    R.setFreeArms(false); // v2.3: these checks are about the drawn poses (Doodle Swapnil defaults to Free arms)
    R.state.mode = 'camera'; R.state.testAspect = 4 / 3;
    const p = R.packs[lead]; await R.loadExtraPoses(p); await p.posesLoading;
    const f = await window.__fixture(name, 1);
    R.raw.pose = null; R.raw.face = { landmarks: f.face, cats }; R.raw.hands = f.hands;
    await new Promise(r => setTimeout(r, ms));
    const s = R.state;
    return { pose: s.poseName, draw: s.drawKey, side: s.poseSide, mouth: s.mouthDbg };
  }, [lead, name, ms, cats]);
  const want = { mouth: 'mouth', shh: 'shh', think: 'think', facepalm: 'facepalm', salute: 'salute', cover: 'cover', head: 'head', namaste: 'namaste', fist: 'fist' };
  for (const lead of LEADS) {
    const res = {};
    for (const [fx, w] of Object.entries(want)) { await perform(lead, 'none', 900); res[fx] = await perform(lead, fx); }
    ok(Object.entries(want).every(([fx, w]) => res[fx].draw === w), `${lead}: every new gesture performs its own drawing`, Object.fromEntries(Object.entries(res).map(([k, v]) => [k, v.draw])));
  }
  // a hand over the mouth never gets a talking mouth painted over it
  await perform('swapnil', 'none', 900);
  const talk = await perform('swapnil', 'mouth', 1100, { jawOpen: 0.6 });
  ok(talk.draw === 'mouth' && talk.mouth === null, 'hand on mouth + talking: no mouth tile over the hand', talk);
  const talk2 = await perform('swapnil', 'namaste', 1100, { jawOpen: 0.6 });
  ok(talk2.draw === 'namaste' && talk2.mouth === 'A', 'namaste + talking: the mouth still talks', talk2);
  // a character without the new art falls back to its nearest drawing
  await perform('mira', 'none', 900);
  const fb = await perform('mira', 'mouth', 1100);
  ok(fb.pose === 'mouth' && fb.draw === 'base' && fb.mouth === 'O', 'mira (no v2.2 art): hand on mouth → base drawing with the gasp O-mouth', fb);
  await perform('mira', 'none', 900);
  const fb2 = await perform('mira', 'fist', 1100);
  ok(fb2.draw === 'thumbs', 'mira: fist → her thumbs-up drawing (nearest)', fb2);
  // hysteresis in time: a 120 ms hand blip does not switch the pose
  await perform('bunty', 'none', 900);
  const blip = await page.evaluate(async () => {
    const R = window.__rangmanch, f = await window.__fixture('mouth', 1), seen = new Set();
    // a wall-clock 120 ms (a frame loop overshoots it on a loaded test machine)
    R.raw.hands = f.hands; await new Promise(r => setTimeout(r, 120));
    R.raw.hands = [];
    const t1 = performance.now();
    while (performance.now() - t1 < 900) { seen.add(R.state.drawKey); await new Promise(r => requestAnimationFrame(r)); }
    return [...seen];
  });
  ok(blip.length === 1 && blip[0] === 'base', 'a 120 ms hand blip does not flicker a pose on', blip);
  await ctx.close();
}

console.log('wave: two drawn frames that follow the hand');
{
  const ctx = await browser.newContext(phone);
  const page = await ctx.newPage();
  await routeMediapipe(page);
  await page.goto(URL0, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__rangmanch && window.__rangmanch.packs.swapnil, null, { timeout: 30000 });
  await page.exposeFunction('__fixture', (name, s) => fixture(name, s));
  const res = await page.evaluate(async () => {
    const R = window.__rangmanch; await R.setLead('doodle-swapnil'); R.setFreeArms(false); R.state.mode = 'camera'; R.state.testAspect = 4 / 3;
    const p = R.packs['doodle-swapnil']; await R.loadExtraPoses(p);
    const f = await window.__fixture('palm', 1); const base = f.hands[0];
    R.raw.pose = null; R.raw.face = { landmarks: f.face, cats: {} };
    const keys = [], flips = []; let last = null; const t0 = performance.now();
    while (performance.now() - t0 < 4000) {
      const t = (performance.now() - t0) / 1000, dx = Math.sin(t * 2 * Math.PI * 1.6) * 0.05;
      R.raw.hands = [base.map(q => ({ x: q.x + dx, y: q.y, z: 0 }))];
      await new Promise(r => setTimeout(r, 15));
      const k = R.state.drawKey; keys.push(k);
      if (k !== last) { flips.push(performance.now()); last = k; }
    }
    // then hold the palm still
    R.raw.hands = [base]; await new Promise(r => setTimeout(r, 1200));
    const still = R.state.drawKey;
    const gaps = flips.slice(2).map((t, i) => t - flips[i + 1]);
    return { wave: keys.filter(k => k === 'wave').length, wave2: keys.filter(k => k === 'wave2').length, other: keys.filter(k => k !== 'wave' && k !== 'wave2').length, minGap: Math.min(...gaps), nFlips: flips.length, still };
  });
  ok(res.wave > 5 && res.wave2 > 5, 'a waving hand alternates the two drawn wave frames', res);
  ok(res.nFlips >= 6, 'the frames cut in time with the hand (several cuts in 4 s)', res.nFlips);
  ok(res.minGap >= 85, 'never faster than every ~90 ms (no flicker)', res.minGap);
  ok(res.still === 'wave', 'a held open palm stays on the first wave drawing', res.still);
  await ctx.close();
}

console.log('head follows on stage');
{
  const ctx = await browser.newContext(phone);
  const page = await ctx.newPage();
  await routeMediapipe(page);
  await page.goto(URL0, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__rangmanch && window.__rangmanch.packs.swapnil, null, { timeout: 30000 });
  const r = await page.evaluate(async () => {
    const R = window.__rangmanch; await R.setLead('doodle-swapnil'); R.state.mode = 'camera'; R.raw.pose = null; R.raw.hands = [];
    const asp = R.MAP.sw / R.MAP.sh, sl = ms => new Promise(r => setTimeout(r, ms));
    const face = o => ({ landmarks: R.synthFace({ x: 0.5, y: 0.3, w: 0.2, aspect: asp, ...o }), cats: {} });
    R.raw.face = face({}); await sl(900);
    const a = { warp: R.state.warpOn, f: R.state.faceDbg };
    R.raw.face = face({ roll: 0.3 }); await sl(1500);
    const b = { warp: R.state.warpOn, fw: R.state.faceWarpDbg, f: R.state.faceDbg, head: R.state.head, gl: !!(R.headGL && R.headGL.ok) };
    R.raw.face = face({ yaw: 0.7 }); await sl(1500);
    const c = { fw: R.state.faceWarpDbg, f: R.state.faceDbg, yaw: R.state.head.yaw };
    // hand on the face: the head stops warping (the hand would bend with it)
    R.raw.face = face({ roll: 0.3 }); await sl(400);
    return { a, b, c };
  });
  ok(r.b.gl, 'WebGL head warp is available');
  ok(!r.a.warp && r.b.warp, 'a still head draws plain; a tilted head switches the warp on', [r.a.warp, r.b.warp]);
  ok(r.b.fw && r.b.f && Math.abs(r.b.fw[0] - r.b.f[0]) > 6, 'tilting moves the character\'s face sideways about the neck', r.b);
  ok(r.c.fw && r.c.f && (r.c.fw[0] - r.c.f[0]) * Math.sign(r.c.yaw) > 4, 'turning slides the face toward the turn', r.c);
  await ctx.close();
}

await browser.close();
server.kill();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
