# RiderLens Reference Clip Library

Development library of real riding clips used to test and validate the analysis pipeline. This is the seed of the validation set described in `riderlens-product-plan.md`: analysis changes should be checked against these clips before they ship.

## Layout

```text
clips/
  manifest.json            One entry per clip: skill, label, metadata, notes
  <skill>/                 regular_jump, later bunnyhop, drop, manual, ...
    good/                  Clean examples of the skill
    fail/                  Mistakes worth detecting
```

## Conventions

- Keep clips short and light: 3–10 seconds, 720p is enough, side view, whole rider and bike visible. Re-encode longer phone videos before adding them.
- Small clips are committed to git on purpose so the validation set travels with the code. If the library outgrows ~100 MB total, move video files to Git LFS or external storage and keep only `manifest.json` in git.
- Every clip gets a `manifest.json` entry. The `notes` field should say what actually happens in the clip ("nose drop after takeoff", "clean tabletop, good compression") — these notes become the ground-truth labels for the future comparison engine.
- Useful fail sub-labels to collect over time: nose drop, dead sailor, stiff landing, poor compression, off-axis landing, arms-first extension.

## Run a clip through the worker

With the worker running locally (`uvicorn app.main:app --host 0.0.0.0 --port 8000` in `worker/`):

```bash
worker/scripts/analyze_clip.sh clips/regular_jump/fail/jump_fail.mp4
```

Optional trim window and worker URL:

```bash
worker/scripts/analyze_clip.sh clips/regular_jump/fail/jump_fail.mp4 1.0 7.5 http://127.0.0.1:8000
```

Start the worker with `RIDERLENS_SNAPSHOT_DIR=./snapshots` to also archive every request/response for later comparison.

## Test on the phone or simulator

- iOS Simulator: drag a clip onto the simulator window to add it to Photos, then use Upload in the app.
- Physical phone: AirDrop (iOS) or file transfer (Android) the clip into the photo library.
