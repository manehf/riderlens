# RiderLens MVP

RiderLens is a mobile bike-technique coach. The goal is to help riders record or upload short side-view clips, analyze simple jump performance, and build a personal library of riding sessions, reference clips, bike setup notes, and practical tools.

The first product focus is regular jump analysis. The app should help a rider understand takeoff, body position, bike pitch, landing posture, and common mistakes without pretending to replace a real coach or guarantee safety.

## MVP Proposal

The MVP is intentionally narrow:

- Start with regular jumps before adding scrubs, turns, wheelies, manuals, drops, or other skills.
- Use uploaded or recorded video files for real analysis because MediaPipe needs access to actual frames.
- Analyze uploaded or recorded clips only. External video links (YouTube etc.) were removed from the MVP to keep it simple; a future ingestion path may support authorized direct video-file URLs.
- Use a small Python/FastAPI worker for MediaPipe and OpenCV processing instead of doing heavy computer vision inside Expo.
- Keep manual calibration available because bike landmarks and floor/landing lines are hard for general pose models.
- Build a future-ready reference library for good jumps, bad jumps, and classic mistakes, even if the first analysis model is rule-based.

## Current Implementation

Implemented in the Expo app (capture-first — see `riderlens-product-plan.md`):

- Capture tab: record live or pick from the photo library.
- Window step: AI-proposed trim (worker + Claude) with silent timeout fallback to manual start/end controls, over on-device thumbnails.
- Records: the worker crops the moment (FFmpeg), measures pose on every frame in the window, and the app stores the trimmed clip + key frames with skeleton overlays + filmstrip + timeline curves on-device.
- Offline-tolerant: when processing fails, the record stays pending with a retry — capture never blocks on connectivity.
- History tab: all records with status, review, share (native share sheet with the clip), and delete.
- Garage tab with bike setup, suspension settings, cockpit/tire/service data, and shareable setup-sheet text.
- Tools tab with inclinometer/level, calibration, saved measurements, and sag calculator.
- Supabase schema draft in `supabase/schema.sql`.
- Electric green / graphite / cyan visual system from `index-electric.html`.
- IBM Plex Sans for UI and IBM Plex Mono with tabular numbers for metrics and measurements.

Implemented in the worker:

- `POST /analysis/regular-jump` multipart upload endpoint.
- OpenCV frame sampling within the selected trim window.
- MediaPipe Pose detection for rider body landmarks.
- Regular-jump phase selection: approach, compression, takeoff, air, landing.
- Body angle output, normalized overlay geometry, confidence values, and basic coaching notes.
- Legacy `/jobs/{job_id}/analyze` route kept for later Supabase job processing.

## Important Constraints

External links:

- The app analyzes uploaded or recorded video files only. There is no YouTube/link flow.
- Automatic floor/tire/body/landing detection requires the original video file or, in the future, an authorized direct video file URL.

MediaPipe:

- MediaPipe Pose detects the rider body, not bike-specific landmarks.
- Floor, tire baseline, and landing alignment are still heuristic and may need manual calibration.
- The MVP should treat low-confidence analysis as directional coaching, not as a final truth.

Filming:

- Best results come from 3 to 10 second side-view clips.
- Keep the whole rider, bike, takeoff, and landing visible.
- Use stable framing and good light.
- Avoid shaky, dark, heavily cropped, or zoomed-in clips.

Safety:

- RiderLens feedback is educational only.
- Bike skills involve risk; riders should practice within their ability and use protective gear.

## Project Structure

```text
App.tsx                         Expo app shell and tabs
src/screens/CoachScreen.tsx     Record/upload, clip review, analysis preview, calibration
src/screens/SessionsScreen.tsx  Saved analyses
src/screens/GarageScreen.tsx    Bike setup and garage data
src/screens/ToolsScreen.tsx     Inclinometer and setup tools
src/hooks/useRiderLensMvp.ts    Local MVP state, session flow, worker integration
src/services/analysis.ts        Session creation, calibration frames, reports, geometry math
src/services/analysisWorker.ts  Mobile client for the FastAPI worker
src/services/videoLibrary.ts    Local video persistence
src/theme/tokens.ts             Locked visual tokens and numeric typography
worker/app/main.py              FastAPI MediaPipe/OpenCV analysis worker
worker/app/dev.html             Browser Analysis Lab at /dev (dev tool, annotated frames)
worker/scripts/analyze_clip.sh  Run a reference clip through the worker from the CLI
worker/README.md                Worker setup and endpoint notes
clips/                          Reference clip library for development/validation
supabase/schema.sql             Planned backend database/storage schema
```

## Local App Setup

Use Node 22 for this project.

```bash
npm install
npm run start
```

Useful commands:

```bash
npm run ios
npm run android
npm run typecheck
```

Environment variables:

```bash
EXPO_PUBLIC_SUPABASE_URL=
EXPO_PUBLIC_SUPABASE_ANON_KEY=
EXPO_PUBLIC_ANALYSIS_WORKER_URL=
```

The app runs in demo mode with local persistence when Supabase is not configured.

## MediaPipe Worker Setup

```bash
cd worker
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Health check:

```bash
curl -sS http://127.0.0.1:8000/health
```

For the iOS Simulator on the same Mac:

```bash
EXPO_PUBLIC_ANALYSIS_WORKER_URL=http://127.0.0.1:8000
```

For a physical phone, use the Mac's LAN IP:

```bash
EXPO_PUBLIC_ANALYSIS_WORKER_URL=http://YOUR_COMPUTER_LAN_IP:8000
```

After changing `.env`, restart Expo:

```bash
npx expo start --clear
```

Keep only one `EXPO_PUBLIC_ANALYSIS_WORKER_URL` line in `.env`.

## Design System

The current visual source of truth is `index-electric.html`.

Locked MVP direction:

- Electric green: `#B6FF2E`
- Graphite: `#111613`
- Dark surface: `#171D19`
- Background: `#F5F7F1`
- Surface: `#FFFFFF`
- Primary text: `#101411`
- Muted text: `#60685F`
- Border: `#DDE3DA`
- Deep green: `#2E7D32`
- Analysis cyan: `#00B8D9`
- Warning amber: `#E19A00`
- Error red: `#D64545`

Use electric green for primary actions and scan states, graphite for video/analysis surfaces, cyan for measured pose/geometry overlays, and calm light surfaces for reports, garage, forms, and share sheets.

## Not Implemented Yet

- Production Supabase auth/storage persistence wired into app flows.
- Deployed analysis worker.
- Annotated video export.
- Direct `.mp4` URL ingestion endpoint.
- YouTube video download/ingestion.
- Custom bike keypoint model for wheels, frame, floor, and landing.
- Reference-library comparison engine for good jumps and classic mistakes.
- Bunnyhop, manual, wheelie, turn, scrub, and drop-specific analysis models.
- Account deletion, video deletion, and production privacy flows.

## Product Docs

- Current product & technical plan (capture-first: find the moment, crop, pose overlay, tag, share): `riderlens-product-plan.md`
- Reference clip library conventions and CLI testing: `clips/README.md`
- Original product scope, risks, data model, and visual system: `bike-technique-app-prerequisites.md`
- Worker details: `worker/README.md`
- Garage setup-sheet visual reference: `garage-setup-sheet.html`
- Current app color/component reference: `index-electric.html`
