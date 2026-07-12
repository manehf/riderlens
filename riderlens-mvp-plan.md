# RiderLens MVP Plan — MTB Gravity v1 Ship Plan

Status date: July 11, 2026.
This is the operative plan for shipping v1. Background documents: `riderlens-product-plan.md` (v4 — architecture, storage tiers, connectivity ladder) and `bike-technique-app-prerequisites.md` (visual system, design tokens, safety rules, filming guidance). Where they conflict, this document wins.

---

## 1. Goal

**Put a tool in MTB gravity riders' hands that turns any filmed moment into a shareable, studyable record: the clip trimmed to the action, with their body position drawn on every frame.**

v1 is done when a rider who is not the founder:
1. films or picks a clip,
2. gets a finished record (trimmed clip + skeleton on every frame) without help,
3. finds it again later in their library, and
4. shares it — and the shared video carries the RiderLens watermark to whoever watches it.

For v1, the app does not coach. Judgment belongs to humans — the rider, a friend, a real coach. RiderLens makes the moment easy to see, keep, find, and share.

Long-term product direction: RiderLens becomes a full MTB gravity app, not a generic sports-analysis app. The capture loop is the wedge. Later layers add rider fit, bike setup, setup sharing, garage tools, and useful gear/service commerce for MTB riders.

## 2. Strategy

- **A dedicated MTB gravity app built on a reusable media/pose engine.** The product, language, examples, tags, and beta users are MTB-first. Under the hood, the core loop (capture → pose skeleton → trim → tag → library → share) stays generic enough to support future products, but v1 is not marketed as a general sports, moto, skate, or gymnastics app.
- **"MTB" means gravity disciplines first.** Enduro, downhill, bike park, trail jumps, drops, corners, and dirt jump — one scene, one media culture. No per-discipline features or marketing splits in v1.
- **Share is the growth engine.** The skeleton-burned, watermarked clip is the ad. Every clip posted in a group chat or Instagram story markets the app to exactly the right audience. QR end-card + real domain complete the loop once the domain exists.
- **No skill taxonomy.** Records are titled by time ("Today · 14:07"). The what-layer is tags: an automatic `# crash` tag from the AI review plus one-tap user tags. Skill pickers and per-skill event grammars are rejected for v1 — do not reintroduce them.
- **Depth is act two, not v1.** Rider profile, bike setup, Garage, Tools, coaching intelligence, public setup sharing, and affiliate monetization wait until the video loop proves retention. They are the moat later precisely because they are not the MVP now.

## 3. The core loop

```
record live ──┐
              ├─→ select one jump ─→ crop + pose ─→ record ─→ tag ─→ library ─→ share
pick from    ─┘   (rider chooses      (worker:        (clip +           (poster    (skeleton mp4
photo library      0.5–8 seconds)      FFmpeg +        skeleton          grid +      w/ watermark,
                                       MediaPipe)      filmstrip)        filters)    or clean clip)
```

### 3.1 Minimum MVP

The minimum shippable product is the smallest version that proves riders care enough to repeat the loop:

1. **Capture or pick a local video** — no YouTube/external links, no cloud import, no setup flow.
2. **Choose the action window** — the rider previews and selects one 0.5–8 second jump; no full-video AI search.
3. **Generate a finished record** — trimmed clip, skeleton overlay on every frame, poster, filmstrip, basic metadata.
4. **Save records locally** — a rider can leave the app and come back to a list of sessions.
5. **Review one record well** — Skeleton/Video toggle, play/pause, scrub, frame step, slow speed.
6. **Tag and find records** — simple tags plus a Library grid/filter.
7. **Share a watermarked clip** — the shared skeleton/video is the acquisition artifact.
8. **Handle offline honestly** — queued/pending/failed/ready states, with retry when connection returns.

Everything else is deliberately outside the MVP: rider measurements, bike setup, public profiles, shop sharing, sag tools, pressure calculators, setup recommendations, deal monitoring, accounts, cloud sync, and coaching reports.

## 4. Screens

v1 is **one home screen, one action, two sheets**. No tab bar: earlier iterations (tabs + a center (+)) gave a two-screen app three capture entry points; the redundancy was removed on July 6.

### 4.1 Home — the Library (`SessionsScreen.tsx`)
- **Poster grid** (2-column): every record shows its poster (middle filmstrip frame, skeleton burned in), time-based title, duration, tags.
- **Tag filter chips**: All + every known tag (auto + user). One active filter at a time.
- Tap a poster → **record detail sheet** (full-screen pageSheet): the complete `RecordCard` + close.
- **Floating (+)** (bottom center, electric): the app's single capture entry point → opens the capture sheet.

### 4.2 Capture sheet (`CaptureSheet.tsx`) — modal over the library
- **Record** (in-app camera, 30s max, side-view hint) and **Pick video** (photo-library picker) — the rider decides behind the single (+).
- **Jump selection** after either: orientation-preserving video preview, looping selected range, tappable thumbnails, and precise start/end controls. The worker receives only the rider-confirmed range.
- **Analyze jump** closes the sheet; the new record lands at the top of the library grid, visibly `queued → processing → ready`.
- Safety note card ("Ride within your limits") lives here.

### 4.4 Record card (shared component, shown in the record detail sheet)
- Header: time title ("Today · 14:07") and selected source range; the status chip slot becomes the **Skeleton | Video** lens toggle once ready.
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

### 4.7 Settings sheet (`SettingsSheet.tsx`) — gear button in the header
- **Rider profile**: units (metric/imperial) + height, weight, inseam, arm length. Values stored canonically in metric (`heightCm`, `weightKg`, …); the units preference is a display lens only — switching never mutates stored values.
- Purpose: collect rider dimensions early so act-two fit/analysis features (RAD fit, body-calibrated jump metrics) have data on day one. All optional, local-only.
- About: app version. Nothing else — settings is not a junk drawer.

### 4.8 Intentionally absent from v1
- No onboarding flow (the library + one (+) button is self-explanatory; revisit only if field tests say otherwise).
- No accounts, login, or cloud sync (local-first; Supabase stays wired but dormant — "Demo mode" chip should be removed from the UI before beta).
- No coaching output of any kind.

## 5. Phases

### Phase 1 — Harden (this week)
1. ~~Source-video cleanup on delete~~ ✅ (committed)
2. ~~Auto-retry pending records on app foreground / active worker reachability checks~~ ✅ — no manual Retry needed when the worker becomes reachable while the app is active.
3. ~~Loosen the AI prompt: "jump attempt" → "the action moment"~~ ✅.
4. ~~Remove the "Demo mode" chip from the app header~~ ✅.
5. **Screens final state**: Capture · (+) · Library only; Garage/Tools confirmed unrouted (done — this phase just locks it).
6. **Field test at a trail** (founder, real phone, bad signal, gloves). Findings feed back into this phase.
- **Done when:** a full trail session — film, trim, pocket the phone, records finished by home WiFi — works without touching Retry.

### Phase 2 — Unhost the worker
7. ~~Containerize the worker and deploy~~ ✅ — live at `riderlens-worker.fly.dev` (Fly.io, cdg, scale-to-zero, 2GB, dev UI off, Anthropic key as secret). End-to-end verified: 18s clip analyze from the public URL.
8. ~~App resolves the deployed URL as fallback~~ ✅ — ordered candidates: dev bundler host (LAN Mac) first, Fly second; first healthy /health wins.
9. Watch per-record AI cost in the Anthropic/Fly dashboards; cheaper-model test remains the mitigation (product-plan §7).
- **Done when:** the app completes a record on cellular, away from the founder's LAN. *(Remaining: that one phone test.)*

### Phase 3 — Identity & the share page ✅ (July 7)
10. ~~Buy the domain~~ ✅ — `riderlens.app` (Cloudflare registrar + Pages).
11. ~~QR end-card~~ ✅ — every shared skeleton clip closes with a 1.4s card: wordmark + scannable QR to riderlens.app (deployed, unit-tested).
12. ~~Share page~~ ✅ — live at https://riderlens.app (pitch, beta CTA, safety note) with /privacy and /terms (drafts; legal review before public launch). Beta CTA swaps to store badges at launch.
13. Future evolution (needs cloud storage, act two): per-record share pages — `riderlens.app/r/<token>` showing that rider's actual clip + frames behind a tokenized URL.
- **Done when:** ~~someone who sees a shared clip can scan/tap through to the share page~~ ✅ (install link arrives with Phase 4 builds).

### Phase 4 — Beta
14. Apple Developer account → EAS build → TestFlight → 3–5 riding buddies. App icon/splash from the hand-drawn logo; privacy policy + terms + support email hosted on the domain (required for TestFlight/App Store).
15. **Minimal analytics** (the §6 numbers are currently unmeasured): lightweight event logging (PostHog free tier or worker-side counters) + crash reporting (Sentry free tier).
16. Measure the three numbers (§6). Fix what the beta breaks; nothing new.
- **Done when:** a second-week beta rider captures and shares without founder involvement.

### Phase 5 — Monetization (only after beta signal)
17. App Store Connect: Paid Apps agreement (once per account; already crossed for DayDuet), products `riderlens_pro_monthly` / `riderlens_pro_yearly`.
18. RevenueCat dashboard: entitlement "RiderLens Pro", offering, paywall design; drop the two API keys into env. The in-app rails are already built and dormant (`src/services/revenueCat.ts`).
19. Free-tier enforcement in the app: **Free = 3 records per month** (per month, never a lifetime cap — deleting the archive would kill the retention moat), paywall triggers at the limit, Pro bypasses.
20. Pricing: **Pro $3.99/mo · $29.99/yr with 7-day trial on annual** (market anchors: SwingVision $179.99/yr, Strava $79.99/yr, GoPro Premium $49.99/yr — RiderLens sits deliberately below all). Optional community launch: limited "Founding Rider" lifetime (~$59.99). A cheaper figure ships only as labeled launch pricing, never as list price.
21. Cost floor: each AI-processed record costs ~$0.10–0.15 until the local window detector lands (product-plan §7) — the free cap is COGS defense (~$0.45/free user/month max).
- **Never gated:** the watermarked share (acquisition engine) and viewing/tagging the existing library.
- **Done when:** a stranger can hit the free limit, pay, and process record #4 without help.

### Act two — after retention proves out (explicitly not scheduled)
- **Rider profile:** height, weight, inseam, RAD inputs, arm span, shoulder width, stance/preferences, riding style, discipline.
- **Bike setup profile:** frame size, wheel size, fork/shock model, travel, pressure or spring rate, rebound/compression clicks, volume spacers, cockpit width/rise/stem/spacers, tires, pressures, inserts.
- **Garage and setup sharing:** private by default; shareable public setup pages and shop/mechanic links only when the rider opts in.
- **MTB tools:** sag photo helper, pressure calculators, cockpit fit helper, baseline suspension setup, setup change log, service intervals.
- **Smart suggestions:** pattern-based, cautious language such as "riders with similar height and arm span often run 760-780mm bars"; never fake certainty.
- **Deal monitor and affiliate layer:** user-tracked products, price alerts, clearly labeled affiliate links, recommendations tied to the rider's actual bike/profile.
- **Coaching intelligence:** knowledge base already distilled in `worker/app/knowledge/`, added only after the capture archive proves retention and provides enough examples.
- **Accounts + cloud sync (Supabase auth + storage):** required soon after the first paying users — a paying rider losing their library to a lost phone is a refund and a one-star. Also unlocks per-record share pages (Phase 3 item 13) and real deletion/export.
- **Web portal (cross-device library + GoPro upload):** riders film on action cams; a browser client lets them upload from a computer and view the same cloud library on any device. Depends entirely on cloud sync above; the worker API is already browser-ready (CORS). ~1–2 weeks once sync exists; doubles as the desktop/coach review surface. Interim GoPro path for beta: GoPro app → phone Photos → Pick from library.
- **On-device pose:** Expo dev build + MediaPipe/TFLite only if airplane-mode records prove worth it.

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
| Scope creep into Garage/setup/tools/deals/coaching before retention | This document, §2, §3.1, and §4.5–4.7 |
| Dead watermark link before domain exists | Watermark ships as name-only risk accepted short-term; Phase 3 fixes |
| Offline queue complexity | Append-only pending records; auto-retry is re-running the same idempotent request |

## 8. Current state (July 7, 2026)

Built and tested: capture flow (camera + video picker), rider-selected 0.5–8 second jump range with looping preview and explicit rotation correction, worker-side orientation canonicalization, worker pipeline (trim, pose on every frame, skeleton filmstrip, poster, watermarked skeleton share clip), record card (single viewport, lens toggle, transport with speed/frame-step), user tags, library (poster grid, tag filters, detail sheet), share-by-lens, storage cleanup on delete, and foreground/active retry for pending records. The full-video AI window search is removed from the mobile critical path; automatic phase suggestions can return later inside the already selected jump.

Open items are exactly Phases 1–4 above.
