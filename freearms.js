/* Rangmanch AR v2.3 — Free arms.
   Instead of snapping to one of ~13 drawn poses, the character's arms are
   drawn every frame from your MediaPipe landmarks: cartoon capsule arms
   (sleeve + skin, bold ink outline) hung from the character's own shoulder
   points, and cartoon hands built from the 21 hand landmarks (a palm blob +
   five rounded finger strokes), so a heart, peace, thumbs-up, pointing, an
   open palm, a fist or both hands in the air come out as you make them.

   Mapping (all in base-drawing pixels — the app hands us a stage→drawing
   transform): your shoulder line is anchored onto the character's shoulder
   line with one uniform scale k (character shoulder width / yours), mirrored
   as the stage is (your right hand moves the character's right-of-stage
   arm). One scale for everything keeps hand-to-hand relations exact (two
   hands touching stay touching, so a heart stays a heart). Near the face the
   hands are pulled onto the cartoon face (its head is far bigger than a real
   one), so covering the face or "shh" lands on the face. The elbow comes
   from your elbow when the camera clearly sees it (direction copied, the
   upper arm foreshortened as yours is), else from 2-bone IK with the
   character's own limb lengths (lower elbow wins), so a limb can never
   detach or stretch by more than 12 %.
   Smoothing: One-Euro on every point. A hand that drops out is held for
   300 ms, then the arm eases down to rest. */
import { OneEuro } from './headwarp.js?v=2.3.0';

const FINGERS = [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]];
const PALM = [0, 1, 5, 9, 13, 17];
// a relaxed hand, fingers together, in hand lengths: x across the palm, y wrist → fingertips
const RELAXED = [[0, 0], [-0.18, 0.12], [-0.27, 0.28], [-0.31, 0.42], [-0.32, 0.54], [-0.14, 0.45], [-0.15, 0.65], [-0.15, 0.8], [-0.15, 0.92],
  [-0.03, 0.47], [-0.03, 0.69], [-0.03, 0.85], [-0.03, 1.0], [0.08, 0.45], [0.09, 0.65], [0.09, 0.79], [0.09, 0.9],
  [0.17, 0.4], [0.19, 0.56], [0.2, 0.67], [0.2, 0.76]];
const HOLD_MS = 300, EASE_MS = 450;

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a, k) => ({ x: a.x * k, y: a.y * k });
const len = a => Math.hypot(a.x, a.y);
const lerpP = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const midP = (a, b) => lerpP(a, b, 0.5);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth01 = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };

class PtFilter {
  constructor(mc, beta) { this.fx = new OneEuro(mc, beta); this.fy = new OneEuro(mc, beta); }
  filter(p, t) { return { x: this.fx.filter(p.x, t), y: this.fy.filter(p.y, t) }; }
  snap(p) { this.fx.snap(p.x); this.fy.snap(p.y); }
}

/* Two-bone IK: shoulder S, target T, upper a, fore b, bend side sign.
   Returns { E, W, stretch }. The target is clamped to reach (12 % stretch max). */
export function solveArm(S, T, a, b, sign) {
  let d = sub(T, S), dist = len(d) || 1e-6;
  let stretch = 1;
  if (dist > a + b) { stretch = Math.min(dist / (a + b), 1.12); a *= stretch; b *= stretch; }
  const reach = a + b - 0.5, minR = Math.abs(a - b) + 2;
  const dd = clamp(dist, minR, reach);
  const u = mul(d, 1 / dist);
  const W = add(S, mul(u, dd));
  const cosA = clamp((a * a + dd * dd - b * b) / (2 * a * dd), -1, 1), A = Math.acos(cosA) * sign;
  const E = add(S, { x: (u.x * Math.cos(A) - u.y * Math.sin(A)) * a, y: (u.x * Math.sin(A) + u.y * Math.cos(A)) * a });
  return { E, W, stretch, a, b };
}

class Arm {
  constructor(side, rig) {
    this.side = side; this.rig = rig;
    this.S = { x: rig.shoulders[side][0], y: rig.shoulders[side][1] };
    this.rest = side === 'L' ? { x: this.S.x - 26, y: this.S.y + (rig.upper + rig.fore) * 0.96 } : { x: this.S.x + 26, y: this.S.y + (rig.upper + rig.fore) * 0.96 };
    this.fT = new PtFilter(1.6, 0.004);  // wrist target
    this.fE = new PtFilter(1.2, 0.004);  // elbow hint
    this.fH = Array.from({ length: 21 }, () => new PtFilter(2.2, 0.006)); // hand points (relative to the wrist)
    this.sign = side === 'L' ? 1 : -1;   // elbows out by default
    this.lastT = null; this.lastSeen = -1e9; this.lastHand = null; this.lastHandAt = -1e9;
    this.T = { ...this.rest }; this.out = null; this.back = false; this.handLive = false; this.inited = false;
  }
}

export class FreeArms {
  constructor(rig, charFace) {
    this.rig = rig; this.charFace = charFace; // { eyes:[x,y], mouth:[x,y] } of the base drawing
    this.arms = { L: new Arm('L', rig), R: new Arm('R', rig) };
    this.kF = new OneEuro(0.6, 0.002);
    this.hkF = { L: new OneEuro(0.8, 0.002), R: new OneEuro(0.8, 0.002) }; // hand scale per hand
    this.Cmid = midP(this.arms.L.S, this.arms.R.S);
    this.Cw = len(sub(this.arms.R.S, this.arms.L.S));
    this.dbg = {};
  }
  /* pose: 33 landmarks in drawing px ({x,y,z,v}) or null; hands: arrays of
     21 drawing-px points (+z); face: { eyes, mouth } in drawing px or null */
  update(pose, hands, face, now) {
    const rig = this.rig, P = pose;
    const vis = i => P && P[i] ? (P[i].v ?? 1) : 0;
    // ---- the person's shoulder line and the one scale k
    let Pmid = null, Pw = 0;
    const personEM = face ? len(sub(face.mouth, face.eyes)) : 0;
    if (P && P[11] && P[12] && vis(11) > 0.3 && vis(12) > 0.3) {
      Pmid = midP(P[11], P[12]); Pw = len(sub(P[12], P[11]));
      if (personEM) Pw = Math.max(Pw, personEM * 4.3); // turned sideways: never shrink below the face's say
    } else if (face && personEM > 1) { // no shoulders: estimate them from the face
      Pmid = add(midP(face.eyes, face.mouth), { x: 0, y: personEM * 2.9 }); Pw = personEM * 5.4;
    }
    let k = null;
    if (Pmid && Pw > 4) k = this.kF.filter(this.Cw / Pw, now);
    const M = p => add(this.Cmid, mul(sub(p, Pmid), k));
    // face attraction: hands near your face land on the cartoon face
    const cf = this.charFace;
    const cEM = cf ? Math.hypot(cf.mouth[0] - cf.eyes[0], cf.mouth[1] - cf.eyes[1]) : 0;
    const faceW = hc => {
      if (!face || !cf || personEM < 1) return 0;
      const fc = midP(face.eyes, face.mouth);
      return 1 - smooth01(2.0, 3.6, len(sub(hc, fc)) / personEM);
    };
    const faceMap = p => ({ x: cf.eyes[0] + (p.x - face.eyes.x) * cEM / personEM, y: cf.eyes[1] + (p.y - face.eyes.y) * cEM / personEM });

    // ---- which hand belongs to which arm (nearest pose wrist; else side of your shoulder line)
    const assigned = { L: null, R: null };
    if (k) {
      const cands = hands.filter(h => h && h.length === 21);
      const wristOf = s => (P && P[s === 'L' ? 15 : 16]) || null;
      const cost = (h, s) => { const w = wristOf(s); return w ? len(sub(h[0], w)) : ((h[0].x < Pmid.x) === (s === 'L') ? 0 : 1e6); };
      if (cands.length === 1) { const h = cands[0]; assigned[cost(h, 'L') <= cost(h, 'R') ? 'L' : 'R'] = h; }
      else if (cands.length >= 2) {
        const [a, b] = cands;
        // two hands side by side: stage-left hand → stage-left arm (pose wrists
        // are noisy when the hands meet, e.g. in a heart, and swap the arms)
        const gap = Math.abs(a[0].x - b[0].x), palm = Math.max(len(sub(a[9], a[0])), len(sub(b[9], b[0])));
        if (gap > palm * 0.3) { assigned.L = a[0].x < b[0].x ? a : b; assigned.R = assigned.L === a ? b : a; }
        else if (cost(a, 'L') + cost(b, 'R') <= cost(a, 'R') + cost(b, 'L')) { assigned.L = a; assigned.R = b; } else { assigned.L = b; assigned.R = a; }
      }
    }
    // one attraction weight for two hands working together (a heart stays whole)
    const hcs = { L: assigned.L && M(assigned.L[9]), R: assigned.R && M(assigned.R[9]) };
    // hand size: a hand close to the lens looks far bigger than the body says,
    // so each hand is sized to the character's own hand (palm length or
    // width, whichever is larger — width does not foreshorten), within limits
    const palmSize = h => Math.max(len(sub(h[9], h[0])), 1.2 * len(sub(h[5], h[17])), 1e-3);
    const hk = {};
    for (const s of ['L', 'R']) if (assigned[s]) hk[s] = this.hkF[s].filter(clamp(0.47 * rig.hand / palmSize(assigned[s]), 0.35 * k, 1.6 * k), now);
    const together = !!(assigned.L && assigned.R && personEM && len(sub(assigned.L[9], assigned.R[9])) < personEM * 3);
    if (together) hk.L = hk.R = (hk.L + hk.R) / 2;
    const wF = { L: assigned.L ? faceW(assigned.L[9]) : 0, R: assigned.R ? faceW(assigned.R[9]) : 0 };
    // a face-pull shift per hand; two hands working together share one shift
    // (taken at their midpoint) so their relation is untouched
    const shift = { L: null, R: null };
    for (const s of ['L', 'R']) if (assigned[s] && wF[s] > 0.001) shift[s] = mul(sub(faceMap(assigned[s][9]), hcs[s]), wF[s]);
    if (together) {
      const w = (wF.L + wF.R) / 2; wF.L = wF.R = w;
      const m = midP(assigned.L[9], assigned.R[9]);
      shift.L = shift.R = w > 0.001 ? mul(sub(faceMap(m), M(m)), w) : null;
    }

    for (const s of ['L', 'R']) {
      const arm = this.arms[s], h = assigned[s];
      const iS = s === 'L' ? 11 : 12, iE = s === 'L' ? 13 : 14, iW = s === 'L' ? 15 : 16;
      let T = null, Ehint = null, handRel = null;
      if (k && h) {
        // two hands together are scaled as a pair about their midpoint, so
        // touching stays touching at the character's hand size
        if (together) { const m = midP(assigned.L[9], assigned.R[9]); T = add(M(m), mul(sub(h[0], m), hk[s])); }
        else T = M(h[0]);
        if (shift[s]) T = add(T, shift[s]);
        handRel = h.map(q => mul(sub(q, h[0]), hk[s]));
        handRel.forEach((q, i) => { q.z = h[i].z || 0; });
      } else if (k && P && P[iW] && vis(iW) > 0.15) {
        T = M(P[iW]);
      }
      if (k && P && P[iE] && vis(iE) > 0.15) Ehint = M(P[iE]);
      // ---- hold, then ease down to rest
      if (T) { arm.lastSeen = now; arm.lastT = T; }
      else if (arm.lastT && now - arm.lastSeen < HOLD_MS) T = arm.lastT;
      else if (arm.lastT) {
        const e = smooth01(0, 1, (now - arm.lastSeen - HOLD_MS) / EASE_MS);
        T = lerpP(arm.lastT, arm.rest, e); Ehint = null;
        if (e >= 1) arm.lastT = null;
      } else T = arm.rest;
      if (!arm.inited) { arm.fT.snap(T); arm.inited = true; }
      const Tf = arm.fT.filter(T, now);
      // ---- bend side: of the two IK elbows, the one nearer your elbow (with
      // hysteresis, so a near-straight arm never flips); elbows out at start
      // an elbow the camera does not really see (out of frame, low
      // visibility) is not trusted: then the lower elbow wins (gravity)
      let sol = solveArm(arm.S, Tf, rig.upper, rig.fore, arm.sign);
      const alt = solveArm(arm.S, Tf, rig.upper, rig.fore, -arm.sign);
      const hyst = rig.upper * 0.15;
      const cross = (o, p, q) => { const v1 = sub(p, o), v2 = sub(q, o); return (v1.x * v2.y - v1.y * v2.x) / ((len(v1) * len(v2)) || 1); };
      let byHint = false;
      if (Ehint && vis(iE) > 0.6) {
        // the side of the shoulder→wrist line your elbow is on (only when clearly on one side)
        const Ef = arm.fE.filter(Ehint, now), cr = cross(arm.S, Tf, Ef);
        if (Math.abs(cr) > 0.25) { byHint = true; if (Math.sign(cross(arm.S, Tf, alt.E)) === Math.sign(cr) && Math.sign(cross(arm.S, Tf, sol.E)) !== Math.sign(cr)) { arm.sign = -arm.sign; sol = alt; } }
      }
      if (!byHint && alt.E.y > sol.E.y + hyst) { arm.sign = -arm.sign; sol = alt; }
      // a clearly seen elbow is copied directly: the upper arm points where
      // yours points, shortened as yours looks shortened (an arm reaching
      // toward the lens), and the forearm runs from there to the hand when
      // it can without stretching more than 12 % — else the IK above stands
      if (Ehint && vis(iE) > 0.6 && vis(iS) > 0.5) {
        const du = sub(P[iE], P[iS]), dl = len(du);
        if (dl > 1e-3) {
          const d = mul(du, 1 / dl), aEff = clamp(k * dl, 0.4 * rig.upper, rig.upper);
          let t = aEff, f = len(sub(Tf, add(arm.S, mul(d, t))));
          if (f > rig.fore * 1.12) {
            // too far from the hand: slide the elbow along your upper-arm
            // direction to where the forearm just reaches
            const v = sub(Tf, arm.S), dv = d.x * v.x + d.y * v.y, disc = dv * dv - (v.x * v.x + v.y * v.y) + rig.fore * rig.fore;
            t = disc >= 0 ? dv + Math.sqrt(disc) : -1;
            f = rig.fore;
          }
          if (t >= 0.3 * rig.upper && t <= rig.upper * 1.001 && f >= rig.fore * 0.3) {
            const E = add(arm.S, mul(d, t));
            sol = { E, W: Tf, stretch: Math.max(1, len(sub(Tf, E)) / rig.fore), a: t, b: len(sub(Tf, E)) };
          }
        }
      }
      // ---- hand points: live, held 300 ms, else a relaxed hand along the forearm
      let rel = null;
      if (handRel) { rel = handRel.map((q, i) => { const f = arm.fH[i]; if (!arm.handLive) f.snap(q); const r = f.filter(q, now); r.z = q.z; return r; }); arm.lastHand = rel; arm.lastHandAt = now; arm.handLive = true; }
      else if (arm.lastHand && now - arm.lastHandAt < HOLD_MS) rel = arm.lastHand;
      else {
        arm.handLive = false;
        const dir = sub(sol.W, sol.E), L = len(dir) || 1, ux = dir.x / L, uy = dir.y / L, Lh = rig.hand, flip = s === 'L' ? -1 : 1;
        // canonical +y along the forearm, thumb toward the body
        rel = RELAXED.map(([x, y]) => { const X = x * flip * Lh, Y = y * Lh; return { x: X * uy + Y * ux, y: -X * ux + Y * uy, z: 0 }; });
      }
      // ---- behind the torso: wrist below the hip line and behind your body
      const behind = P && P[iW] && P[iS] && ((P[iW].z || 0) - (P[iS].z || 0)) > 0.12;
      arm.back = sol.W.y > rig.hipY - 10 && !!behind && Math.abs(sol.W.x - this.Cmid.x) < this.Cw * 0.55;
      arm.out = { S: arm.S, E: sol.E, W: sol.W, hand: rel.map(q => ({ x: sol.W.x + q.x, y: sol.W.y + q.y, z: q.z || 0 })), stretch: sol.stretch, live: !!h, faceW: wF[s] };
    }
    this.dbg = { k, L: this.arms.L.out, R: this.arms.R.out, hands: (assigned.L ? 1 : 0) + (assigned.R ? 1 : 0) };
  }

  /* layer 'back': arms behind the torso; 'front': the rest. hairFront is the
     hair that falls over the left shoulder, laid between the upper arm and
     the forearm so the strand stays in front of the shoulder. */
  draw(g, layer, hairFront, W, H) {
    const arms = ['L', 'R'].map(s => this.arms[s]).filter(a => a.out && (layer === 'back' ? a.back : !a.back));
    if (!arms.length) return;
    const r = this.rig, ink = r.ink || '#1a1a19', o = r.outline || 6;
    g.save(); g.lineCap = 'round'; g.lineJoin = 'round';
    for (const a of arms) this.drawUpper(g, a.out, r, ink, o);
    if (layer === 'front' && hairFront) g.drawImage(hairFront, 0, 0, W, H);
    for (const a of arms) { this.drawFore(g, a.out, r, ink, o); this.drawHand(g, a.out.hand, r, ink, o); }
    g.restore();
  }
  drawUpper(g, A, r, ink, o) {
    const wu = r.armW * 1.06, sw = r.sleeveW, H = lerpP(A.S, A.E, r.sleeveLen), rs = sw / 2 * 0.84;
    // upper arm skin (under the sleeve)
    seg(g, A.S, A.E, wu + 2 * o, ink); seg(g, A.S, A.E, wu, r.skin);
    // sleeve: rounded shoulder, flat hem with an ink line across it
    g.lineCap = 'butt'; seg(g, A.S, H, sw + 2 * o, ink);
    dot(g, A.S, rs + o, ink); dot(g, A.S, rs, r.sleeve);
    seg(g, A.S, H, sw, r.sleeve); g.lineCap = 'round';
    const d = sub(H, A.S), L = len(d) || 1, n = { x: -d.y / L * (sw / 2 + o * 0.5), y: d.x / L * (sw / 2 + o * 0.5) };
    g.strokeStyle = ink; g.lineWidth = o; g.beginPath(); g.moveTo(H.x + n.x, H.y + n.y); g.lineTo(H.x - n.x, H.y - n.y); g.stroke();
  }
  drawFore(g, A, r, ink, o) {
    // butt-capped ink at the elbow: no outline ring across the joint
    const wf = r.armW * 0.94;
    g.lineCap = 'butt'; seg(g, A.E, A.W, wf + 2 * o, ink); g.lineCap = 'round';
    dot(g, A.W, wf / 2 + o, ink);
    seg(g, A.E, A.W, wf, r.skin);
  }
  drawHand(g, pts, r, ink, o) {
    if (!pts) return;
    const ho = Math.max(3, o * 0.75);
    const pw = len(sub(pts[5], pts[17])), hl = len(sub(pts[9], pts[0]));
    const fw = clamp(Math.max(pw * 0.3, hl * 0.26), 8, r.armW * 0.42);
    const palm = PALM.map(i => pts[i]);
    const rr = fw * 0.9; // palm corner roundness
    // 1) one ink silhouette (palm + every finger), 2) skin fills, nearer fingers last
    poly(g, palm, ink, rr + 2 * ho);
    for (const f of FINGERS) chain(g, [pts[f[0]], ...f.slice(1).map(i => pts[i])], ink, fw + 2 * ho);
    poly(g, palm, r.skin, rr);
    const order = FINGERS.map(f => ({ f, z: pts[f[3]].z || 0 })).sort((a, b) => b.z - a.z);
    for (const { f } of order) {
      const base = pts[f[0]], c = [lerpP(base, pts[f[1]], f[0] === 1 ? 0.55 : 0.35), ...f.slice(1).map(i => pts[i])];
      chain(g, c, ink, fw + 2 * ho); chain(g, [base, ...f.slice(1).map(i => pts[i])], r.skin, fw);
    }
  }
}

function seg(g, a, b, w, color) { g.strokeStyle = color; g.lineWidth = w; g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke(); }
function dot(g, p, rad, color) { g.fillStyle = color; g.beginPath(); g.arc(p.x, p.y, rad, 0, Math.PI * 2); g.fill(); }
function chain(g, pts, color, w) { g.strokeStyle = color; g.lineWidth = w; g.beginPath(); g.moveTo(pts[0].x, pts[0].y); for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y); g.stroke(); }
function poly(g, pts, color, w) {
  g.fillStyle = color; g.strokeStyle = color; g.lineWidth = w; g.beginPath(); g.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y); g.closePath(); g.fill(); g.stroke();
}
