#!/usr/bin/env node
/* Probe: which requests fail when the real models load? */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
let chromium;
try { ({ chromium } = await import('playwright-core')); }
catch (e) { const req = createRequire('/home/hatch/workspace/tools/testrig/package.json'); ({ chromium } = req('playwright-core')); }
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const server = spawn('python3', ['-m', 'http.server', '8904'], { cwd: ROOT, stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(600);
const pu = process.env.https_proxy ? new URL(process.env.https_proxy) : null;
const browser = await chromium.launch({
  proxy: pu ? { server: pu.protocol + '//' + pu.host, username: decodeURIComponent(pu.username), password: decodeURIComponent(pu.password), bypass: 'localhost,127.0.0.1' } : undefined,
  args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']
});
const page = await browser.newPage();
// The sandbox proxy refuses the CDN tunnels from Chromium (curl reaches them
// fine). Serve the REAL bundle/WASM/models from the local mirror instead —
// same bytes, different transport — so the model pipeline itself is tested.
const MIRROR = '/home/hatch/workspace/tools/testrig/mp-mirror';
const { readFileSync } = await import('node:fs');
await page.route('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/**', route => {
  const u = route.request().url();
  try {
    if (u.endsWith('vision_bundle.mjs')) return route.fulfill({ contentType: 'text/javascript', body: readFileSync(MIRROR + '/vision_bundle.mjs') });
    const w = u.match(/wasm\/(.+)$/);
    if (w) return route.fulfill({ contentType: u.endsWith('.wasm') ? 'application/wasm' : 'text/javascript', body: readFileSync(MIRROR + '/wasm/' + w[1]) });
  } catch (e) { /* fall through */ }
  return route.continue();
});
await page.route('https://storage.googleapis.com/mediapipe-models/**', route => {
  const u = route.request().url();
  const f = u.includes('pose_landmarker') ? 'pose.task' : u.includes('hand_landmarker') ? 'hand.task' : 'face.task';
  return route.fulfill({ contentType: 'application/octet-stream', body: readFileSync(MIRROR + '/models/' + f) });
});
page.on('requestfailed', r => console.log('FAILED ', r.failure()?.errorText, r.url().slice(0, 130)));
page.on('response', r => { if (r.status() >= 400) console.log('HTTP', r.status(), r.url().slice(0, 130)); });
page.on('console', m => console.log('console.' + m.type() + ':', m.text().slice(0, 200)));
page.on('pageerror', e => console.log('pageerror:', String(e).slice(0, 300)));
await page.goto('http://localhost:8904/', { waitUntil: 'networkidle' }).catch(() => {});
await page.waitForFunction(() => window.__rangmanch && window.__rangmanch.packs.swapnil, null, { timeout: 20000 }).catch(() => {});
await page.click('#btn-camera');
await sleep(45000);
console.log('status:', await page.textContent('#status-model'));
await browser.close(); server.kill(); process.exit(0);
