#!/usr/bin/env node
/* Dump one pack's rig pieces (erased underlayer, head, strips) as PNGs. */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
let chromium;
try { ({ chromium } = await import('playwright-core')); }
catch (e) { const req = createRequire('/home/hatch/workspace/tools/testrig/package.json'); ({ chromium } = req('playwright-core')); }
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, 'tests', 'shots', 'rigdump');
mkdirSync(OUT, { recursive: true });
const id = process.argv[2] || 'sanjay';
const server = spawn('python3', ['-m', 'http.server', '8902'], { cwd: ROOT, stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(600);
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.goto('http://localhost:8902/', { waitUntil: 'networkidle' }).catch(() => {});
await page.waitForFunction(i => window.__rangmanch && window.__rangmanch.packs[i], id, { timeout: 20000 });
await page.evaluate(async i => { const p = await window.__rangmanch.ensurePack(i); await window.__rangmanch.buildRigAsync(p); }, id);
await page.waitForFunction(i => window.__rangmanch.packs[i].rig || window.__rangmanch.packs[i].rigFailed, id, { timeout: 30000 });
const dump = await page.evaluate(i => {
  const p = window.__rangmanch.packs[i];
  if (!p.rig) return { failed: true };
  const url = c => c.toDataURL('image/png');
  const J = p.rig.J, r = a => a.map(v => Math.round(v));
  return {
    failed: false, W: p.rig.W, H: p.rig.H, bbox: p.rig.bbox,
    J: { shoR: r(J.shoR), elbR: r(J.elbR), wriR: r(J.wriR), shoL: r(J.shoL), elbL: r(J.elbL), wriL: r(J.wriL), neck: r(J.neck), faceCx: Math.round(J.faceCx), faceW: Math.round(J.faceW), headH: Math.round(J.headH), chin: Math.round(J.chin), headBox: J.headBox.map(Math.round) },
    erased: url(p.rig.erased), head: url(p.rig.head.img),
    strips: Object.fromEntries(Object.entries(p.rig.strips).map(([k, s]) => [k, url(s.img)]))
  };
}, id);
console.log(JSON.stringify({ failed: dump.failed, W: dump.W, H: dump.H, bbox: dump.bbox, J: dump.J }, null, 1));
if (!dump.failed) {
  const save = (name, data) => writeFileSync(path.join(OUT, `${id}-${name}.png`), Buffer.from(data.split(',')[1], 'base64'));
  save('erased', dump.erased); save('head', dump.head);
  for (const [k, v] of Object.entries(dump.strips)) save('strip-' + k, v);
  // composite: erased + head at rest position, on dark bg
  const comp = await page.evaluate(i => {
    const p = window.__rangmanch.packs[i], rig = p.rig;
    const c = document.createElement('canvas'); c.width = rig.W; c.height = rig.H;
    const x = c.getContext('2d');
    x.fillStyle = '#40202c'; x.fillRect(0, 0, rig.W, rig.H);
    x.drawImage(rig.erased, 0, 0);
    x.drawImage(rig.head.img, rig.head.box[0], rig.head.box[1]);
    for (const s of Object.values(rig.strips)) x.drawImage(s.img, s.box[0], s.box[1]);
    return c.toDataURL('image/png');
  }, id);
  save('rest-composite', comp);
}
await browser.close(); server.kill(); process.exit(0);
