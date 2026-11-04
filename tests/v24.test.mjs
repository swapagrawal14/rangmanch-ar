#!/usr/bin/env node
/* Rangmanch AR v2.4 tests — UI polish. Assert-based, exit code 1 on failure.
   Chromium at phone size (390x844): first-run card (what it does, camera
   explanation, privacy) shown once, settings panel, gesture hint, record →
   stop → save flow with an on-stage REC badge (DOM, never in the film), error
   cards for a refused camera and an unsupported browser, tap-target sizes and
   accessible names on every visible control, no horizontal overflow.
   Run: node tests/v24.test.mjs   (see tests/_rig.mjs for env options) */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getChromium, routeMediapipe } from './_rig.mjs';

const chromium = await getChromium();
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 8914;
const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(700);
const URL0 = `http://localhost:${PORT}/`;
let failed = 0, passed = 0;
const ok = (cond, name, detail) => {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
};
const FAKE = ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'];
const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const ready = page => page.waitForFunction(() => window.__rangmanch && window.__rangmanch.packs.swapnil, null, { timeout: 30000 });
/* every visible control: big enough to tap, and has a name a screen reader can say */
const controlsAudit = page => page.evaluate(() => {
  const bad = [], small = [];
  for (const el of document.querySelectorAll('button, a.btn, select, input, .chip-check')) {
    const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
    if (el.matches('input[type=checkbox]')) continue; // its label is the target
    const name = (el.getAttribute('aria-label') || el.textContent || (el.labels && el.labels[0] && el.labels[0].textContent) || el.placeholder || '').trim();
    if (!name) bad.push(el.id || el.className);
    const min = el.classList.contains('chip') ? 36 : 44;
    if (r.height < min - 0.5 || r.width < 40) small.push([el.id || el.className, Math.round(r.width), Math.round(r.height)]);
  }
  return { bad, small, docW: document.documentElement.scrollWidth };
});

const browser = await chromium.launch({ args: FAKE });

console.log('first-run card');
{
  const ctx = await browser.newContext(phone);
  const page = await ctx.newPage(); await routeMediapipe(page);
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.goto(URL0, { waitUntil: 'load' }); await ready(page); await sleep(400);
  ok(await page.evaluate(() => window.__rangmanch.version) === '2.4.0', 'version 2.4.0');
  ok(await page.isVisible('#intro'), 'first visit shows the intro card on the stage');
  const t = await page.textContent('#intro');
  ok(/camera/i.test(t) && /Nothing leaves your phone/i.test(t) && /Record/.test(t), 'intro explains what it does, the camera and privacy', t.slice(0, 120));
  ok(await page.isVisible('#btn-camera') && await page.isVisible('#btn-record'), 'console stays visible under the card');
  const box = await page.evaluate(() => { const c = document.querySelector('#intro').getBoundingClientRect(), s = document.querySelector('#stage').getBoundingClientRect(); return { c: [c.top, c.bottom], s: [s.top, s.bottom] }; });
  ok(box.c[0] >= box.s[0] - 20 && box.c[1] <= box.s[1] + 20, 'the card sits on the stage, not over the console', box);
  const a = await controlsAudit(page);
  ok(a.docW <= 390, 'no horizontal overflow at 390 px', a.docW);
  ok(a.bad.length === 0, 'every visible control has an accessible name', a.bad);
  ok(a.small.length === 0, 'tap targets ≥ 44 px (chips ≥ 36 px)', a.small);
  await page.click('#intro-demo'); await sleep(600);
  ok(await page.evaluate(() => window.__rangmanch.state.mode) === 'demo' && !(await page.isVisible('#intro')), '"Watch demo" closes the card and starts the demo');
  ok(await page.isVisible('#chip-cast') && await page.isVisible('#chip-moves'), 'character + moves chips show on stage');
  await page.reload({ waitUntil: 'load' }); await ready(page); await sleep(300);
  ok(!(await page.isVisible('#intro')), 'the intro is shown once (remembered on this device)');
  await page.click('#btn-help'); await sleep(200);
  ok(await page.isVisible('#intro'), 'the ? button brings it back');
  await page.click('#intro-close'); await sleep(200);
  ok(!(await page.isVisible('#intro')), '"Look around first" closes it');
  ok(errors.length === 0, 'no page errors', errors);
  await ctx.close();
}

console.log('settings, moves, picker');
{
  const ctx = await browser.newContext(phone);
  const page = await ctx.newPage(); await routeMediapipe(page);
  await page.goto(URL0, { waitUntil: 'load' }); await ready(page);
  await page.click('#intro-close');
  ok(!(await page.isVisible('#settings')), 'settings start folded away');
  await page.click('#btn-settings');
  ok(await page.isVisible('#settings') && await page.getAttribute('#btn-settings', 'aria-expanded') === 'true', 'gear opens the settings panel');
  ok(await page.isVisible('#quality') && await page.isVisible('#caption-input'), 'quality + caption live in settings');
  ok(await page.isVisible('#fa-none') && !(await page.isVisible('#fa-wrap')), 'Swapnil: Free arms explained as Doodle-Swapnil-only');
  await page.click('.lead-pick[data-id="doodle-swapnil"]');
  await page.waitForFunction(() => window.__rangmanch.packs['doodle-swapnil'] && !document.querySelector('#fa-wrap').hidden, null, { timeout: 20000 });
  ok(await page.isVisible('#fa-wrap') && await page.isChecked('#freearms') && !(await page.isVisible('#fa-none')), 'Doodle Swapnil: Free arms toggle shows, on');
  ok((await page.textContent('#chip-cast-name')).trim() === 'Doodle Swapnil', 'the stage chip names the lead');
  ok(/Doodle Swapnil/.test(await page.getAttribute('#stage', 'aria-label')), 'the stage has a label naming the lead');
  await page.click('#chip-moves');
  ok(await page.isVisible('#moves') && (await page.$$('#moves li')).length >= 10, 'Moves chip lists the gestures');
  await page.click('#moves');
  ok(!(await page.isVisible('#moves')), 'tapping the list closes it');
  await ctx.close();
}

console.log('record → stop → save');
{
  const ctx = await browser.newContext({ ...phone, acceptDownloads: true });
  const page = await ctx.newPage(); await routeMediapipe(page);
  await page.goto(URL0, { waitUntil: 'load' }); await ready(page);
  await page.click('#btn-demo'); await sleep(400);
  ok(!(await page.isVisible('#intro')), 'using the console directly dismisses the intro');
  ok(await page.evaluate(() => { const l = document.querySelector('.chip-check span'); return l.scrollWidth <= l.clientWidth + 1; }), 'the tools row fits on one line in demo (Co-actors not cut off)');
  await page.click('#btn-record'); await sleep(1500);
  ok(await page.isVisible('#rec-badge') && /REC 00:0\d/.test(await page.textContent('#rec-badge')), 'REC badge with a timer shows while recording');
  ok(/Stop/.test(await page.getAttribute('#btn-record', 'aria-label')), 'Record turns into Stop');
  await page.click('#btn-record');
  await page.waitForFunction(() => !document.querySelector('#download').hidden, null, { timeout: 10000 });
  ok(!(await page.isVisible('#rec-badge')), 'REC badge goes away after stopping');
  ok(/Save (MP4|WEBM)/.test(await page.getAttribute('#download', 'aria-label')), 'Save button names the file type', await page.getAttribute('#download', 'aria-label'));
  const row = await page.evaluate(() => [...document.querySelectorAll('.console-row.primary > *')].filter(e => e.getBoundingClientRect().width).map(e => { const r = e.getBoundingClientRect(); return [e.id, Math.round(r.left), Math.round(r.right), Math.round(r.top)]; }));
  ok(row.every(r => r[1] >= 0 && r[2] <= 390) && new Set(row.map(r => r[3])).size === 1, 'after a take, Camera / Again / Save fit one row on the phone', row);
  ok(await page.evaluate(() => document.documentElement.scrollWidth) <= 390, 'no horizontal overflow after a take');
  await ctx.close();
}
await browser.close();

console.log('camera refused');
{
  const b2 = await chromium.launch({ args: FAKE });
  const ctx = await b2.newContext(phone);
  // what Chrome/Safari raise when the user (or a site setting) blocks the camera
  await ctx.addInitScript(() => { navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError')); });
  const page = await ctx.newPage(); await routeMediapipe(page);
  await page.goto(URL0, { waitUntil: 'load' }); await ready(page);
  await page.click('#intro-camera'); await sleep(2500);
  ok(await page.isVisible('#stage-err'), 'a refused camera shows an error card');
  const t = await page.textContent('#stage-err');
  ok(/permission/i.test(await page.textContent('#err-title')) && /allow/i.test(t) && /Nothing is recorded|nothing is uploaded/i.test(t), 'it says the permission is off, how to allow it, and why it is safe', t.slice(0, 160));
  ok(/Try again/.test(await page.textContent('#err-retry')) && await page.isVisible('#err-retry'), 'Try again is offered');
  ok(await page.isVisible('#err-demo') && !(await page.isDisabled('#btn-camera')), 'demo offered; Start Camera can be tapped again');
  await page.click('#err-demo'); await sleep(400);
  ok(await page.evaluate(() => window.__rangmanch.state.mode) === 'demo' && !(await page.isVisible('#stage-err')), 'demo from the error card works');
  await b2.close();
}

console.log('unsupported browser');
{
  const b3 = await chromium.launch({ args: FAKE });
  const ctx = await b3.newContext(phone);
  await ctx.addInitScript(() => { Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true }); });
  const page = await ctx.newPage(); await routeMediapipe(page);
  await page.goto(URL0, { waitUntil: 'load' }); await ready(page); await sleep(300);
  ok(await page.isVisible('#stage-err') && /browser/i.test(await page.textContent('#err-title')), 'no camera API → "this browser can\'t open the camera" card');
  ok(await page.isDisabled('#btn-camera'), 'Start Camera is disabled there');
  await page.click('#err-demo'); await sleep(300);
  ok(await page.evaluate(() => window.__rangmanch.state.mode) === 'demo', 'the demo still plays');
  await b3.close();
}

server.kill();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
