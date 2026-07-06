# RiderLens MVP Plan — v1 Ship Plan

Status date: July 6, 2026.
This is the operative plan for shipping v1. Background documents: `riderlens-product-plan.md` (v4 — architecture, storage tiers, connectivity ladder) and `bike-technique-app-prerequisites.md` (visual system, design tokens, safety rules, filming guidance). Where they conflict, this document wins.

---

## 1. Goal

**Put a tool in MTB riders' hands that turns any filmed moment into a shareable, studyable record: the clip trimmed to the action, with their body position drawn on every frame.**

v1 is done when a rider who is not the founder:
1. films or picks a clip,
2. gets a finished record (trimmed clip + skeleton on every frame) without help,
3. finds it again later in their library, and
4. shares it — and the shared video carries the RiderLens watermark to whoever watches it.

The app does not coach. Judgment belongs to humans — the rider, a friend, a real coach. RiderLens makes the moment easy to see, keep, find, and share.

## 2. Strategy

- **A dedicated MTB app built on a sport-agnostic engine.** Nothing in the core loop (capture → pose skeleton → trim → tag → library → share) knows what a jump is. Sport-specific value lives in thin optional layers (AI window finding, flight metrics). This keeps two future paths open without committing to either now: act-two MTB depth, or per-sport clones (same engine, new brand) if MTB works.
- **"MTB" means all gravity disciplines.** Trail, enduro, DH, park, dirt jump — one scene, one media culture. No per-discipline features or marketing splits. Any bike (or any rider) can use the app; only the marketing targets MTB.
- **Share is the growth engine.** The skeleton-burned, watermarked clip is the ad. Every clip posted in a group chat or Instagram story markets the app to exactly the right audience. QR end-card + real domain complete the loop once the domain exists.
- **No skill taxonomy.** Records are titled by time ("Today · 14:07"). The what-layer is tags: an automatic `# crash` tag from the AI review plus one-tap user tags. Skill pickers and per-skill event grammars are rejected for v1 — do not reintroduce them.
- **Depth is act two, not v1.** Garage, Tools, coaching intelligence, and affiliate monetization wait until the video loop proves retention. They are the moat later precisely because they are not the MVP now.

## 3. The core loop

```
record live ──┐
              ├─→ find the window ─→ crop + pose ─→ record ─→ tag ─→ library ─→ share
pick from    ─┘   (AI proposes,      (worker:        (clip +           (poster    (skeleton mp4
photo library      manual always      FFmpeg +        skeleton          grid +      w/ watermark,
                   available)         MediaPipe)      filmstrip +       tag         or clean clip)
                                                      airtime est.)     filters)
```

## 4. Screens

v1 has **two routed screens plus one sheet**, held together by a three-slot tab bar.

### 4.1 Tab bar — `Capture · (+) · Library`
- Two tabs only. The center **(+)** is a prominent electric button: from anywhere, jump to Capture with the camera opening — one-tap quick record.

### 4.2 Capture screen (`CoachScreen.tsx`) — *the default tab*
- **Record** (in-app camera, 30s max, side-view hint) and **Library** (photo-library picker) actions.
- **Window step** after either: AI-proposed trim window when the worker is reachable ("AI found the moment"), manual start/end steppers always available. Thumbnail strip shows what's in/out of the window.
- **Latest record card** (shared `RecordCard` component, below) so the just-captured moment is immediately reviewable.
- Safety note card ("Ride within your limits") stays.

### 4.3 Library screen (`SessionsScreen.tsx`)
- **Poster grid** (2-column): every record shows its poster (middle filmstrip frame, skeleton burned in), time-based title, duration, tags.
- **Tag filter chips**: All + every known tag (auto + user). One active filter at a time.
- Tap a poster → **record detail sheet** (full-screen pageSheet): the complete `RecordCard` + close.

### 4.4 Record card (shared component, used in both places)
- Header: time title ("Today · 14:07"), window + AI/manual note; the status chip slot becomes the **Skeleton | Video** lens toggle once ready.
- Tag row: auto `# crash` (red) + user tags + one-tap add with suggestions.
- **Single viewport**: skeleton frame sequence or clean video, one shared playback position across both lenses.
- Transport: frame-step ‹ ›, play/pause, scrubber, speed cycle (1× / ½× / ¼×), timestamp. Event labels behave as phase banners (visible until the next event).
- Filmstrip: tappable thumbnails, event tags pinned to their frames.
- Flight strip (when the AI saw a flight): `AIRTIME 0.82s · HEIGHT ~0.8m · [est.]` — amber-marked estimate, never presented as measurement. Hidden when not applicable.
- Actions: **Share skeleton / Share clip** (follows the active lens) + Delete.

### 4.5 Garage screen — **HIDDEN in v1** (decision)
- `GarageScreen.tsx` stays in the codebase, **unrouted**. Do not delete; do not re-route for v1.
- Why hidden: demo-grade today (hardcoded bike, few editable fields); shipping it would split the first impression and add weeks of polish that don't help acquisition.
- When it returns: act two, after the video loop shows retention — rebuilt with real user knowledge, as the retention/monetization layer (setups, service tracking, affiliate).

### 4.6 Tools screen — **HIDDEN in v1** (decision)
- `ToolsScreen.tsx` stays in the codebase, **unrouted**. Same reasoning and same return path as Garage (sag/angle measuring tools belong with the Garage layer).

### 4.7 Intentionally absent from v1
- No onboarding flow (the Capture screen is self-explanatory; revisit only if field tests say otherwise).
- No accounts, login, or cloud sync (local-first; Supabase stays wired but dormant — "Demo mode" chip should be removed from the UI before beta).
- No settings screen.
- No coaching output of any kind.

## 5. Phases

### Phase 1 — Harden (this week)
1. ~~Source-video cleanup on delete~~ ✅ (committed)
2. **Auto-retry pending records** on reconnect / app foreground — no manual Retry needed after a no-signal session.
3. **Loosen the AI prompt**: "jump attempt" → "the action moment" (last sport-specific string in the engine).
4. **Remove the "Demo mode" chip** from the app header (internal state, not rider-facing).
5. **Screens final state**: Capture · (+) · Library only; Garage/Tools confirmed unrouted (done — this phase just locks it).
6. **Field test at a trail** (founder, real phone, bad signal, gloves). Findings feed back into this phase.
- **Done when:** a full trail session — film, trim, pocket the phone, records finished by home WiFi — works without touching Retry.

### Phase 2 — Unhost the worker
7. Containerize the worker (FastAPI + FFmpeg + MediaPipe; Dockerfile + deploy config) and deploy to Fly.io/Railway; Anthropic key as a secret.
8. App resolves the deployed URL as fallback (Metro-host trick stays for LAN dev).
9. Watch per-record AI cost; cheaper-model test remains the mitigation (product-plan §7).
- **Done when:** the app completes a record on cellular, away from the founder's LAN.

### Phase 3 — Identity (parallel with Phase 2, cheap)
10. Buy the domain → watermark becomes a real destination.
11. QR end-card appended to shared skeleton clips (FFmpeg; was only blocked on the URL).
12. One-screen landing page: an example shared clip + store link placeholder.
- **Done when:** someone who sees a shared clip can find and (eventually) install the app unaided.

### Phase 4 — Beta
13. EAS build → TestFlight → 3–5 riding buddies.
14. Measure the three numbers (§6). Fix what the beta breaks; nothing new.
- **Done when:** a second-week beta rider captures and shares without founder involvement.

### Act two — after retention proves out (explicitly not scheduled)
- Coaching intelligence (knowledge base already distilled in `worker/app/knowledge/`).
- Garage + Tools return as the depth/retention layer; affiliate on gear and service.
- Accounts + cloud sync (product-plan Phase 3) when device-loss becomes a real user problem.
- On-device pose (Expo dev build + MediaPipe/TFLite) only if airplane-mode records prove worth it.

## 6. Success metrics (beta)

| Metric | Signal |
|---|---|
| Captures per rider per week | Is the loop worth doing? |
| Shares per capture | Does the growth engine turn? |
| Week-2 return rate | Is the library worth coming back to? |

These three decide act two: depth (Garage/coaching) if riders retain and ask "what am I doing wrong?"; more loop polish if capture/share is strong but retention is weak.

## 7. Risks

| Risk | Mitigation |
|---|---|
| Worker cost/latency at beta scale | Cheaper-model test; local window detector on accumulated ground truth (product-plan §7) |
| Pose quality on blurred/small/geared-up riders | Overlay is presentation, not judgment — imperfect skeletons are visibly imperfect |
| Scope creep back into Garage/coaching/skills | This document, §2 and §4.5–4.7 |
| Dead watermark link before domain exists | Watermark ships as name-only risk accepted short-term; Phase 3 fixes |
| Offline queue complexity | Append-only pending records; auto-retry is re-running the same idempotent request |

## 8. Current state (July 6, 2026)

Built, tested, committed: capture flow (camera + library picker), AI window finding with manual fallback, worker pipeline (trim, pose on every frame, skeleton filmstrip, poster, watermarked skeleton share clip), flight metrics (airtime + estimated height, crash-aware, unit-tested), record card (single viewport, lens toggle, transport with speed/frame-step, phase-banner events), tags (auto crash + user, suggestions), library (poster grid, tag filters, detail sheet), share-by-lens, two-tab navigation with (+) quick capture, storage cleanup on delete. Worker test suite: 46 passing.

Open items are exactly Phases 1–4 above.
