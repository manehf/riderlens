# RiderLens Analysis Worker

FastAPI MediaPipe/OpenCV worker for the RiderLens regular-jump MVP.

The worker exists because Expo should not do heavy video processing on-device for the first MVP. The rider chooses the jump range locally, then the mobile app posts the source and selected timestamps when `EXPO_PUBLIC_ANALYSIS_WORKER_URL` is set. If the worker is unavailable, the app keeps the record queued for retry.

## Scope

Implemented:

- Receive uploaded regular-jump video files from the mobile app.
- Canonicalize phone orientation metadata into upright H.264 pixels exactly once.
- Respect the rider-selected trim window (0.5–8 seconds).
- Sample frames with OpenCV.
- Run MediaPipe Pose on sampled frames.
- Pick approach, compression, takeoff, air, and landing frames.
- Return body angles, normalized overlay geometry, confidence, and coaching notes.
- Publish versioned, non-enumerable share packages to Supabase Storage.

Not implemented:

- Production job queue.
- Supabase Storage analysis-job download/upload loop.
- Annotated video export.
- Direct external URL ingestion.
- YouTube video ingestion.
- Custom bike landmark detection.

## Run Locally

```bash
cd worker
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

If file-watcher issues appear locally, run without `--reload`.

Health check:

```bash
curl -sS http://127.0.0.1:8000/health
```

Expected response:

```json
{
  "ok": true,
  "service": "riderlens-worker",
  "mediapipe": true,
  "opencv": true
}
```

## Connect The Expo App

For iOS Simulator on the same Mac:

```bash
EXPO_PUBLIC_ANALYSIS_WORKER_URL=http://127.0.0.1:8000
```

For a physical phone:

```bash
EXPO_PUBLIC_ANALYSIS_WORKER_URL=http://YOUR_COMPUTER_LAN_IP:8000
```

The phone and computer must be on the same network, and the worker must bind to `0.0.0.0`.

Keep only one `EXPO_PUBLIC_ANALYSIS_WORKER_URL` line in `.env`, then restart Expo:

```bash
npx expo start --clear
```

## Main Endpoint

```http
POST /analysis/regular-jump
Content-Type: multipart/form-data
```

Fields:

```text
video=<file>
session_id=session-...
trim_start_seconds=0
trim_end_seconds=8
crop_preset=full_side_view
```

Response:

- `status`
- `metrics[]`
- `metrics[].phase`
- `metrics[].frameTime`
- body angles: torso, hip, knee, elbow
- bike/floor/landing angles where available
- `geometrySource`
- normalized `geometry` lines for overlays
- `confidence`
- `report`

## Legacy Endpoint

The worker keeps:

```http
POST /jobs/{job_id}/analyze
```

This is for the later Supabase job architecture, where a backend worker downloads videos from Storage and updates database rows. The current mobile MVP uses `/analysis/regular-jump` directly.

## Share Endpoint

```http
POST /share
Content-Type: multipart/form-data
```

Released clients can keep sending the legacy form:

```text
video=<clip.mp4>
airtime_seconds=0.82        # optional
height_meters=0.82          # optional
rider_name=Alex             # optional, mapped to sharedByName
```

The enriched form used by the account-free share/import flow is:

```text
clean_video=<clean.mp4>
skeleton_video=<skeleton.mp4>  # optional
poster=<poster.jpg>             # optional; worker generates one when absent
detail=<detail.json>            # required; series + filmstrip arrays
skill_type=regular_jump
flight_json=<FlightEstimate JSON>  # optional
events_json=<CaptureEvent[] JSON>  # optional
shared_by_name=Alex               # optional
```

Both forms create `meta.json` using `ShareManifestV1`. Enriched shares store
`clean.mp4`, optional `skeleton.mp4`, `poster.jpg`, and `detail.json`; legacy
shares retain `clip.mp4` so deployed clients remain compatible. Share IDs and
delete tokens carry 128 bits of entropy. Only a SHA-256 hash of the delete token
is stored in `control.json`.

Response:

```json
{
  "id": "unguessable-share-id",
  "shareUrl": "https://s.riderlens.app/unguessable-share-id",
  "deleteToken": "sender-only-delete-token",
  "schemaVersion": 1
}
```

The sender must persist `deleteToken` locally when the mobile integration lands;
it cannot be recovered from storage. Default share limits are 128 MB per video,
10 MB for the poster, 32 MB for detail JSON, and 15 seconds per stored video.
They can be overridden with `RIDERLENS_MAX_SHARE_VIDEO_BYTES`,
`RIDERLENS_MAX_SHARE_POSTER_BYTES`, `RIDERLENS_MAX_SHARE_DETAIL_BYTES`, and
`RIDERLENS_MAX_SHARE_DURATION_SECONDS`.

## External Link Limitation

The worker analyzes uploaded files, not YouTube or generic web pages.

External links can be stored by the mobile app as reference sessions, but they should not be sent to this worker unless they are direct, authorized video-file URLs supported by a future ingestion endpoint.

## Geometry Quality Notes

Bike geometry uses a detection ladder, most-trusted first:

1. **Bike bounding box** — MediaPipe Object Detector (EfficientDet-Lite2, COCO `bicycle` class). The model (~7 MB) downloads automatically into `worker/models/` on first use; `/health` reports `bike_detector_model`. Wheels are placed in the lower box corners and refined with a circle search; the box bottom anchors the floor line at tire contact.
2. **Pose-anchored estimate** — wheel positions predicted from body scale and facing direction (feet sit near the bottom bracket, which shares a height line with the hubs). Used when no bike box is found; refinement is skipped when pose confidence is low.

`geometrySource` is `detected` only when both wheels are pair-confirmed by the circle search plus a second pixel-grounded signal (bike box or a real floor edge). Everything else is honestly labeled `estimated`. Manual calibration in the app remains the override for hard frames (blur, occlusion, pitched bike in the air).

Best clips:

- 3 to 10 seconds.
- Side view.
- Rider and bike fully visible.
- Good light.
- Stable camera.
- Takeoff and landing visible.

## Dev Analysis Lab

With the worker running, open the browser dashboard:

```text
http://127.0.0.1:8000/dev
```

It lists the `clips/` library, lets you upload any video, set the trim window, and shows the analyzed key frames with the geometry lines drawn on the real pixels, plus the metrics table and report. This is the fastest way to iterate on analysis quality — no phone involved. The overlays are drawn from the same normalized geometry JSON the mobile app consumes.

It is a dev tool only: plain styling on purpose, enabled by default locally, disable with `RIDERLENS_DEV_UI=0` (keep it disabled on any deployed worker).

## AI Review (Claude)

The Analysis Lab has an "AI review" button that sends the analyzed key frames plus the measured metrics to the Claude API (`claude-opus-4-8` by default, override with `RIDERLENS_AI_MODEL`). The model describes what actually happens in each frame, validates the pipeline's phase labels, detects crashes, and writes a coaching summary from visual understanding.

Requires credentials — start the worker with an API key:

```bash
ANTHROPIC_API_KEY=sk-ant-... RIDERLENS_SNAPSHOT_DIR=./snapshots uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Without a key the endpoint returns a clear 503 and everything else keeps working. Cost is roughly a cent or two per review (five 720p frames + a structured response).

## Coaching Knowledge Base

`app/knowledge/regular_jump.md` is distilled from the coaching transcripts in `how_to_jump/` and is injected into both AI prompts (keyframe search and review). It defines correct technique per phase with visual cues, named mistakes with their visual signatures (dead sailor, nose dive, spud hop, ...), frame-selection guidance, and coaching voice. Regenerate after adding transcripts:

```bash
.venv/bin/python scripts/distill_knowledge.py
```

## Debug Snapshots

Set `RIDERLENS_SNAPSHOT_DIR` to archive every analysis (request metadata + full response JSON) for debugging real clips:

```bash
RIDERLENS_SNAPSHOT_DIR=./snapshots uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Each analysis writes `<utc-timestamp>-<session-id>.json` into that directory. Leave the variable unset to disable (default). Snapshot failures never fail an analysis.

## Tests

```bash
pip install -r requirements-dev.txt
python -m pytest tests/
```

The geometry tests share fixture values with the app's vitest suite (`tests/fixtures/geometry.json` at the repo root) so the duplicated TypeScript/Python angle math cannot drift.

## Optional Supabase Variables

These are reserved for the later Storage/job flow:

```bash
SUPABASE_URL=
SUPABASE_SECRET_KEY=
```

The worker also accepts the legacy `SUPABASE_SERVICE_ROLE_KEY` during migration,
but new deployments should use a scoped `sb_secret_...` key.

## Deploy (Fly.io)

The worker ships as a container (`Dockerfile` + `fly.toml`, both in this directory). One-time setup:

```bash
brew install flyctl && fly auth signup     # or: fly auth login
cd worker
fly launch --copy-config --no-deploy      # accepts fly.toml; pick/confirm the app name
fly secrets set ANTHROPIC_API_KEY=sk-ant-...
fly deploy                                 # remote build — no local Docker needed
curl https://riderlens-worker.fly.dev/health
```

Then point the app at it in `.env`:

```
EXPO_PUBLIC_ANALYSIS_WORKER_URL=https://riderlens-worker.fly.dev
```

URL resolution in the app: the dev bundler host (your Mac) is probed first, the deployed URL second — so local development keeps using the LAN worker for free, and phones away from your network fall through to Fly automatically. Machines scale to zero when idle; the app's health pre-flight plus the retry queue absorb cold starts.

Notes:
- The dev Analysis Lab (`/dev`) is disabled on the deployment (`RIDERLENS_DEV_UI=0`).
- Watch per-record Anthropic cost in the dashboard; the cheaper-model test and the local window detector (product plan §7) are the cost path.
- If long clips ever hit proxy timeouts on `/capture/record`, bump the VM size before reaching for async job queues.
