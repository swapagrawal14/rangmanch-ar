#!/usr/bin/env node
/* Probe: which requests fail when the real models load? */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getChromium, routeMediapipe } from './_rig.mjs';
const chromium = await getChromium();
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
await routeMediapipe(page);
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
