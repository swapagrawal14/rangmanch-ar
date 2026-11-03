<p align="center">
  <img src="docs/assets/hero.png" alt="Rangmanch AR — Bunty, Swapnil and Mocha on stage" width="880">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/hackathon-Build_Your_First_AI_App_2026-9c222b" alt="Hackathon">
  <img src="https://img.shields.io/badge/tracking-MediaPipe_on--device-3f9e4d" alt="On-device MediaPipe">
  <img src="https://img.shields.io/badge/characters-16_Rigpop_Forge_packs-f2b33d" alt="16 characters">
  <img src="https://img.shields.io/badge/server-none_·_no_uploads-221409" alt="No server">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT">
</p>

# Rangmanch AR 🎭

**Every AI tool in this hackathon asks you to type. Rangmanch asks you to *act*.**

Stand in front of your phone. You **become** the lead actor: the character is
cut live from its own artwork and re-posed on your skeleton — shoulders,
elbows, wrists, hips — every single frame. Your **hands** conduct two full-size
co-actors standing on the stage floor beside you, and your **face** drives the
lead's mouth and blinks. Hit record, perform the scene in your own voice,
download the cartoon film.

No drawing. No animation software. No face-cam. No prompt-typing. No server —
and your video never leaves your device.

<p align="center">
  <img src="docs/assets/cast-lineup.png" alt="The full Rangmanch cast — 16 Rigpop Forge characters" width="880">
  <br><em>The full opening cast: 16 characters from <a href="https://github.com/swapagrawal14/rigpop-forge">Rigpop Forge</a>, every one castable as lead or puppet.</em>
</p>

## Why this exists

Making an animated video today looks like this:

> script → draw characters → rig them → learn animation software → keyframe for days → film

So almost nobody makes one. Teachers fall back to slides, clinics to pamphlets,
creators to yet another talking-head video — if they show their face at all.

Rangmanch deletes the middle:

> **open phone → act → film**

The builder is user #1: Swapnil makes dental-education and client videos for a
living. Her last 2:51 family cartoon took a full day of pose-normalising and
hand-correcting 20 mouth anchors in a renderer. Rangmanch turns that day into
minutes of acting — and hands the same superpower to every teacher, clinician
and camera-shy creator who can act but cannot animate.

## How a performance works

<p align="center">
  <img src="docs/assets/pose-strip.png" alt="Lead actor poses — base, wave, point, open, thumbs" width="820">
  <br><em>The lead's own artwork (Rigpop Forge pose set). Since v0.4 the live performance is skeletal — these poses are the art the puppet is cut from, not frames it swaps between.</em>
</p>

| You do this | The stage does this |
|---|---|
| Wave, dance, crouch, lean, walk | The lead's arms, torso and head follow **your** skeleton, bone by bone — it is not swapping pose pictures, it is wearing your movement |
| Turn your head / look up or down | The lead's head turns and tilts with yours (its own head piece, foreshortened as it turns) |
| Open your mouth / make an O / smile / laugh | Lead's mouth becomes **A / O / E** — laugh gets the big grin — the Rigpop Talk patches, composited live |
| Blink | Lead blinks |
| Stand in front of the camera | You are never shown: your room blurs into backdrop colour and the character replaces you completely, at your size |
| Tick *Co-actors*, raise a hand | A full-size co-actor walks onto the stage floor on that side (off by default — the stage is yours alone) |
| Move your hand around | The co-actor walks with it |
| Pinch thumb + finger | The co-actor talks (its O-mouth fires) |
| Type a caption, hit Record | Film + your mic voice record together, caption burned in |
| Switch to 9:16 | Same stage, vertical — ready for Reels / Shorts |

<p align="center">
  <img src="docs/assets/face-strip.png" alt="Face patches — A, O, E, blink" width="760">
  <br><em>Your face is the lead's face: these four tiles are driven by MediaPipe face blendshapes, live.</em>
</p>

## Under the hood

```
Camera + Mic ──► MediaPipe Tasks Vision (WASM, GPU→CPU fallback, lite models)
                   ├─ PoseLandmarker   33 pts        ─┐
                   ├─ HandLandmarker   2 × 21 pts    ─┼─► Retargeting
                   └─ FaceLandmarker   52 blendshapes─┘    ├─ body → live puppet rig (bone-by-bone)
                                                            ├─ hands → co-actor entrance/walk, pinch = talk
                                                            └─ face  → A/O/E mouths + blink
Characters ────► Rigpop Forge packs, consumed as-is
                 (character.rigpop.json: base + gesture poses + A/O/E/blink patch tiles)
Stage ─────────► <canvas>: mirrored camera feed as the room, floor shadows, captions
Film ──────────► canvas.captureStream(30) + mic track → MediaRecorder → download
```

Engineering choices that matter:

- **On-device everything.** Pose, hand and face models run in the browser.
  No uploads, no API keys, no per-clip credits — and characters stay
  *consistent*, unlike text-to-video generators that redraw them every clip.
- **Smoothing, not rawness.** Landmarks are exponentially smoothed before
  retargeting, so characters glide instead of jittering.
- **Staggered inference, quality toggle.** High mode runs pose every frame;
  Balanced mode spreads the three models thinner for low-end phones.
- **A puppet cut from the art itself.** Earlier versions swapped canned pose
  images — and felt dead. Now, when a humanoid pack is cast as lead, the app
  cuts its arms out of the base artwork in the browser (feathered strips along
  the arm bones, holes filled by smearing neighbouring hair/dress pixels) and
  re-poses them from your skeleton every frame. The torso, head and dress ride
  your torso's position, tilt and scale; mouth/blink tiles ride the same
  transform, so the face never drifts.
- **Never a blank screen.** Demo Mode drives the whole cast with synthetic
  landmarks, so anyone (including judges) can see it without a camera.
- **Lazy cast loading.** Only your three chosen characters download; swapping
  cast mid-session fetches just that pack.

## Run it

```bash
python3 -m http.server 8642
# open http://localhost:8642  (camera needs localhost or any https host — e.g. the Vercel deployment)
```

No build step, no dependencies to install. Press **Demo Mode** first if you
have no camera handy.

## Hackathon notes

Built for **Build Your First AI App 2026** (Devpost, deadline 27 Nov 2026) by
[Swapnil Agrawal](https://github.com/swapagrawal14) — dentist, author, and the
human behind the Rigpop doodle-video ecosystem.

**Disclosures.** The character packs and the `character.rigpop.json` format
come from [Rigpop Forge](https://github.com/swapagrawal14/rigpop-forge) and
pre-date this hackathon; character art is AI-generated through the Forge
pipeline. Rangmanch itself — tracking, retargeting, AR stage, recording — is
new work for this event. Tracking models are Google's MediaPipe models, run
on-device.

**Not to be confused with Doodle Mirror** (Swapnil's separate Kiroween entry):
there, *you become* the doodle. Here, you are the **director and every actor**,
and the output is a film.

Full architecture, phase plan and submission checklist: [PLAN.md](PLAN.md).
README visuals are generated from the packs' real art by
[docs/brand/build-assets.py](docs/brand/build-assets.py).

## Roadmap

- [x] v0.1 — pose + hands + face tracking, body-part casting, recording
- [x] v0.2 — theatre-grade UI (marquee, curtains, casting cards, playbill)
- [x] v0.3 — all 16 packs, smoothing, quality toggle, 9:16 reel mode, captions, record timer + retake
- [x] v0.4 — **You Become the Character**: live puppet rig (bone-by-bone conversion, no pose swaps), full-size stage co-actors conducted by your hands, all-English UI
- [x] v0.5 — **Total Replacement**: raw camera self is never drawn (room becomes blurred backdrop colour), character sized to fully cover you, separate head piece that turns/tilts with your gaze, laugh-sensitive mouth, co-actors off by default
- [ ] Per-character voice pitch for takes, scene list / multi-take editor
- [ ] Vendored models for a fully offline build
- [ ] The demo reel: *Germ vs Toothbrush*, performed entirely inside Rangmanch

## License

MIT — see [LICENSE](LICENSE). Character packs remain works of their Rigpop
Forge authors, as recorded in each pack's `character.rigpop.json`.
