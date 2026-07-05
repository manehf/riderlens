# RiderLens Product & Technical Plan v4 — Capture First, MTB-First

Status date: July 5, 2026.
Supersedes plan v3 (July 4, capture-first). The coaching ambitions remain parked — see the appendix. `bike-technique-app-prerequisites.md` remains the original scope/design reference; its visual system, safety rules, and filming guidance still apply.

## 0. Positioning (decided July 5, 2026)

- **A dedicated MTB app built on a sport-agnostic engine.** Nothing in the core loop (capture → pose skeleton → trim → record → tag → share) knows what a jump is. Sport-specific value lives in thin optional layers (the AI window prompt, flight metrics, the future coaching layer). This keeps both future paths open: act-two MTB depth, and someday per-sport clones (same engine, new knowledge base + brand) if MTB works.
- **v1 ships the video loop only.** Navigation is **Capture · (+) · Library**. Garage and Tools are hidden (screens kept in `src/screens/`, unrouted) — they are act two's opening move, not MVP scope. Do not re-route them for v1.
- **No skill taxonomy in the product.** Records are titled by time ("Today · 14:07"); the what-layer is tags (auto `# crash` from the AI review + user tags). Skill pickers and per-skill event grammars are explicitly rejected for MVP — do not reintroduce them.
- **Share is the growth loop.** The skeleton-burned, watermarked mp4 (`riderlens.app` — placeholder until the domain is real) is the ad; the share button sends whichever lens (Skeleton/Video) is active. A QR end-card gets appended once a real download URL exists.
- **Act two (after retention proves out):** coaching intelligence (knowledge base already distilled in `worker/app/knowledge/`), Garage + Tools return, affiliate/partnerships on gear and service. MTB is a high-spend niche; depth is the moat — generic video+skeleton alone is clonable.

## 1. The product in one sentence

**RiderLens captures your trick — it finds the moment in your video, cuts it out, draws your body position on every frame, and saves it to your riding history so you can study it or share it with someone who can help.**

The app does not coach. Judgment belongs to humans — the rider, a friend, a real coach. RiderLens is the medium: it makes the moment easy to see, keep, find, and share. This removes the hardest and riskiest part of the old plan (automated coaching correctness, per-skill knowledge bases, mistake diagnosis) and keeps the part that is reliably deliverable and visibly right or wrong: frames with skeleton overlays.

Capture generalizes across skills for free. Finding "the moment something happens" works the same for a jump, wheelie, manual, bunnyhop, or tailwhip — no per-skill coaching model required.

## 2. The core loop

```
record live  ──┐
               ├─→  find the window  ─→  crop the moment  ─→  pose-overlaid record  ─→  tag  ─→  history  ─→  share
pick from     ─┘    (AI proposes,        (FFmpeg on the       (key frames, filmstrip,   (skill +
photo library       manual slider         worker)              timeline curves)          spot + free)
                    always available)
```

External video links are out (removed). Garage and Tools are hidden in v1 (unrouted, kept in the codebase) — see §0.

## 3. Connectivity ladder (offline is the normal case)

At a trail, one bar of signal is normal. The capture loop must complete offline; connectivity only adds convenience.

1. **Connected:** AI window-finding proposes the trim in seconds; the sliders come pre-filled; rider confirms or nudges.
2. **Poor/no connection:** a short timeout (or reachability check) silently flips to **manual trim** — two-handle slider over on-device thumbnails. The rider knows when their jump happened; this takes seconds.
3. **Always:** heavy work (upload, crop, pose overlays) is **queued, never blocking**. Offline capture saves a *pending record* (video reference, trim window, tags, GPS, timestamp); a background queue completes it on WiFi. Filming all day at the spot and finding finished records at home is the intended experience, not a degraded one.

Manual trims are saved as ground truth — every hand-placed window is a labeled example that trains the future free local detector. The fallback funds its own obsolescence.

## 4. Storage tiers — archive the moment, not the footage

A rider's 45s clip contains ~3s of jump. The record (trimmed 720p window clip + overlay frames + pose series + tags) is ~2–5MB; the original is 30–40MB. Archive the small, valuable part.

| Tier | What | Where |
|---|---|---|
| Device | Original full video | Rider's photo library (not duplicated in-app) |
| Device + Cloud | **The record**: trimmed moment clip, pose-overlaid frames, series, tags, metadata | Local first; synced to Supabase Storage |
| Premium (later) | Full original-clip backup | Cloud, opt-in |

- Local-first with background sync. Supabase Storage (S3-compatible, signed URLs, RLS); Cloudflare R2 is the zero-egress escape hatch if shared-clip traffic ever makes egress costs bite.
- ~3MB/record → even 500 jumps ≈ 1.5GB ≈ cents per user per month.
- **Deletion must actually delete** (rows + objects) from the first cloud byte. **Export-my-records (zip)** is offered deliberately: it builds the trust that makes people invest in the archive, and keeps us clean on GDPR/app-store expectations.

## 5. Library, tags, retention

- **No skill field in the UI** (see §0). Records are titled by time ("Today · 14:07"); `SkillType` stays dormant in the data model.
- **Tags** *(built)* — auto `# crash` from the AI review + free tags with one-tap suggestions from previously used tags.
- **Spot** *(later)* — GPS captured at record time; rider names a location once ("Monsanto"), every future session there auto-tags. Zero-friction organization is the only kind that happens.
- Library filters: tag chips *(built)*; spot × date later; session grouping from timestamps.

The archive is the retention engine (data gravity): a rider's history of moments is a progression highlight reel that hurts to abandon. Export exists anyway — see §4.

## 6. Sharing

The point of capture is human analysis, so the shareable artifact is a first-class output:

1. **v1 (built): share the active lens** — the record card's Skeleton/Video toggle decides what Share sends: the skeleton-burned, watermarked mp4 (the growth artifact, rendered by the worker at record time) or the clean trimmed clip.
2. **QR end-card** appended to shared clips once a real domain/App Store URL exists (FFmpeg-trivial; blocked only on the URL).
3. **v2 (with cloud sync): share links** — a viewable record page (trimmed clip + frames + curves) behind a tokenized URL. Every share markets the app.

## 7. Analysis pipeline (built and proven in the Lab)

The Lab (`worker /dev`) already runs the full pipeline end-to-end:

1. Contact sheet (~24 downscaled frames) → **AI window-finding** (Claude, `claude-opus-4-8`) returns event timestamps; verified accurate to ~±0.1s on the crash clip. Capture needs only "the right 2–4 seconds" — margins absorb error.
2. **Dense measurement** inside the window (pose on every frame ≤30fps, bike box every 3rd) → knee/torso/hip-height/pitch series + filmstrip + in-air frames.
3. Overlay rendering from the same normalized geometry the app consumes.

Cost path for window-finding: ~$0.10–0.15/clip today → test a cheaper model (capture precision is far less demanding than coaching was) → **local detector** (the hip-height curve shows the airborne bump) trained on accumulated ground truth from AI windows + manual trims; the AI call then becomes the low-confidence fallback.

End-state on the roadmap: **on-device pose + window detection** (MediaPipe iOS/Android SDKs; requires an Expo dev build). That makes the whole loop work in airplane mode, with the cloud reduced to sync and sharing.

## 8. Build phases

### Phase 1 — Mobile capture loop (the product)
1. Rebuild the Coach tab into the capture flow: record live / pick from photo library → window step (AI-proposed when connected, manual slider always; on-device thumbnails for scrubbing) → record card (trimmed clip, key frames with overlays, filmstrip, timeline).
2. Worker: FFmpeg crop endpoint (stream-copy within margins) producing the trimmed moment clip; record payload = clip + frames + series.
3. Connectivity ladder v1: timeout → manual trim; pending-record queue with retry on reconnect.
4. Lab (supporting): crop endpoint verification; cheaper-model test for window-finding; fix normalized-coordinate angle distortion (compute angles in pixel/world space).
- **Done when:** a rider can film a jump at a trail with no signal, trim it in seconds, and have a finished pose-overlaid record on the phone by the time they're home.
- *Status July 5:* built — capture flow (camera + library), AI window with manual fallback, single-viewport record card (Skeleton/Video toggle in the header), transport controls (frame stepping, 1×/½×/¼× speed), phase-banner event labels, flight metrics (airtime + estimated height, crash-aware, series-snapped, unit-tested), pending/retry. Background WiFi queue still pending.

### Phase 2 — Library, tags, spots
5. Record library screen: filter by skill × spot × date; tag editing; GPS spot capture + naming; free tags with suggestions.
6. Composite share export (strip image / overlay clip) via the share sheet.
- **Done when:** "find that Monsanto jump from last month and send it to a friend" is under 30 seconds.
- *Status July 5:* library poster grid (poster.jpg written at record time) + tag filter chips + full-screen detail sheet + tag editing built; watermarked skeleton/clean share built. Spot/GPS pending.

### Phase 3 — Accounts, sync, share links
7. Supabase auth + storage; records sync local↔cloud; device-loss recovery.
8. Tokenized share links to a viewable record page.
9. Deletion (real) + export-as-zip.
- **Done when:** a new phone restores the full history; deleting the account leaves nothing behind.

### Phase 4 — Cost and offline hardening
10. Local window detection from the pose sweep, validated against accumulated ground truth (AI + manual windows); AI demoted to fallback.
11. On-device pose (Expo dev build) for airplane-mode records — evaluate effort vs. value when reached.

### Phase 5 — parked (superseded by §0)
Per-skill capture presets are rejected: capture already works for any move (AI window when it recognizes the action, manual window always). The only sport-specific string left is the worker's AI prompt ("jump attempt"); loosen it to "the action moment" opportunistically.

Garage/Tools: hidden in v1 (unrouted). They are act two — see §0.

## 9. Success criteria

- **P1:** capture loop works offline end-to-end; AI window accepted without adjustment on >70% of connected captures.
- **P2:** median time from opening the library to sharing a specific old record < 30s.
- **P3:** restore-on-new-phone works; deletion verified empty; ≥1 share link opened per active sharer per month.
- **P4:** local detector matches accepted windows within ±0.5s on ≥85% of the ground-truth set; AI call rate drops accordingly.

## 10. Risks

| Risk | Mitigation |
|---|---|
| Offline/queue complexity (the classic mobile tarpit) | Pending-record model is append-only and idempotent; sync is upload-only until Phase 3 |
| AI window cost at scale | Cheaper-model test early; ground-truth collection from day one; local detector in Phase 4 |
| Pose quality on blurred/small riders | Overlay is presentation, not judgment — imperfect skeletons are visibly imperfect; manual editor exists in the Lab for dataset labeling |
| Cloud video privacy | Records only (not full clips) by default; real deletion; export; consent copy at first sync |
| Scope creep back into coaching | This document; coaching lives in the appendix until capture retention proves itself |
| Worker deployment (phone needs a reachable endpoint beyond LAN) | Deploy in Phase 1 (Fly/Railway); queue tolerates downtime by design |

## Appendix — parked: the coaching layer

Built and working in the Lab, deliberately not in the product: coaching knowledge base distilled from transcripts (`worker/app/knowledge/`), AI frame review with named-mistake identification, rule-based reports, manual geometry labeling (`clips/labels.json`), ground-truth manifest entries. If capture retention proves out and coaching is revisited, the capture archive is exactly the dataset that layer would need — organized clips, windows, pose series, and human commentary from shares. Rider body measurements / RAD tools remain a Garage idea from plan v2.
