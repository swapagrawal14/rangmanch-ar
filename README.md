# Rangmanch AR 🎭

**Act karo, animate mat karo.** A one-person cartoon studio for the
*Build Your First AI App 2026* hackathon (Devpost, deadline 27 Nov 2026).

Stand in front of your phone camera. MediaPipe tracks your **body (33 pose
points), both hands (2 × 21 points) and face (blendshapes)** — entirely
on-device — and casts each body part as a different live doodle character in
AR over your real room:

- Your **body** performs as the main character (gestures swap Rigpop poses)
- Your **left and right hands** become two puppet characters (pinch = they talk)
- Your **face** drives the main character's mouth (A/O/E) and blinks

Hit record, act the scene out with your own voice, download the film.
No drawing, no animation software, no face-cam, no server, no uploads.

## Run it

```bash
python3 -m http.server 8642
# open http://localhost:8642  (camera needs localhost or https)
```

Try **Demo Mode** first if you have no camera handy.

## Tech

- MediaPipe Tasks Vision (Pose / Hand / Face Landmarkers, lite models, WASM + GPU)
- Characters: [Rigpop Forge](https://github.com/swapagrawal14/rigpop-forge) packs,
  consumed as-is (`character.rigpop.json` — talk base, A/O/E/blink patch tiles, gesture poses)
- AR stage: mirrored camera feed + canvas compositing, floor shadows
- Recording: `canvas.captureStream` + mic → `MediaRecorder`

Full architecture, build phases and submission checklist: see **PLAN.md**.

Cast bundled in v0.1: Swapnil (body), Mocha the Cat (left hand), Bunty the Bot (right hand).
Art is AI-generated via the Forge pipeline; tracking models are Google's MediaPipe models.
