# RiderLens Analysis Worker

FastAPI MediaPipe/OpenCV worker for the RiderLens regular-jump MVP.

The worker exists because Expo should not do heavy video processing on-device for the first MVP. The mobile app posts uploaded clips to this service when `EXPO_PUBLIC_ANALYSIS_WORKER_URL` is set. If the worker is unavailable, the app falls back to local placeholder metrics and manual calibration.

## Scope

Implemented:

- Receive uploaded regular-jump video files from the mobile app.
- Respect the selected trim window.
- Sample frames with OpenCV.
- Run MediaPipe Pose on sampled frames.
- Pick approach, compression, takeoff, air, and landing frames.
- Return body angles, normalized overlay geometry, confidence, and coaching notes.

Not implemented:

- Production job queue.
- Supabase Storage download/upload loop.
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
trim_end_seconds=6
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

## External Link Limitation

The worker analyzes uploaded files, not YouTube or generic web pages.

External links can be stored by the mobile app as reference sessions, but they should not be sent to this worker unless they are direct, authorized video-file URLs supported by a future ingestion endpoint.

## Geometry Quality Notes

MediaPipe Pose detects rider body landmarks. It does not detect bike wheels, frame tubes, the takeoff lip, or the landing slope as first-class landmarks.

Current floor, tire baseline, and landing geometry is heuristic. The app keeps manual calibration because those lines can be wrong depending on camera angle, shadows, trees, background edges, wheel blur, and occlusion.

Best clips:

- 3 to 10 seconds.
- Side view.
- Rider and bike fully visible.
- Good light.
- Stable camera.
- Takeoff and landing visible.

## Optional Supabase Variables

These are reserved for the later Storage/job flow:

```bash
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
```
