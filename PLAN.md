# Rangmanch AR — Technical Plan

**Hackathon:** Build Your First AI App 2026 (Devpost) — submission deadline **27 Nov 2026, 5:00 PM EST** (28 Nov ~3:30 AM IST)
**Builder:** Swapnil Agrawal (solo) · **Locked:** 3 Nov 2026
**One line:** A one-person cartoon studio — act in front of your phone, and your body, hands and face perform as different live doodle characters in AR over your real room. Record the act, export the film.

## The use case (submission framing)

Animation today = script → draw → rig → learn software → keyframe for days → film.
Rangmanch = open phone → act → film.

- **Primary users:** solo creators and teachers who want animated videos but cannot draw/animate — and the many who will not show their own face on camera. Their body is the controller; no English prompt-typing needed.
- **Builder-is-user proof:** Swapnil makes dental-education and client videos for a living (Udyam-registered freelance practice). Her own family pilot took a full day of pose normalising + hand-correcting 20 mouth anchors for 2:51 of film. Rangmanch turns that day into minutes of acting.
- **Demo = proof:** the submission demo itself is a real, sendable 45-second dental-education reel ("Germ vs Toothbrush") produced *by* Rangmanch live in the video.

## How it differs from Doodle Mirror (Kiroween, 4 Dec)

Doodle Mirror: **you become** the doodle (a mirror). Rangmanch: **you are the director + every actor**, output is a recorded multi-character film. Different product, different hackathon; the MediaPipe research is shared deliberately.

## Architecture (all on-device, browser, no server, no paid APIs)

```
Camera + Mic (getUserMedia)
   │
   ├─ MediaPipe Tasks Vision (WASM + GPU delegate, lite models)
   │    ├─ PoseLandmarker   33 pts        ──► BODY CAST
   │    ├─ HandLandmarker   2 × 21 pts    ──► LEFT-HAND CAST / RIGHT-HAND CAST
   │    └─ FaceLandmarker   mesh + 52 blendshapes ──► EXPRESSION CAST
   │
   ├─ Retargeting layer (ours)
   │    ├─ Body: hip-centre anchor, shoulder-line tilt, height from shoulder→ankle span;
   │    │        gesture classifier (wrist vs shoulder heights) → Rigpop pose swap
   │    │        (base / wave / point / open / thumbs)
   │    ├─ Hands: wrist→middle-finger angle = puppet tilt, hand scale = puppet size,
   │    │        pinch (thumb–index distance) = puppet "speaking" mouth
   │    └─ Face: jawOpen → A tile, mouthFunnel → O tile, mouthSmile → E tile,
   │             eyeBlink → blink tile (Rigpop Talk patch compositing, live)
   │
   ├─ Character layer: Rigpop Forge packs, consumed as-is
   │    (character.rigpop.json: talk/base + A/O/E/blink patch tiles + rects + gesture poses)
   │    Bundled v0.1 cast: swapnil (body), mocha (left hand), bunty (right hand)
   │
   ├─ AR stage: <canvas> — mirrored camera feed as the room, characters composited
   │    with floor shadows at the ankle line, depth scale from body size
   │
   └─ Recording: canvas.captureStream(30) + mic audio track → MediaRecorder
        → one-tap download (.webm / .mp4 where the browser supports it)
```

**Performance strategy:** lite models, staggered inference (pose every frame, hands every 2nd, face every 3rd), GPU delegate with CPU fallback, 720p canvas cap. Target ≥ 24 fps on a mid-range Android phone.

**Privacy:** every model runs on-device; no video ever leaves the phone. (A real judging point vs cloud AI-video generators, whose characters also change every clip — Rigpop packs stay consistent.)

**Fallback:** Demo Mode — if camera/models are unavailable, synthetic landmark motion drives the same cast on a stage backdrop, so the app is never a blank screen (also how judges without a webcam can see it).

## Build phases (to 27 Nov)

| Phase | Dates | Deliverable |
|---|---|---|
| 1 — Core magic | 4–10 Nov | Pose retarget → 1 character live + gesture pose swaps + face-driven A/O/E/blink + record/download. **v0.1 = start of this (done 3 Nov, see below)** |
| 2 — Full cast | 11–17 Nov | Both hand puppets with pinch-talk, cast picker for all 16 Forge packs, floor-shadow AR polish, scene timer + retake flow |
| 3 — Film finish | 18–24 Nov | Per-character voice pitch on playback takes, captions burned in, 9:16 reel framing mode, demo reel production ("Germ vs Toothbrush") |
| Buffer / submit | 25–27 Nov | Devpost write-up (problem, build, disclosures), 2–4 min demo video, public GitHub repo, freeze |

## Progress log

- **v0.2 (3 Nov):** theatre-grade UI redesign after Swapnil's feedback that v0.1 looked like a generic AI template — marquee header with bulbs, curtain-framed stage, director-console buttons, casting cards with real pack-art thumbnails, playbill Director's Notes. Pushed 3e7198b.
- **v0.3 (3 Nov):** all 16 Forge packs bundled + lazy loading, landmark smoothing, quality toggle (High/Balanced inference staggering), 9:16 reel mode, live captions burned into recordings, record timer + retake. README rebuilt with visuals generated from real pack art (hero, 16-cast lineup, pose strip, face strip).
- **v0.4 (3 Nov) — "You Become the Character":** Swapnil's verdict on v0.3 was blunt: pose-swap + tiny floating hand puppets felt useless; the project's heart is *the user converts into the character*. Rebuilt the core: (1) lead is now a live puppet — at pack load the browser cuts the character's arms out of its own base art (feathered bone-strips, template measured via visual grounding; holes filled by smearing hair/dress pixels) and re-poses them bone-by-bone from the user's skeleton each frame; torso/head ride the torso transform; face tiles ride the same transform. Rectangular-crop rigging was prototyped first and rejected (drags blocks of hair/dress); the masked-strip + erased-underlayer approach was validated in offline renders (rest + wave) before porting. (2) Hand characters are no longer tiny stickers: they are full-size co-actors who rise onto the stage floor, walk with your hand, and talk on pinch. (3) All public text converted to English (UI, playbill, README, brand assets) — the audience is global.
- Remaining known gap: per-character voice pitch (live mic is recorded as-is in v0.3) and the on-device camera test, which is Swapnil's to run from the Vercel/Pages link.

## v0.1 status (3 Nov 2026)

Static web app in this folder (`index.html`, `app.js`, `styles.css`), zero build step:
Pose + Hands + Face tracking live, body-part casting with the 3 bundled Forge packs,
Rigpop Talk patch compositing driven by the user's own face, gesture pose swaps,
AR compositing with floor shadow, mic+canvas recording with download, Demo Mode fallback.
Run: `python3 -m http.server 8642` in this folder → open `http://localhost:8642`.

## Risks & mitigations

- **3 models at once too heavy for low-end phones** → staggered inference (above), lite models, quality toggle in Phase 2.
- **CDN/model hosting dependency** → pin @mediapipe/tasks-vision version; Phase 3: vendor WASM + .task files into the repo for full offline.
- **Handedness mirroring confusion** → canvas is mirrored (selfie view); handedness labels are swapped deliberately and tested on-device in Phase 1.
- **Overlap with Kiroween entry** → products framed as above; disclosures in both submissions state the shared research honestly.

## Submission checklist (Devpost)

- [ ] Working app, public link (GitHub Pages)
- [ ] Public GitHub repo with README + setup (Swapnil creates the repo, same pattern as rigpop-forge)
- [ ] Project description: problem / solution / tech / what was built during the hackathon window vs pre-existing (Forge packs + Rigpop format pre-date it — disclosed; Rangmanch itself is new)
- [ ] AI disclosure: MediaPipe on-device ML, AI-generated character art via Forge pipeline
- [ ] 2–4 minute demo video (live acting demo + the exported reel it produces)
