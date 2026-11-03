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

Stand in front of your phone. Your **body** becomes the lead actor, your **left
and right hands** become two puppet co-stars, and your **face** drives the lead's
mouth and blinks — all of them live doodle characters standing in AR on your
real table, in your real room. Hit record, perform the scene in your own voice,
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
</p>

| You do this | The stage does this |
|---|---|
| Stand, move, walk | Lead character anchors to your hips, scales and tilts with your body |
| Raise one hand | Lead swaps to the **wave** pose |
| Raise both hands | **Open** pose |
| Stretch an arm out | **Point** pose |
| Open your mouth / make an O / smile | Lead's mouth becomes **A / O / E** — the Rigpop Talk patches, composited live |
| Blink | Lead blinks |
| Bring a hand near the camera | That hand is now a puppet character — tilt it, move it |
| Pinch thumb + finger | The puppet talks (its O-mouth fires) |
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
                   └─ FaceLandmarker   52 blendshapes─┘    ├─ body → anchor/tilt/gesture-pose swap
                                                            ├─ hands → puppet pos/tilt, pinch = talk
                                                            └─ face  → A/O/E mouths + blink (per-pose anchors)
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
- **Per-pose face anchors.** Mouth/blink tiles are placed by each pose's own
  anchors (where the pack provides them), so the mouth doesn't drift when the
  pose changes — a lesson bought with a full day on the family pilot.
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
- [ ] Per-character voice pitch for takes, scene list / multi-take editor
- [ ] Vendored models for a fully offline build
- [ ] The demo reel: *Germ vs Toothbrush*, performed entirely inside Rangmanch

## License

MIT — see [LICENSE](LICENSE). Character packs remain works of their Rigpop
Forge authors, as recorded in each pack's `character.rigpop.json`.
