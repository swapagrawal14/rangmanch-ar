/* Rangmanch AR v2.2 — hand + face gesture classifier (pure: no DOM).
   Everything is in STAGE pixels (the mirrored view you see), so the same
   numbers work in the browser, in Node tests and at any distance: every
   threshold is in face widths or hand sizes, never in pixels.

   Gestures read here (MediaPipe HandLandmarker 21 pts + FaceLandmarker):
     mouth     hand over the mouth (oops / gasp)
     shh       index finger up against the lips
     think     hand at the chin or on the cheek
     facepalm  palm over the eyes / forehead
     salute    flat hand at the brow, from the side
     cover     both hands over the face
     head      both hands on top of the head
     namaste   palms together in front of the chest
     clap      hands meeting and parting, twice inside 1.5 s
     fist      a raised closed fist
     thumbs    thumb up, fingers curled
     point     index finger out sideways, other fingers curled
     palm      a raised open palm (performed as the wave drawing, held still)
   Arm-only gestures (wave by the whole arm, point, both arms open) stay in
   app.js, read from the pose skeleton. */

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
/* Nearest finger landmark (knuckles to tips) to a point. Real hands at the
   face are read by where the fingers lie, not by the palm centre: a hand held
   up over the mouth has its wrist (and so its palm centre) below the chin. */
const fingerDist = (hi, p) => { let m = Infinity; for (const q of hi.fingers) if (q) m = Math.min(m, dist(q, p)); return m; };

/* Hand shape from 21 landmarks (stage px). A finger is extended when its tip
   is clearly farther from the wrist than its middle joint. */
export function handInfo(h) {
  if (!h || h.length < 21) return null;
  const w = h[0], size = Math.max(6, dist(h[0], h[9]));
  const ext = (tip, pip) => dist(h[tip], w) > dist(h[pip], w) * 1.12 && dist(h[tip], w) > size * 0.95;
  const curled = (tip, pip) => dist(h[tip], w) < dist(h[pip], w) * 1.05;
  const f = { index: ext(8, 6), middle: ext(12, 10), ring: ext(16, 14), pinky: ext(20, 18) };
  const c = { index: curled(8, 6), middle: curled(12, 10), ring: curled(16, 14), pinky: curled(20, 18) };
  const nExt = (f.index ? 1 : 0) + (f.middle ? 1 : 0) + (f.ring ? 1 : 0) + (f.pinky ? 1 : 0);
  const thumbOut = dist(h[4], h[5]) > size * 0.6 && dist(h[4], h[9]) > size * 0.7;
  const palm = { x: (h[0].x + h[5].x + h[9].x + h[13].x + h[17].x) / 5, y: (h[0].y + h[5].y + h[9].y + h[13].y + h[17].y) / 5 };
  const idx = { x: h[8].x - h[5].x, y: h[8].y - h[5].y }, il = Math.hypot(idx.x, idx.y) || 1;
  const up = { x: h[9].x - h[0].x, y: h[9].y - h[0].y }, ul = Math.hypot(up.x, up.y) || 1;
  // which way the palm faces: the sign of the 2D cross product wrist->index
  // knuckle x wrist->pinky knuckle, read against the hand's handedness
  const cross = (h[5].x - w.x) * (h[17].y - w.y) - (h[5].y - w.y) * (h[17].x - w.x);
  const allCurled = c.index && c.middle && c.ring && c.pinky;
  return {
    w, size, palm, f, nExt, thumbOut,
    open: nExt >= 4 || (nExt === 3 && f.index && f.middle),
    fist: allCurled && !(thumbOut && h[4].y < h[5].y - size * 0.45),
    pointing: f.index && !f.middle && !f.ring && c.pinky,
    thumbsUp: (allCurled || nExt === 0) && thumbOut && h[4].y < Math.min(h[5].y, h[9].y) - size * 0.45,
    indexDir: { x: idx.x / il, y: idx.y / il },
    upDir: { x: up.x / ul, y: up.y / ul },
    tip: h[8], mtip: h[12], thumbTip: h[4], cross,
    fingers: h.slice(5), // knuckles..tips: what actually touches the face
    edge: dist(h[5], h[17]) / size // < ~0.3: the hand is seen side-on (palms pressed together)
  };
}

/* Face geometry from FaceLandmarker points (stage px, indexable). */
export function faceInfo(f) {
  if (!f || !f[33] || !f[263] || !f[13] || !f[14] || !f[152] || !f[10] || !f[234] || !f[454]) return null;
  const eye = mid(f[33], f[263]), mouth = mid(f[13], f[14]);
  const w = dist(f[234], f[454]), h = dist(f[10], f[152]);
  if (w < 8 || h < 8) return null;
  return { eye, mouth, chin: f[152], fore: f[10], cheekA: f[234], cheekB: f[454], w, h, c: mid(eye, mouth), cx: (f[234].x + f[454].x) / 2 };
}

/* Memory the classifier keeps between frames (clap rhythm, palm wave). */
export function makeGestureMemory() {
  return { closes: [], handsState: 'open', clapUntil: 0, palmHist: [] };
}

/* Oscillation of a 1-D trace: number of direction reversals bigger than `min`. */
export function reversals(hist, min) {
  let rev = 0, lastD = 0, anchor = hist.length ? hist[0].v : 0;
  for (let i = 1; i < hist.length; i++) {
    const d = hist[i].v - anchor;
    if (Math.abs(d) < min) continue;
    if (lastD && d * lastD < 0) rev++;
    lastD = d; anchor = hist[i].v;
  }
  return rev;
}

/* The classifier. hands: array of 21-pt stage-px hands; face: stage-px
   landmark array or null; cur: the pose on stage now (its thresholds are
   relaxed 30 % — hysteresis in space, on top of the time hysteresis in
   app.js); now: ms; mem: makeGestureMemory(). Returns {name, side, via} or
   null. side = the stage side the gesturing arm comes from ('L'/'R'). */
export function classifyHandsFace({ hands, face, cur, now, mem, stageW }) {
  const H = (hands || []).map(handInfo).filter(Boolean);
  const F = faceInfo(face);
  const k = g => (cur === g ? 1.3 : 1);
  const sideOf = (hi) => {
    const ref = F ? F.cx : (stageW || 0) / 2;
    return (hi.w.x < ref ? 'L' : 'R');
  };
  mem = mem || makeGestureMemory();

  /* --- two hands --- */
  if (H.length >= 2) {
    const [a, b] = H[0].size >= H[1].size ? [H[0], H[1]] : [H[1], H[0]];
    const hs = (a.size + b.size) / 2;
    const gap = dist(a.palm, b.palm) / hs;
    // clap rhythm: count hand-meetings that follow a parting
    if (gap < 1.15) { if (mem.handsState === 'open') { mem.closes.push(now); mem.handsState = 'closed'; } }
    else if (gap > 1.9) mem.handsState = 'open';
    mem.closes = mem.closes.filter(t => now - t < 1500);
    if (mem.closes.length >= 2) mem.clapUntil = now + 700;
    if (F) {
      const nearFace = hi => dist(hi.palm, F.c) < F.w * 0.62 * k('cover');
      const onFace = hi => Math.min(fingerDist(hi, F.mouth), fingerDist(hi, F.c)) < F.w * 0.26 * k('cover');
      if ((nearFace(a) && nearFace(b)) || (onFace(a) && onFace(b))) return { name: 'cover', side: null, via: 'hands+face' };
      const onHead = hi => hi.palm.y < F.eye.y - F.h * 0.28 && Math.abs(hi.palm.x - F.cx) < F.w * 1.5 * k('head');
      if (onHead(a) && onHead(b)) return { name: 'head', side: null, via: 'hands+face' };
    }
    if (now < mem.clapUntil) return { name: 'clap', side: null, via: 'hands' };
    const below = !F || (Math.min(a.palm.y, b.palm.y) > F.chin.y - F.h * 0.15);
    const fingersUp = hi => hi.upDir.y < -0.55;
    // palms together but fingertips at the lips is a gasp, not a namaste
    const offMouth = hi => !F || fingerDist(hi, F.mouth) > F.w * 0.3;
    if (gap < 1.25 * k('namaste') && below && fingersUp(a) && fingersUp(b) && offMouth(a) && offMouth(b)) return { name: 'namaste', side: null, via: 'hands' };
  } else if (mem.handsState === 'closed') mem.handsState = 'open';
  // palms pressed together often reach the hand model as ONE side-on hand:
  // fingers straight up, centred under the chin
  if (F && H.length === 1) {
    const hi = H[0];
    if (hi.edge < 0.3 * k('namaste') && hi.upDir.y < -0.9 && hi.palm.y > F.chin.y && Math.abs(hi.palm.x - F.cx) < F.w * 0.42 * k('namaste') && fingerDist(hi, F.mouth) > F.w * 0.3)
      return { name: 'namaste', side: null, via: 'hand+face' };
  }

  /* --- one hand at the face --- */
  if (F) {
    let best = null;
    for (const hi of H) {
      const dm = dist(hi.palm, F.mouth) / F.w;
      const tipMouth = dist(hi.tip, F.mouth) / F.w;
      if (hi.pointing && tipMouth < 0.32 * k('shh') && Math.abs(hi.indexDir.y) > 0.6 && hi.tip.y < hi.palm.y) { best = { name: 'shh', side: sideOf(hi), via: 'hand+face' }; break; }
      if ((((dm < 0.42 * k('mouth') || dist(hi.mtip, F.mouth) / F.w < 0.3 * k('mouth')) && hi.palm.y > F.eye.y + F.h * 0.08 && hi.palm.y < F.chin.y - F.h * 0.04) ||
          (fingerDist(hi, F.mouth) / F.w < 0.2 * k('mouth') && hi.palm.y > F.mouth.y)) && !hi.fist && !best) {
        best = { name: 'mouth', side: sideOf(hi), via: 'hand+face' }; continue;
      }
      const dx = Math.abs(hi.palm.x - F.cx) / F.w;
      const overEyes = hi.palm.y > F.fore.y - F.h * 0.2 && hi.palm.y < F.eye.y + F.h * 0.18;
      const brow = { x: F.cx, y: (F.fore.y + F.eye.y) / 2 };
      if (((overEyes && dx < 0.42 * k('facepalm')) || (fingerDist(hi, brow) / F.w < 0.5 * k('facepalm') && hi.palm.y < F.eye.y + F.h * 0.15 && Math.abs(hi.upDir.x) < 0.45)) && !best) { best = { name: 'facepalm', side: sideOf(hi), via: 'hand+face' }; continue; }
      const towardFace = Math.abs(hi.mtip.x - F.cx) < Math.abs(hi.w.x - F.cx);
      if (hi.palm.y > F.fore.y - F.h * 0.35 && hi.palm.y < F.eye.y + F.h * 0.12 && dx > 0.38 && dx < 1.35 * k('salute') &&
          hi.f.index && hi.f.middle && towardFace && Math.abs(hi.upDir.x) > 0.45 && !best) { best = { name: 'salute', side: sideOf(hi), via: 'hand+face' }; continue; }
      const chinD = Math.min(dist(hi.tip, F.chin), dist(hi.thumbTip, F.chin), dist(hi.palm, F.chin)) / F.w;
      const cheekD = Math.min(dist(hi.palm, F.cheekA), dist(hi.palm, F.cheekB), dist(hi.tip, F.cheekA), dist(hi.tip, F.cheekB)) / F.w;
      if (!best && ((chinD < 0.36 * k('think') && hi.palm.y > F.mouth.y) ||
          (cheekD < 0.3 * k('think') && hi.palm.y > F.eye.y && hi.palm.y < F.chin.y + F.h * 0.1))) {
        best = { name: 'think', side: sideOf(hi), via: 'hand+face' };
      }
    }
    if (best) return best;
  }

  /* --- hand shapes away from the face --- */
  const raisedY = F ? F.chin.y : null;
  for (const hi of H) {
    const raised = raisedY === null ? true : hi.palm.y < raisedY + (F ? F.h * 0.2 : 0);
    if (hi.thumbsUp) return { name: 'thumbs', side: sideOf(hi), via: 'hand' };
    if (hi.pointing && Math.abs(hi.indexDir.x) > 0.72) return { name: 'point', side: hi.indexDir.x < 0 ? 'L' : 'R', via: 'hand' };
    if (hi.fist && raised) return { name: 'fist', side: sideOf(hi), via: 'hand' };
  }
  // open palm raised: a wave if it swings, a held palm otherwise
  const palms = H.filter(hi => hi.open && (raisedY === null || hi.palm.y < raisedY));
  if (palms.length) {
    const hi = palms[0];
    mem.palmHist.push({ v: hi.palm.x, t: now });
    while (mem.palmHist.length && now - mem.palmHist[0].t > 900) mem.palmHist.shift();
    const osc = reversals(mem.palmHist, hi.size * 0.25) >= 2;
    return { name: osc ? 'wave' : 'palm', side: sideOf(hi), via: 'hand', x: hi.palm.x, size: hi.size };
  }
  mem.palmHist.length = 0;
  return null;
}
