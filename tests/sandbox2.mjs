#!/usr/bin/env node
/* Rangmanch AR — deep checks: real MediaPipe models with the fake camera,
   rig build timing on a fresh pack, and the mobile layout. */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getChromium, routeMediapipe } from './_rig.mjs';
const chromium = await getChromium();
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SHOTS = path.join(ROOT, 'tests', 'shots');
mkdirSync(SHOTS, { recursive: true });
const server = spawn('python3', ['-m', 'http.server', '8903'], { cwd: ROOT, stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(600);
const out = { errors: [], checks: {} };
// the sandbox VM routes egress through a proxy that curl honours via env but
// Chromium ignores — pass it explicitly so the real model CDNs are reachable
const pu = process.env.https_proxy ? new URL(process.env.https_proxy) : null;
const browser = await chromium.launch({
  proxy: pu ? { server: pu.protocol + '//' + pu.host, username: decodeURIComponent(pu.username), password: decodeURIComponent(pu.password), bypass: 'localhost,127.0.0.1' } : undefined,
  args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required']
});
const page = await browser.newPage({ viewport: { width: 1280, height: 950 } });
// sandbox proxy refuses CDN tunnels from Chromium (curl reaches them fine):
// serve the REAL MediaPipe bundle/WASM/models from a local mirror — same
// bytes, different transport — so the model pipeline itself is truly tested
await routeMediapipe(page);
page.on('console', m => { if (m.type() === 'error') out.errors.push(m.text().slice(0, 200)); });
page.on('pageerror', e => out.errors.push('pageerror: ' + String(e).slice(0, 200)));
await page.goto('http://localhost:8903/', { waitUntil: 'networkidle' }).catch(() => {});
await page.waitForFunction(() => window.__rangmanch && window.__rangmanch.packs.swapnil && window.__rangmanch.packs.swapnil.poses.wave, null, { timeout: 30000 }).catch(() => {});

// geometry scan time on a fresh pack (seema), measured inside the page
out.checks.geomMs = await page.evaluate(async () => {
  const p = await window.__rangmanch.ensurePack('seema');
  const t = performance.now();
  const g = window.__rangmanch.packGeom(p);
  return { ms: Math.round(performance.now() - t), built: !!(g && g.bbox) };
});

// real models + fake camera
await page.click('#btn-camera');
try {
  await page.waitForFunction(() => document.querySelector('#status-model').textContent.includes('live'), null, { timeout: 90000 });
  out.checks.modelsReady = true;
} catch (e) {
  out.checks.modelsReady = false;
  out.checks.modelStatus = await page.textContent('#status-model');
}
if (out.checks.modelsReady) {
  await sleep(3500); // let infer() run against the fake feed
  out.checks.cameraMode = await page.evaluate(() => window.__rangmanch.state.mode);
  out.checks.fpsCamera = await page.textContent('#fps');
  try {
    const box = await (await page.$('#stage')).boundingBox();
    await page.screenshot({ path: path.join(SHOTS, '20-fakecamera.png'), clip: box, timeout: 12000 });
    out.checks.fakecamShot = true;
  } catch (e) { out.checks.fakecamShot = false; } // headless GL starves capture; the checks above are the substance
}

// mobile layout
const mob = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await routeMediapipe(mob);
mob.on('pageerror', e => out.errors.push('mobile pageerror: ' + String(e).slice(0, 200)));
await mob.goto('http://localhost:8903/', { waitUntil: 'networkidle' }).catch(() => {});
await mob.waitForFunction(() => window.__rangmanch && window.__rangmanch.packs.swapnil && window.__rangmanch.packs.swapnil.poses.wave, null, { timeout: 30000 }).catch(() => {});
await mob.click('#btn-demo');
await sleep(2200);
await mob.screenshot({ path: path.join(SHOTS, '21-mobile.png'), fullPage: true });
out.checks.mobileDemo = await mob.evaluate(() => window.__rangmanch.state.mode);

console.log(JSON.stringify(out, null, 1));
await browser.close(); server.kill(); process.exit(0);
