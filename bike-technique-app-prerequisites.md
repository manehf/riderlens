# Bike Technique Coach App Prerequisites

Working names: BikeTutor, BikePal, RideCoach, RiderLens.

## 1. MVP Goal

Build a mobile app that lets a rider or friend record/upload a short bike-skill video, analyze key frames, and generate a body-mechanics coaching report.

The app can also include a bike setup and rider tools area for suspension settings, level/inclinometer measurements, service notes, and shareable setup sheets for coaches, shops, and mechanics.

Initial skills:

- Regular jumps
- Bunnyhops
- Manuals
- Wheelies
- Drops

Later skills:

- Scrubs
- Whips
- Cornering
- Pump track technique

## 2. Recommended Stack

### Mobile App

- Expo
- React Native
- TypeScript
- Expo Camera for recording
- Expo Image Picker for selecting existing videos
- Expo AV or Video for playback
- Expo Sharing for WhatsApp/share-sheet exports
- Expo Sensors for level bubble/inclinometer tools
- Optional: PDF or image export for setup sheets

### Backend

- Supabase Auth for user accounts
- Supabase Postgres for sessions, jobs, reports, and metrics
- Supabase Storage for raw videos, key frames, annotated videos, and shared reports
- Supabase Realtime or polling for analysis job status

### Video Analysis Service

- Python
- FastAPI
- MediaPipe Pose Landmarker for human body landmarks
- OpenCV for frame extraction, video processing, overlays, and measurements
- FFmpeg for trimming, encoding, thumbnails, and annotated video export
- Optional later: YOLO pose/keypoint model trained for bike landmarks

## 3. Why A Separate Python Worker Is Needed

Expo and Supabase are good for the product app, but heavy video analysis should not run inside the mobile app or Supabase Edge Functions.

The Python worker should:

- Download the uploaded video from Supabase Storage
- Extract frames
- Detect rider pose
- Estimate key moments
- Calculate body/bike metrics
- Generate coaching notes
- Upload key frames, annotated video, and report data back to Supabase
- Update the analysis job status

## 4. Core App Flow

1. User chooses `Record` or `Upload Video`.
2. User selects skill type, such as jump, bunnyhop, manual, or wheelie.
3. App uploads the video to Supabase Storage.
4. App creates an `analysis_jobs` row in Supabase.
5. Python worker processes the video.
6. App shows progress while the job runs.
7. App displays key frames, metrics, and coaching report.
8. User exports an annotated video or shares a private report link.

## 5. Bike Setup And Utility Tools

This area makes the app useful even when the rider is not recording video. It should live beside the video coach as a `Garage` or `Tools` section.

### Core Tool Ideas

- Level bubble / inclinometer
- Suspension setup log
- Sag calculator
- Tire pressure log
- Cockpit setup log
- Service tracker
- Session notes
- Shareable setup sheet for mechanics, coaches, shops, or friends

### Level Bubble / Inclinometer

Use phone sensors to measure angles.

Useful measurements:

- Ramp or takeoff angle
- Landing slope angle
- Bike frame angle while setting sag
- Handlebar roll
- Brake lever angle
- Saddle angle

MVP notes:

- Use simple calibration/reset-to-zero.
- Allow degrees and percentage grade.
- Store measurements inside a bike setup or session note.
- Include a warning that phone placement affects accuracy.

### Suspension Setup Log

Store suspension settings per bike and setup version.

Fields:

- Bike name/model
- Fork model
- Shock model
- Rider weight with gear
- Fork pressure
- Shock pressure
- Fork sag percentage
- Shock sag percentage
- Fork rebound clicks
- Shock rebound clicks
- Low-speed compression clicks
- High-speed compression clicks
- Volume spacers/tokens
- Tire pressure front/rear
- Terrain type
- Riding style
- Notes such as "too harsh", "dives under braking", "kicks on landings"

Useful setup presets:

- Dirt jumps
- Bike park
- Enduro race
- Wet trails
- Street/urban
- Pump track

### Share With Shops And Mechanics

Create a shareable setup sheet that can be sent by WhatsApp, email, link, or QR code.

The shared setup should include:

- Bike details
- Suspension settings
- Tire pressure
- Cockpit settings
- Service notes
- Rider complaint/feedback
- Last updated date

Mechanic/shop flow:

1. Rider shares a setup link or QR code.
2. Mechanic reviews the current setup before service.
3. Mechanic can suggest or record changes.
4. Rider saves the new setup as a version.

Permissions should be explicit. A shop or mechanic should not be able to edit a rider setup unless the rider grants edit access.

### Other Useful Tools

- Tire pressure calculator by rider weight, tire size, terrain, and riding style
- Gear checklist for bike park/race day
- Torque spec notes for common bolts
- Brake pad and tire wear notes
- Suspension service reminders
- Tire sealant reminders
- Chain/cassette wear reminders
- Crash/damage notes with photos
- Bike fit notes such as bar width, stem length, stack height, saddle height, and lever position

## 6. Video Requirements

Recommended for MVP:

- 3 to 10 seconds long
- 60fps or higher where possible
- Rider fully visible
- Bike fully visible
- Good light
- Stable camera
- Side-view angle for jumps, bunnyhops, manuals, and wheelies
- Avoid zoomed-in, shaky, dark, or heavily cropped clips

Scrubs and whips are harder because side view is not enough. They need three-quarter/front angle, multiple views, or bike-mounted sensor data to measure roll/yaw properly.

## 7. Suggested Supabase Tables

### `profiles`

- `id`
- `display_name`
- `created_at`

### `sessions`

- `id`
- `user_id`
- `skill_type`
- `status`
- `created_at`

### `videos`

- `id`
- `session_id`
- `raw_video_path`
- `annotated_video_path`
- `duration_seconds`
- `fps`
- `created_at`

### `analysis_jobs`

- `id`
- `session_id`
- `status`
- `error_message`
- `started_at`
- `finished_at`

### `pose_metrics`

- `id`
- `session_id`
- `phase`
- `frame_time`
- `torso_angle`
- `hip_angle`
- `knee_angle`
- `elbow_angle`
- `bike_pitch_angle`

### `reports`

- `id`
- `session_id`
- `summary`
- `strengths`
- `improvements`
- `drills`
- `created_at`

### `share_links`

- `id`
- `session_id`
- `token`
- `expires_at`
- `created_at`

### `bikes`

- `id`
- `user_id`
- `name`
- `brand`
- `model`
- `year`
- `discipline`
- `created_at`

### `bike_setups`

- `id`
- `bike_id`
- `name`
- `terrain_type`
- `riding_style`
- `rider_weight_with_gear`
- `notes`
- `created_at`
- `updated_at`

### `suspension_settings`

- `id`
- `bike_setup_id`
- `fork_model`
- `shock_model`
- `fork_pressure`
- `shock_pressure`
- `fork_sag_percent`
- `shock_sag_percent`
- `fork_rebound_clicks`
- `shock_rebound_clicks`
- `fork_lsc_clicks`
- `fork_hsc_clicks`
- `shock_lsc_clicks`
- `shock_hsc_clicks`
- `fork_tokens`
- `shock_tokens`
- `notes`

### `cockpit_settings`

- `id`
- `bike_setup_id`
- `bar_width`
- `stem_length`
- `stem_spacers`
- `bar_roll_angle`
- `brake_lever_angle`
- `saddle_height`
- `saddle_angle`
- `notes`

### `tire_settings`

- `id`
- `bike_setup_id`
- `front_tire_model`
- `rear_tire_model`
- `front_tire_pressure`
- `rear_tire_pressure`
- `front_tire_width`
- `rear_tire_width`
- `conditions`
- `notes`

### `service_records`

- `id`
- `bike_id`
- `service_type`
- `service_date`
- `odometer_or_hours`
- `shop_name`
- `mechanic_name`
- `notes`
- `next_due_at`

### `setup_share_links`

- `id`
- `bike_setup_id`
- `token`
- `permission`
- `expires_at`
- `created_at`

### `tool_measurements`

- `id`
- `bike_id`
- `bike_setup_id`
- `measurement_type`
- `value`
- `unit`
- `notes`
- `created_at`

## 8. First Metrics To Calculate

For jumps:

- Approach speed estimate
- Compression timing
- Torso angle at takeoff
- Hip position relative to bike center
- Arm and leg extension timing
- Bike pitch in air
- Landing body position
- Landing compression

For bunnyhops:

- Front wheel lift timing
- Hip shift backward
- Rear wheel lift timing
- Peak height estimate
- Landing balance

For manuals and wheelies:

- Front wheel height stability
- Torso angle
- Arm bend
- Hip position
- Correction pattern
- Time held in balance zone

## 9. Report Style

Use coaching language, not medical language.

Good:

- "Your hips move too far behind the bike at takeoff."
- "Your arms extend before your legs, which makes the front wheel drop early."
- "Try compressing earlier and extending through legs and arms together."

Avoid:

- Medical diagnosis
- Injury claims
- Saying the app can guarantee safety
- Treating one riding style as the only correct style

## 10. Safety And Legal Basics

The app should include:

- A disclaimer that feedback is educational, not medical advice
- Clear warning that bike skills involve risk
- Recommendation to practice within ability level
- Helmet/protective gear reminders
- Privacy controls for shared videos
- User consent for uploading videos
- Explicit permission before sharing bike setup data with shops or mechanics
- Delete account and delete video options
- Delete bike setup and service record options

## 11. Development Prerequisites

Developer machine:

- Node.js LTS
- npm or pnpm
- Expo CLI
- iOS Simulator or Android Emulator
- Physical phone for camera testing
- Python 3.11+
- FFmpeg
- OpenCV
- MediaPipe
- Supabase project
- Physical phone for sensor testing

Accounts/services:

- Expo account
- Supabase account
- Apple Developer account for iOS release
- Google Play Console account for Android release
- Hosting for Python worker, such as Render, Fly.io, Railway, AWS, GCP, or a dedicated server

## 12. MVP Build Order

1. Expo app shell with Record, Upload Video, and My Sessions.
2. Supabase Auth, Storage, and session tables.
3. Video upload from camera and gallery.
4. Garage data model with bikes and setup presets.
5. Level bubble/inclinometer tool.
6. Suspension setup log and shareable setup sheet.
7. Python worker that extracts frames and detects pose.
8. Key-frame detection for one skill, preferably regular jumps.
9. Basic rule-based report.
10. Annotated key frames.
11. Share link and WhatsApp/share-sheet export.
12. Add bunnyhop/manual/wheelie reports.
13. Train custom bike keypoint model later.

## 13. Biggest Technical Risks

- Poor camera angle
- Rider leaving the frame
- Occlusion from bike, clothing, shadows, or other riders
- Bike landmarks not detected by general human pose models
- Different valid riding styles
- Overconfident feedback from limited video data
- Processing time and video file size
- Incorrect setup data entered by users
- Phone sensor measurements affected by case, mount, calibration, or placement
- Shops/mechanics needing clear permissions before editing shared setups

The MVP should start with short, side-view clips and clear filming guidance.

## 14. Visual Identity And Color Reference

Preferred product name: `RiderLens`.

Preferred direction: electric green, graphite black, clean neutral surfaces, and cyan analysis overlays.

The goal is to make the app feel like a smart computer-vision coaching tool, not a generic fitness app, generic AI dashboard, or loud extreme-sports brand. The app should feel technical, sharp, outdoor-capable, and practical.

### Design Decisions Locked For MVP

- Brand/accent direction: electric green + graphite + cyan, chosen over the earlier orange.
- Typography: IBM Plex Sans for UI, IBM Plex Mono for all numbers, with tabular figures.
- Surface split: light reports/garage/forms, dark video-analysis/scan surfaces.
- Electric green is used only on dark surfaces or as solid blocks with dark text — never as a thin element on a light surface.

The rest of this section is the detailed reference behind those decisions.

### Local Design References

- Visual source of truth (color system, components, typography in context): `index-electric.html`
- Garage setup sheet / mechanic-facing share reference: `garage-setup-sheet.html`
- Typography specimen (chosen Plex system shown in the scheme): `font-specimen.html`
- Earlier orange comparison only, do not implement: `index.html`

The electric green version is the current visual source of truth. The orange version is reference-only.

### Design Tokens (copy into the app theme)

```css
:root {
  /* Surfaces */
  --background: #f5f7f1;
  --surface: #ffffff;
  --surface-muted: #edf2ea;
  --graphite: #111613; /* dark analysis/scan surface */
  --graphite-2: #171d19;

  /* Text */
  --text: #101411;
  --text-muted: #60685f;
  --border: #dde3da;

  /* Accents */
  --electric: #b6ff2e; /* brand + primary action; dark surfaces / solid blocks only */
  --electric-soft: #efffd8;
  --green: #2e7d32; /* saved/current; thin fills + progress on light surfaces */
  --cyan: #00b8d9; /* measured / pose lines / analysis */
  --cyan-soft: #d9f8ff;
  --amber: #e19a00; /* uncertainty / caution */
  --amber-soft: #fff0ce;
  --red: #d64545; /* error / destructive / serious warning */
  --red-soft: #ffe0df;

  /* Type */
  --font-ui: "IBM Plex Sans";
  --font-mono: "IBM Plex Mono";
}
```

### Core Palette

- Graphite Black: `#111613`
- Dark Surface: `#171D19`
- Background: `#F5F7F1`
- Surface: `#FFFFFF`
- Primary Text: `#101411`
- Muted Text: `#60685F`
- Border: `#DDE3DA`
- Electric Green: `#B6FF2E`
- Deep Green: `#2E7D32`
- Analysis Cyan: `#00B8D9`
- Warning Amber: `#E19A00`
- Error Red: `#D64545`

### Color Roles

- Electric green should be the main brand and action color.
- Use electric green for primary buttons, active tabs, scan/live states, confidence indicators, and key brand moments.
- Use graphite and dark surfaces for video analysis, camera UI, pose overlays, frame review, and scan-style interfaces.
- Use cyan for measured body mechanics, pose lines, metrics, and analysis overlays.
- Use light neutral surfaces for reports, setup sheets, garage tools, forms, service records, and mechanic-facing shares.
- Use deep green for saved/complete/current states where electric green would be too loud.
- Use amber only for uncertainty, low confidence, bad filming conditions, warnings, and caution states.
- Use red only for errors, failed analysis jobs, destructive actions, or serious safety/privacy warnings.

### Typography

Locked for MVP. Use the IBM Plex superfamily so the product reads like a measurement instrument rather than a generic SaaS dashboard. Both faces are SIL OFL and free to bundle in the app.

- UI, body, headings, labels, coaching notes, reports, and setup sheets: **IBM Plex Sans**.
- Every numeric value — angles, psi, clicks, sag %, frame timecodes, confidence %, inclinometer/sensor readings, and all metric tables: **IBM Plex Mono**.
- Keep words out of mono. Status chips, buttons, and text-based values (e.g. service descriptions) stay in IBM Plex Sans.
- Always enable tabular figures on numeric text: `font-variant-numeric: tabular-nums`. Required on metric tables and setup sheets so number columns align.
- IBM Plex Sans tops out at 700 (Bold); there is no 800/900. Cap heavy weights at 700 and do not rely on 800+ in CSS.
- Ship only the weights used: Plex Sans 400 / 600 / 700, Plex Mono 500 / 700.
- Wordmark: `RiderLens` uses IBM Plex Sans 700. If a heavier/sharper brand lockup is wanted later, Space Grotesk or Archivo may be used for the wordmark only — never for UI or body.
- Expo: load with `@expo-google-fonts/ibm-plex-sans` and `@expo-google-fonts/ibm-plex-mono`. The `<link>` tags in the HTML mockups are for browser preview only; do not ship them in the app.

### Design Rules

- Do not make the whole app neon green.
- Do not make the whole app dark. Use dark surfaces mainly where video and overlays need contrast.
- Keep reports and garage/setup tools readable, calm, and credible.
- Avoid large decorative gradients, glowing blobs, or generic AI/SaaS styling.
- Prefer dense, practical mobile UI over marketing-style hero layouts inside the app.
- Use color to communicate state and function, not decoration.
- Keep shareable reports light and printable-looking so they are easy to send to coaches, shops, and mechanics.
- Treat glow/neon effects as a "live scan" signal only: allowed on the dark video/analysis surfaces (pose lines, detected bike line, scan readouts) and kept subtle; removed from light and marketing surfaces, which use solid color and neutral shadows.

### Accessibility And Contrast

The electric scheme was contrast-audited against WCAG 2.1; keep these constraints when implementing.

- All text pairings pass AA for normal text. The tightest are green-on-light (eyebrow, "current" chip, active tab) at roughly 4.75–4.98:1, so do not darken those light backgrounds further.
- Electric green (`#B6FF2E`) is near-invisible as a thin element on light (an electric progress fill on a light track measured 1.07:1). On light surfaces, use deep green (`#2E7D32`) or graphite for thin fills, lines, and progress bars; reserve electric green for dark surfaces or solid blocks with dark text on top.
- Never encode state by color alone. Every status carries a text label (chip), not just a hue, so the system stays usable for color-vision-deficient riders, coaches, and mechanics.
- Keep tabular figures on numeric data (see Typography) so metrics and setup values stay scannable.

### Optional Purple Consideration

Purple was considered as a possible secondary accent for AI/coach insights, premium features, or recommendation highlights. It should not dominate the MVP palette unless testing shows the green/black/cyan system feels too narrow.

If used later, a controlled purple accent could be:

- Signal Purple: `#7C3AED`
- Soft Purple: `#EEE7FF`

Potential purple role: AI insight cards, smart recommendations, premium coaching notes, or comparison highlights. Avoid using purple as the main brand color because it may make the app feel like a generic AI product instead of a bike-specific analysis tool.

### Questions For External Design Review

Ask reviewers to evaluate:

- Does electric green fit `RiderLens` better than orange for a bike technique coach?
- Does the palette feel technical and outdoor-capable without feeling like a game UI?
- Are the color roles clear enough for Coach, Sessions, Garage, Tools, and Reports?
- Are light report/setup surfaces and dark video-analysis surfaces a good split?
- Does the palette leave enough room for accessibility, contrast, and long-term product expansion?

## 15. Current MVP Implementation Status

Status date: July 1, 2026.

This repository now contains a working local MVP shell for `RiderLens`, with regular jumps as the first analysis target. The current implementation validates the main product direction, but it is not a production backend-connected release yet.

### Implemented

- Expo/React Native app shell with Coach, Sessions, Garage, and Tools tabs.
- `RiderLens` visual identity using the locked electric green / graphite / cyan system.
- IBM Plex Sans for UI and IBM Plex Mono with tabular figures for all numeric readouts.
- Record flow using Expo Camera.
- Upload flow using Expo Image Picker.
- Pre-upload clip review with jump start/end trimming and crop/framing presets.
- Local video persistence in the app document library for future analysis review.
- FastAPI worker integration for uploaded regular-jump clips.
- MediaPipe Pose and OpenCV worker for sampled-frame body landmark analysis.
- Key-frame phases for regular jumps: approach, compression, takeoff, air, landing.
- Analysis preview, key frame strip, metrics, confidence state, and basic rule-based coaching report.
- Manual calibration flow for floor, both tire centers, torso, knee, ankle, and landing line.
- Frame selection and zoom support inside manual calibration.
- Sessions history for uploaded video analyses and saved external references.
- External YouTube/web links saved as reference-only sessions.
- Garage setup model, suspension setup, cockpit/tire/service records, saved measurements, and share-sheet text.
- Tools tab with inclinometer/level, calibration, measurement saving, and sag calculator.
- Supabase schema draft covering sessions, videos, video link references, jobs, metrics, reports, bikes, setups, service records, share links, and tool measurements.

### Current Analysis Architecture

The MVP uses a mixed architecture:

1. The mobile app records or uploads a real video file.
2. The app copies that file into the local RiderLens video library.
3. The app posts the file to the FastAPI worker at `EXPO_PUBLIC_ANALYSIS_WORKER_URL`.
4. The worker uses OpenCV to sample frames and MediaPipe Pose to detect rider body landmarks.
5. The worker returns normalized geometry, body angles, confidence, phase timing, and coaching notes.
6. The app renders the video frame, overlay lines, metrics, and report.
7. If the worker is unreachable or confidence is not enough, the app falls back to local placeholder metrics plus manual calibration.

This keeps the first MVP testable locally while preserving the future path to Supabase Storage and async worker jobs.

### External Link Decision

External links are intentionally reference-only in the current MVP.

- A YouTube/web link can be saved in the rider library.
- The app can show/open the reference.
- The app should not pretend that a YouTube link has been fully analyzed.
- Automatic geometry requires raw frame access, so the rider must upload or record the original clip file.
- A future backend can support authorized direct `.mp4` or cloud-storage URLs.
- YouTube should remain a reference source unless the user provides the original file or a legally authorized ingestion path.

### MVP Test Path

For the current MVP, the correct analysis test is:

1. Start the worker locally.
2. Set `EXPO_PUBLIC_ANALYSIS_WORKER_URL` to `127.0.0.1` for simulator or the computer LAN IP for a physical phone.
3. Restart Expo with a clean cache.
4. Use `Upload` or `Record`.
5. Confirm the clip in the pre-upload review.
6. Review the generated key frames, metrics, and report.
7. Use manual calibration when floor/tire/landing geometry is wrong.

### Known Gaps

- Supabase is present as schema and configuration only; the local MVP still relies mostly on AsyncStorage and local files.
- The worker is local-only unless deployed separately.
- Bike-specific geometry is not solved by MediaPipe Pose. Tire centers, floor line, and landing line are heuristic and often need manual correction.
- No custom bike keypoint model exists yet.
- External links are not analyzed automatically.
- Annotated video export is not implemented.
- There is not yet a structured good-jump/bad-jump comparison library.
- Other skill models are not implemented yet: bunnyhops, manuals, wheelies, drops, turns, scrubs, and whips.

### Recommended Next Steps

1. Improve regular-jump worker reliability before adding more skills.
2. Add better logging/status in the app so worker failures are visible during testing.
3. Store worker response snapshots for debugging real clips.
4. Build a small curated reference library: good regular jumps, common nose-drop mistakes, dead-sailor jumps, stiff landings, poor compression, and off-axis landings.
5. Add a reference-comparison layer after the MVP detects stable phases and body angles.
6. Connect Supabase Storage/Auth for real user persistence.
7. Deploy the worker and switch from local LAN testing to a stable endpoint.
8. Consider a custom bike landmark model once enough labeled examples exist.
