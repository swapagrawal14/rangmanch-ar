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

- **v2.1 (3 Nov, night) — Phone first.** Swapnil: "issues hi issues", find them yourself. Audited as a real phone user (390×844, headless Chromium, real MediaPipe models, fake camera fed by real person clips: selfie talker, waist-up waver, full-body dancer). Ranked findings: (1) the phone got a desktop page — 16:9 stage 308×173 px half-way down, Start Camera below the fold; (2) Start Camera downloaded ~26 MB of models BEFORE asking for the camera (42 s to camera-on in the audit) and the page eagerly fetched all 16 packs (29 MB); (3) in a real selfie one hand holds the phone, and the classifier refused all gestures unless BOTH arms were visible — the character never moved on the selfie clip; (4) 12 of 16 packs had no face anchors, so their mouth and blink never animated; (5) pose drawings are separate illustrations at different sizes (Bunty open = 72%), so swaps shrank/teleported the character; drawings always waved the same arm regardless of yours; (6) placement flipped between face and shoulder framing whenever the face model missed a frame (~200 px vertical jumps), head cropped at the top, full-body figure floated above the floor; (7) recording: WebM only (iPhone Safari records only MP4), no duration in the file, fixed .webm name, no share; mic refusal killed the camera; raw error text; (8) iOS pitfalls: display:none video, no wake lock; per-frame getImageData readback; co-actors drawn on top of the lead in 9:16; Director's Notes still promised the deleted cut-out rig. v2.1 fixes all of these (see README), adds tools/measure-anchors.py (validated at 5 px median vs the hand-measured packs) + assets/anchors.json, tools/build-thumbs.py + 12 KB thumbs, and tests/v21.test.mjs (39 assert checks). Honest limits: real-phone FPS/thermal, iOS Safari GPU delegate and H.264/AAC recording on a real iPhone still need Swapnil's on-device pass; pose art that is cropped at its canvas edge (e.g. Swapnil's open arms, Bunty's open hand) is an art-side issue.

- **v2.0 (3 Nov, late evening) — the Stage Puppet.** Swapnil's on-device v1.0 test failed the same way (static character over a recognisable backdrop, nothing moved) and she ordered research before any more building: *"mere jese ya GitHub projects research kro, unke structures smjho."* Three convergent research tracks (Kalidokit/Pose Animator repos, Live2D/Rive/PNGTuber systems, her own Forge packs; report in ~/workspace/research_notes/webcam-avatar-project-structures-20261103-1422/) reached one verdict: **no successful project cuts a flat finished illustration into a puppet at runtime** — art is authored FOR the rig (Live2D parts with hidden areas painted in; Pose Animator's skeleton embedded in the SVG; PNGTubers swapping complete drawings), landmarks are solved to bounded parameters, bad tracking is refused (Kalidokit zeroes invisible limbs to rest pose), and aliveness is secondary motion (breath/blink/bounce/sway). Her own packs already ship the proven route — 4 complete gesture poses + hand-measured per-pose face anchors, exactly what the delivered family pilot (render2.py) animates — while Forge's motion parts/ layer exists only in the spec and WowKit flags its estimated joints as drafts. Swapnil delegated the direction ("Whatever uh prefer"); v2.0 implements the research: the cut-out rig is DELETED; the lead performs the pack's authored poses via a visibility-gated gesture classifier with hysteresis (wave = raised hand, high or oscillating; point = one straight arm out, asymmetric reach; open = both arms up/wide; thumbs = thumb-up hand shape); face blendshapes drive A/O/E/blink/laugh tiles at the CURRENT POSE's anchors inside the figure transform; placement follows the torso (hips-visible), face (selfie) or shoulders, conditioned by One Euro filters; secondary motion = breath + idle bob + talk bounce + auto-blink timer; guidance/CPU-fallback/auto-quality from v1.0.1 kept. Sandbox: classifier checks wave/point/open/back-to-base all pass, screenshots eyeballed clean (wave+talk shows the A tile on the wave drawing's own anchor; point pose carries the blink; open pose carries the laugh), real models 46 fps on fake camera, geometry scan 21 ms, recording round-trip OK, zero console errors beyond the sandbox font tunnel. Honest limits: poses are discrete (no continuous arm mirroring — that needs Forge's unbuilt parts pipeline, a possible v2.1 for the lead only); on-device camera feel remains Swapnil's verdict to give.


- **v0.2 (3 Nov):** theatre-grade UI redesign after Swapnil's feedback that v0.1 looked like a generic AI template — marquee header with bulbs, curtain-framed stage, director-console buttons, casting cards with real pack-art thumbnails, playbill Director's Notes. Pushed 3e7198b.
- **v0.3 (3 Nov):** all 16 Forge packs bundled + lazy loading, landmark smoothing, quality toggle (High/Balanced inference staggering), 9:16 reel mode, live captions burned into recordings, record timer + retake. README rebuilt with visuals generated from real pack art (hero, 16-cast lineup, pose strip, face strip).
- **v0.5 (3 Nov) — "Total Replacement":** Swapnil's on-device test of v0.4: character appears, but (1) extra characters popping in = chaos, (2) movements don't feel like hers, (3) she wants to be COMPLETELY replaced — wherever she looks, whatever she says/laughs/does, the character does exactly that. Fixes: raw camera feed is never drawn (room rendered as a low-res blurred backdrop, character scaled from her full body span so it covers her); head is now its own rig piece (skin-tone-only erase, validated in prototypes after a dress-streak halo bug) driven by face-landmark yaw/pitch/roll with foreshortening + feature slide; mouth thresholds lowered and laughter mapped to a wide E grin; landmark smoothing raised 0.45→0.62 for less lag; co-actors moved behind an off-by-default console toggle so the stage is solo unless she invites company.
- **v0.4 (3 Nov) — "You Become the Character":** Swapnil's verdict on v0.3 was blunt: pose-swap + tiny floating hand puppets felt useless; the project's heart is *the user converts into the character*. Rebuilt the core: (1) lead is now a live puppet — at pack load the browser cuts the character's arms out of its own base art (feathered bone-strips, template measured via visual grounding; holes filled by smearing hair/dress pixels) and re-poses them bone-by-bone from the user's skeleton each frame; torso/head ride the torso transform; face tiles ride the same transform. Rectangular-crop rigging was prototyped first and rejected (drags blocks of hair/dress); the masked-strip + erased-underlayer approach was validated in offline renders (rest + wave) before porting. (2) Hand characters are no longer tiny stickers: they are full-size co-actors who rise onto the stage floor, walk with your hand, and talk on pinch. (3) All public text converted to English (UI, playbill, README, brand assets) — the audience is global.
- **v1.0 (3 Nov, evening) — the market-ready rebuild.** Swapnil's on-device v0.5 test failed hard ("Very bad": face split in two, character at giant scale, casting thumbnails broken) and she ordered a full professional rebuild, tested in the sandbox, no unverified increments. Root causes found by reading the REAL pack manifest: the v0.4/v0.5 loader used an invented format (`talk.assets`, `mouthA.png`) while packs actually ship `talk.base` + `talk.files{A,O,E,blink}` + `talk.patches` + `talk.poseAnchors` — so no face tiles or thumbnails ever loaded; the underlayer kept the drawn face features under the separate head piece (double face); scale came from off-frame estimated landmarks (explosion). v1.0 is a full app.js rewrite: loader on the real format; per-pack skeleton from Forge's own WowKit estimateJoints math; **real arm lines found by skin-tone scan** (estimates sit up to ~90px off the drawn arm — the scan follows bare arms and light sleeves, with line-fit deviation stops so it can't wander into legs/saree, and estimate fallback); transform anchored at the NECK with scale from the shoulder-width ratio (clamped); the whole face ellipse erased so the head piece never ghosts; face tiles drawn INSIDE the head piece's transform (alignment guaranteed); eye-roll computed in canvas space (landmark order had it pinned at 180°→clamp, tilting every head); co-actors stand on the lead's floor line and scale with the lead; landmarks mapped aspect-true (fit) so landscape cameras don't stretch on the portrait reel stage. Performance: pose every frame, face/hands alternate frames, auto-quality shed on sustained low FPS, chunked region-limited rig build ~200 ms, recorder MIME fallback chain, message auto-dismiss, model/pack failure states with retry. Verified by a new Playwright sandbox harness (tests/sandbox.mjs + sandbox2.mjs + rig dumps): 12 scenario screenshots eyeballed clean (rest / wave+talk / look+laugh / blink / portrait / co-actors / reel / Sanjay lead / mobile), real MediaPipe models load and infer (45 fps in headless software-GL), recording round-trip produces a download, rigs dumped and inspected for swapnil/sanjay/seema/bhavishy. Honest limits: Seema's saree sits inside her arm corridor so big arm swings can carry a little saree with the forearm; camera *feel* (lighting, framing on a real phone) still wants Swapnil's on-device pass.
- Remaining known gap: per-character voice pitch (live mic is recorded as-is) and the on-device camera test, which is Swapnil's to run from the Vercel/Pages link.

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
