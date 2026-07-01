# RiderLens MVP

RiderLens is a mobile bike-technique coach. The goal is to help riders record or upload short side-view clips, analyze simple jump performance, and build a personal library of riding sessions, reference clips, bike setup notes, and practical tools.

The first product focus is regular jump analysis. The app should help a rider understand takeoff, body position, bike pitch, landing posture, and common mistakes without pretending to replace a real coach or guarantee safety.

## MVP Proposal

The MVP is intentionally narrow:

- Start with regular jumps before adding scrubs, turns, wheelies, manuals, drops, or other skills.
- Use uploaded or recorded video files for real analysis because MediaPipe needs access to actual frames.
- Save YouTube and other external links as reference material only.
- Use a small Python/FastAPI worker for MediaPipe and OpenCV processing instead of doing heavy computer vision inside Expo.
- Keep manual calibration available because bike landmarks and floor/landing lines are hard for general pose models.
- Build a future-ready reference library for good jumps, bad jumps, and classic mistakes, even if the first analysis model is rule-based.

## Current Implementation

Implemented in the Expo app:

- Coach tab with Record and Upload actions.
- Pre-upload clip review with trim window controls and crop/framing presets.
- Uploaded clip persistence in the local app video library.
- FastAPI MediaPipe worker integration for uploaded regular-jump clips.
- Local fallback analysis plus manual frame calibration when the worker is unavailable or geometry is uncertain.
- Analysis preview with video frame background, pose/geometry overlays, frame time, confidence state, and key metric tiles.
- Sessions tab with saved uploaded analyses and reference links.
- External video links saved as reference-only sessions. They do not create fake automatic geometry.
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

- YouTube/web links are useful as references, but they do not provide raw frame access to the app.
- A YouTube URL can be saved in Sessions and opened later.
- Automatic floor/tire/body/landing detection requires the original video file or an authorized direct video file URL.

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
src/screens/SessionsScreen.tsx  Saved analyses and reference links
src/screens/GarageScreen.tsx    Bike setup and garage data
src/screens/ToolsScreen.tsx     Inclinometer and setup tools
src/hooks/useRiderLensMvp.ts    Local MVP state, session flow, worker integration
src/services/analysis.ts        Session creation, local fallback metrics, reports, link helpers
src/services/analysisWorker.ts  Mobile client for the FastAPI worker
src/services/videoLibrary.ts    Local video persistence
src/theme/tokens.ts             Locked visual tokens and numeric typography
worker/app/main.py              FastAPI MediaPipe/OpenCV analysis worker
worker/README.md                Worker setup and endpoint notes
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

- Current product & technical plan (roadmap, MediaPipe Tasks migration, rider measurements): `riderlens-product-plan.md`
- Original product scope, risks, data model, and visual system: `bike-technique-app-prerequisites.md`
- Worker details: `worker/README.md`
- Garage setup-sheet visual reference: `garage-setup-sheet.html`
- Current app color/component reference: `index-electric.html`
