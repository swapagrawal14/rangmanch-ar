#!/usr/bin/env node
/* Probe the arm skin-scan for one pack, inside the page. */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
let chromium;
try { ({ chromium } = await import('playwright-core')); }
catch (e) { const req = createRequire('/home/hatch/workspace/tools/testrig/package.json'); ({ chromium } = req('playwright-core')); }
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const id = process.argv[2] || 'seema';
const server = spawn('python3', ['-m', 'http.server', '8905'], { cwd: ROOT, stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(600);
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.goto('http://localhost:8905/', { waitUntil: 'networkidle' }).catch(() => {});
await page.waitForFunction(i => window.__rangmanch && window.__rangmanch.packs[i], id, { timeout: 20000 });
const out = await page.evaluate(i => {
  const p = window.__rangmanch.packs[i], img = p.img.base;
  const W = img.naturalWidth, H = img.naturalHeight;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x2 = c.getContext('2d', { willReadFrequently: true });
  x2.drawImage(img, 0, 0);
  const data = x2.getImageData(0, 0, W, H).data;
  const isSkin = i2 => data[i2 + 3] > 60 && data[i2] > 120 &&
    (data[i2] - data[i2 + 2]) >= 5 && (data[i2] - data[i2 + 2]) <= 120 &&
    (data[i2] - data[i2 + 1]) >= -5 && (data[i2] - data[i2 + 1]) <= 75 &&
    data[i2 + 1] > data[i2 + 2] + 5;
  const patches = p.manifest.talk.patches;
  const faceCx = patches.blink.x + patches.blink.w / 2, faceW = patches.blink.w * 1.55;
  const res = {};
  for (const side of [-1, 1]) {
    const xa = Math.round(faceCx + side * faceW * 0.40), xb = Math.round(faceCx + side * faceW * 1.75);
    const lo = Math.max(0, Math.min(xa, xb)), hi = Math.min(W - 1, Math.max(xa, xb));
    const rows = [];
    for (let y = 322; y < 850; y += 8) {
      let sum = 0, cnt = 0;
      for (let x = lo; x <= hi; x++) if (isSkin((y * W + x) * 4)) { sum += x; cnt++; }
      rows.push([y, cnt, cnt ? Math.round(sum / cnt) : null]);
    }
    res[side] = { band: [lo, hi], rows };
  }
  return res;
}, id);
for (const [side, r] of Object.entries(out)) {
  console.log('side', side, 'band', r.band);
  console.log(r.rows.map(q => `${q[0]}:${q[1]}@${q[2]}`).join('  '));
}
await browser.close(); server.kill(); process.exit(0);
