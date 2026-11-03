/* Shared test rig: finds playwright-core and (optionally) serves the real
   MediaPipe bundle / WASM / models from a local mirror with the CDN's own
   path layout — same bytes, local transport (sandboxes often block the CDN
   for Chromium). Env:
     PLAYWRIGHT_CORE_DIR  a folder whose node_modules has playwright-core
     MP_MIRROR            mirror root: vision_bundle.mjs, wasm/*, models/<CDN path> */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

export async function getChromium() {
  try { return (await import('playwright-core')).chromium; } catch (e) { /* try the env path */ }
  const dir = process.env.PLAYWRIGHT_CORE_DIR || '/workspace/work/testrig';
  return createRequire(path.join(dir, 'package.json'))('playwright-core').chromium;
}
export const MIRROR = process.env.MP_MIRROR || (fs.existsSync('/workspace/work/testrig/mp') ? '/workspace/work/testrig/mp' : null);
export async function routeMediapipe(page) {
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ status: 200, body: '', contentType: 'text/css' }));
  if (!MIRROR) return false;
  await page.route(/cdn\.jsdelivr\.net\/npm\/@mediapipe\/tasks-vision@[^/]+\/(.*)$/, r => {
    const rel = r.request().url().replace(/^.*tasks-vision@[^/]+\//, '').split('?')[0];
    const f = path.join(MIRROR, rel);
    if (!fs.existsSync(f)) return r.continue();
    r.fulfill({ status: 200, body: fs.readFileSync(f), contentType: rel.endsWith('.wasm') ? 'application/wasm' : 'text/javascript', headers: { 'access-control-allow-origin': '*' } });
  });
  await page.route(/storage\.googleapis\.com\/mediapipe-models\/(.*)$/, r => {
    const rel = r.request().url().replace(/^.*mediapipe-models\//, '').split('?')[0];
    const f = path.join(MIRROR, 'models', rel);
    if (!fs.existsSync(f)) return r.continue();
    const body = fs.readFileSync(f);
    r.fulfill({ status: 200, body, headers: { 'access-control-allow-origin': '*', 'content-length': String(body.length) } });
  });
  return true;
}
