# RiderLens Product & Technical Plan v2

Status date: July 2, 2026.
Supersedes the roadmap sections of `bike-technique-app-prerequisites.md` (which stays as the original scope/design reference). The design system, safety rules, and filming guidance in that document remain valid.

## 1. Vision

RiderLens is a mobile riding coach and bike-setup companion built on three pillars that feed each other:

1. **Skill analysis** — record/upload short clips, get honest, measured feedback. Regular jumps first; bunnyhops, drops, manuals, wheelies, and eventually scrubs/whips later.
2. **Rider tools** — suspension setup, inclinometer/level, sag, setup sheets shared with friends, coaches, shops, and mechanics.
3. **Rider data** — per-user body measurements (height, inseam, arm length, shoulder width, RAD) and setup history that, with explicit consent, become an aggregate dataset for cross-rider insight.

The connective idea: **body measurements are not just profile data — they are the calibration layer for the computer vision.** A known inseam plus MediaPipe world landmarks gives real-world scale, which upgrades the analysis from "angles only" to real distances and heights. The same measurements power bike-fit tools (RAD calculator) and, aggregated, the future dataset. Every pillar makes the other two better.

## 2. Guiding principles

- **Never fake analysis.** No placeholder metrics presented as measurements. If the worker fails, the session says so and offers manual calibration — it does not invent numbers. (This fixes the current local-fallback behavior.)
- **Angles and timing before absolute distances.** Joint angles, phase timing, and airtime are camera-independent and trustworthy today. Absolute distances arrive only when scale calibration (via body measurements) is reliable.
- **Confidence is a first-class output.** Every metric carries a measured confidence; low-confidence output is presented as directional, and the geometry source label (detected / estimated / manual) must always be truthful.
- **Consent before data.** Body measurements and ride video are personal data. Aggregate analytics is opt-in, anonymized, and deletable from day one — not retrofitted.
- **One skill done honestly beats five skills done approximately.** Each new skill ships only when its event detection (not just pose detection) works on a validation set of real clips.

## 3. Target architecture

```
┌─────────────────────────────┐
│ Expo app (React Native, TS) │
│  Coach / Sessions / Garage  │
│  / Tools / Profile          │
└──────────┬──────────────────┘
           │ upload video + metadata
┌──────────▼──────────────────┐     ┌───────────────────────────┐
│ Supabase                    │◄────┤ Python worker (FastAPI)   │
│  Auth · Postgres · Storage  │     │  MediaPipe Pose Landmarker│
│  analysis_jobs · Realtime   │     │  (Tasks API, VIDEO mode)  │
└─────────────────────────────┘     │  OpenCV · FFmpeg          │
                                    │  Phase/event detection    │
                                    │  Metrics · Report rules   │
                                    └───────────────────────────┘
```

- The app records/uploads to Supabase Storage, creates an `analysis_jobs` row, and subscribes to job status via Realtime (polling fallback).
- The worker pulls jobs, downloads the clip, analyzes, writes landmark series + metrics + report back, updates job status.
- Direct app→worker upload (the current MVP path) stays as a dev mode until the async pipeline ships, then is removed.

### 3.1 MediaPipe Pose Landmarker migration (Tasks API)

The current worker uses the legacy `mp.solutions.pose` Solutions API, which is deprecated. Migrate to the **Pose Landmarker task** (`mediapipe.tasks.python.vision.PoseLandmarker`):

- **Model:** `pose_landmarker_heavy.task` on the server (accuracy matters more than latency there); the `.task` model file is downloaded at deploy/build time and version-pinned.
- **Running mode:** `RunningMode.VIDEO` with `detect_for_video(mp_image, timestamp_ms)` so the tracker exploits temporal continuity instead of treating frames independently — meaningfully better on fast, blurred riders.
- **World landmarks:** use `pose_world_landmarks` (approximate metric 3D, hip-centered) for all joint angles — they are robust to camera zoom/position in a way normalized image coordinates are not. Keep normalized `pose_landmarks` only for drawing overlays.
- **Confidence:** derive per-frame confidence from landmark `visibility`/`presence` on the relevant side; keep the visible-side selection logic.
- **Smoothing:** apply a one-euro filter (or Savitzky-Golay) to the landmark time series before event detection; raw per-frame output is too jittery for reliable extrema detection.
- **Later, on-device:** the same task exists for Android/iOS (`pose_landmarker_lite.task`) — usable in a future Expo dev-build native module for an instant pre-upload check ("rider fully visible, side view?") before any bytes are uploaded. Not an MVP requirement; requires leaving Expo Go.

### 3.2 Analysis pipeline (per clip)

1. Decode + sample frames in the trim window (target ~15–30 samples/sec of the window, capped; store timestamps, not frame pixels — re-seek for the few frames the UI needs).
2. Pose Landmarker in VIDEO mode → landmark time series (image + world) with per-frame confidence.
3. Smooth the series; reject clips where the rider is detected in <60% of frames with actionable guidance ("rider leaves frame at 2.3s").
4. **Event detection from trajectories** (replaces the current fixed 12/32/48/66/86% ratios):
   - Hip-center vertical trajectory → compression (local dip), takeoff (sharp upward velocity onset), air apex (extremum), landing (impact + recovery). Ankle/foot trajectories confirm wheels-off/wheels-down.
   - Airtime = landing timestamp − takeoff timestamp → **center-of-mass rise estimate `h ≈ g·t²/8`** — a real, scale-free jump metric available before any calibration.
5. Compute per-phase metrics at the *detected* events: torso/hip/knee/elbow angles (from world landmarks), bike pitch (heuristic wheels or manual calibration), phase timing, extension velocity.
6. Rule-based report from measured values, gated by confidence.
7. Persist: landmark series (compressed JSON in Storage), per-phase `pose_metrics` rows, report, annotated key frames.
8. Every response snapshot is archived (dev flag) so heuristics can be improved against real clips.

### 3.3 Honesty fixes carried into the new pipeline (do these first, they're small)

- `geometry_source` must report `"estimated"` when tire-baseline detection fell back to the heuristic (currently hard-coded `"detected"` in `build_metric`).
- Remove fabricated fallback metrics in the app (`completeLocalAnalysis` with hard-coded angles at 0.76–0.83 confidence). Worker unreachable → session status `analysis_failed`, with retry + manual calibration offered.
- Replace simulated progress timers with real job status once the async pipeline exists; until then, label the indicator as indeterminate.

## 4. Rider profile & body measurements

### 4.1 What we store (all optional, all user-entered or user-approved)

| Measurement | Unit | Used for |
|---|---|---|
| Height | cm | normalization, analytics |
| Inseam | cm | **CV scale calibration**, RAD calculator, saddle height |
| Arm length (shoulder→grip axis) | cm | RAD calculator, cockpit fit |
| Shoulder width | cm | bar-width guidance |
| Torso length | cm | fit, normalization |
| Wingspan | cm | fit, normalization |
| Weight (with gear) | kg | suspension/sag, tire pressure |
| RAD (BB→grips, measured on bike) | cm | fit check vs. body-derived recommended RAD |
| Flexibility/injury notes | text | context for coaching tone (never medical advice) |

### 4.2 What measurements unlock, in order

1. **RAD calculator (pure tool, no CV):** from inseam + arm length, compute a recommended RAD range (e.g., Lee McCormack-style heuristics), compare against the measured bike RAD stored in Garage. Ships early — high perceived value, zero CV risk.
2. **Scale calibration for analysis:** known inseam + detected hip→ankle segment gives a px↔cm scale per clip, upgrading metrics from angles/ratios to real distances (compression depth in cm, pop height, effective RAD *while riding* vs. static RAD).
3. **Cross-user analytics (consent-gated):** with enough riders, correlate anthropometrics + setup + technique metrics (e.g., "riders whose bar height is X% of RAD show less nose-dive on takeoff"). This is the long-term moat; it only works if measurement capture is easy and trusted from the start.

### 4.3 Privacy requirements (non-negotiable, built with the profile feature)

- Explicit, versioned consent records; separate consents for (a) storing measurements, (b) cloud video processing, (c) anonymized aggregate research use. Each independently revocable.
- Account deletion and per-video deletion actually delete Storage objects and rows.
- Aggregate analytics only ever leaves the database as k-anonymous cohorts; raw measurements are never shared, including in setup sheets, unless the rider explicitly includes them.
- Shared setup links: tokenized, expiring, permission-scoped (view/comment/edit) — replacing today's plain-text share as the primary path (text export stays as a convenience).

## 5. Data model additions (Supabase)

Beyond the existing schema draft:

```
rider_profiles        user_id, height_cm, inseam_cm, arm_length_cm, shoulder_width_cm,
                      torso_length_cm, wingspan_cm, weight_kg, rad_measured_cm,
                      notes, updated_at
consents              id, user_id, consent_type, version, granted, granted_at, revoked_at
landmark_series       id, session_id, storage_path, fps, frame_count, model_version,
                      mean_confidence, created_at
analysis_events       id, session_id, event_type (compression|takeoff|apex|landing|...),
                      time_seconds, confidence
reference_clips       id, skill_type, label (good|nose_drop|dead_sailor|stiff_landing|...),
                      storage_path, landmark_series_id, notes, curated_by, created_at
skill_norms           skill_type, metric_name, phase, p25, p50, p75, cohort, updated_at
```

`pose_metrics` gains `session_user_scale_cm_per_unit` (nullable) once scale calibration exists, so every stored metric records whether it was scale-calibrated.

## 6. Skill expansion order (and why)

Each skill ships only when event detection validates on ≥20 curated real clips.

1. **Regular jump** (now) — side view, short clip, trajectory events. The template for everything else.
2. **Bunnyhop** — same filming, same pipeline; new events (front-wheel lift → rear-wheel lift → apex → landing) detectable from ankle/hip trajectories. Mostly reuses jump code.
3. **Drop** — jump variant: no compression lip, focus on takeoff posture, in-air pitch, landing absorption. Small delta on the jump model.
4. **Manual / wheelie** — different shape: long clips (10–30s+), balance-over-time analysis (front-wheel height stability, hip position band, correction frequency, time-in-balance). Needs the time-series infrastructure, which the landmark-series storage already provides.
5. **Cornering / pump track** — side or three-quarter view, body-lean and pressure-timing metrics; medium difficulty.
6. **Scrub / whip** — explicitly last: side view is insufficient (roll/yaw), needs multi-angle or sensor fusion. Do not attempt until there is either multi-view support or bar/frame IMU data.

A **custom bike keypoint model** (wheels, BB, bars, frame) stays on the roadmap but is deliberately deferred until the reference library has produced enough labeled frames — the manual-calibration flow doubles as the labeling tool (every user correction is a training label, consent permitting).

## 7. Build order

### Phase 0 — Foundation hygiene (days)
1. `git init`, first commit, `.gitignore` for `.venv`/`node_modules`/`.env`.
2. Fix `geometry_source` honesty bug in the worker.
3. Remove fabricated local-fallback metrics; add `analysis_failed` state + retry UX.
4. Unit tests for the pure geometry math (TS and Python, same fixture values so the duplicated implementations can't drift).
5. Worker response snapshot logging behind a dev flag.

### Phase 1 — Make jump analysis real (weeks)
6. Migrate worker to Pose Landmarker Tasks API (VIDEO mode, heavy model, world landmarks, smoothing). Keep API response shape stable for the app.
7. Trajectory-based event detection + airtime/COM-rise metrics; replace fixed-ratio phases.
8. Clip quality gate with actionable rejection messages.
9. Validation set: 20–30 real jump clips (good + classic mistakes), scripted regression run comparing detected events vs. hand-labeled truth. This set is the bar every worker change must clear.

### Phase 2 — Accounts, backend, deployed worker (weeks)
10. Supabase Auth + Storage + RLS; sessions/videos/jobs move server-side; demo mode remains for signed-out use.
11. Async job pipeline (Storage upload → job row → worker pull → Realtime status), replacing direct upload and simulated progress.
12. Deploy the worker (Fly.io/Railway/Render, CPU is fine for heavy-model VIDEO mode at these clip lengths).
13. Account deletion + video deletion + consent records.

### Phase 3 — Rider profile & measurement-powered tools (weeks, parallel-friendly with Phase 2)
14. Profile screen: body measurements with guided how-to-measure illustrations.
15. RAD calculator + bike RAD in Garage; fit-check card comparing recommended vs. measured.
16. Scale calibration in the worker (inseam ↔ hip–ankle segment) → first real-distance metrics, clearly labeled when active.
17. Tokenized setup share links with view/comment/edit permissions + QR; mechanic flow (suggest changes → rider approves as new setup version).

### Phase 4 — Reference library & comparison (weeks)
18. Curate reference clips (good jumps, nose drop, dead sailor, stiff landing, poor compression) through the same pipeline; store landmark series.
19. Comparison layer: user metrics vs. reference bands per phase ("your takeoff knee angle 152° vs. reference 105–125°"); side-by-side key-frame view.
20. `skill_norms` aggregation job (consent-gated) once user volume justifies it.

### Phase 5 — Second and third skills (repeat per skill)
21. Bunnyhop events + metrics + reference set → ship.
22. Drop variant → ship. Then manuals/wheelies with balance-over-time analysis.

### Phase 6 — Scale & differentiation (later)
23. Annotated video export (FFmpeg overlay render in the worker).
24. On-device pre-check with Pose Landmarker lite (Expo dev build / native module).
25. Custom bike keypoint model trained on accumulated calibration labels.
26. Cross-user insight features on top of `skill_norms`.

## 8. Success criteria per phase

- **P1:** on the validation set, detected takeoff/landing within ±80ms of hand labels on ≥80% of clips; zero fabricated metrics anywhere in the app.
- **P2:** a new user can sign up, upload, and get a report with real progress states; deleting the account removes all rows and Storage objects.
- **P3:** ≥50% of active users complete ≥3 body measurements (measures whether capture UX is easy enough for the data pillar to ever work); RAD fit-check usable end-to-end.
- **P4:** reports quote reference bands instead of fixed thresholds.
- **P5:** each new skill clears the same ±80ms event bar on its own validation set before release.

## 9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Pose quality on fast/blurred/occluded riders | VIDEO-mode tracking + smoothing + quality gate + honest confidence; manual calibration remains a first-class path |
| Event detection wrong → wrong coaching | validation set as a release gate; report language stays directional at low confidence |
| Bike geometry unsolved by human-pose models | manual calibration doubles as labeling; custom keypoint model only after data exists |
| Body-measurement entry errors poison analytics | guided measuring UX, range validation, outlier detection before aggregation |
| Privacy/consent failures | consent-gated from first release of profile features; deletion paths tested in CI |
| Scope creep across skills | one-skill-at-a-time rule with per-skill validation sets |
| Worker cost/latency at scale | short clips + sampled frames keep CPU viable; queue + autoscale later; on-device pre-check reduces junk uploads |
