# RiderLens Product & Technical Plan v3 — Capture First

Status date: July 4, 2026.
Supersedes plan v2 (coaching-first). The coaching ambitions are parked, not deleted — see the appendix. `bike-technique-app-prerequisites.md` remains the original scope/design reference; its visual system, safety rules, and filming guidance still apply.

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

External video links are out (removed). Garage and Tools stay in the app as secondary tabs — useful without filming, near-zero maintenance.

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

- **Skill** — structured field (existing `SkillType`), set at capture.
- **Spot** — GPS captured at record time; rider names a location once ("Monsanto"), every future session there auto-tags. Zero-friction organization is the only kind that happens.
- **Free tags** — optional ("360 attempt", "new bike"), suggested from recent tags.
- Library filters: skill × spot × date; session grouping from timestamps.

The archive is the retention engine (data gravity): a rider's history of moments is a progression highlight reel that hurts to abandon. Export exists anyway — see §4.

## 6. Sharing

The point of capture is human analysis, so the shareable artifact is a first-class output:

1. **v1: composite export** — a strip image of 6–10 pose-overlaid frames (and/or a slow-mo overlay clip) that drops into WhatsApp looking great.
2. **v2 (with cloud sync): share links** — a viewable record page (trimmed clip + frames + curves) behind a tokenized URL. Every share markets the app.

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

### Phase 2 — Library, tags, spots
5. Record library screen: filter by skill × spot × date; tag editing; GPS spot capture + naming; free tags with suggestions.
6. Composite share export (strip image / overlay clip) via the share sheet.
- **Done when:** "find that Monsanto jump from last month and send it to a friend" is under 30 seconds.

### Phase 3 — Accounts, sync, share links
7. Supabase auth + storage; records sync local↔cloud; device-loss recovery.
8. Tokenized share links to a viewable record page.
9. Deletion (real) + export-as-zip.
- **Done when:** a new phone restores the full history; deleting the account leaves nothing behind.

### Phase 4 — Cost and offline hardening
10. Local window detection from the pose sweep, validated against accumulated ground truth (AI + manual windows); AI demoted to fallback.
11. On-device pose (Expo dev build) for airplane-mode records — evaluate effort vs. value when reached.

### Phase 5 — More skills
12. Wheelie, manual, bunnyhop, drop, tailwhip as capture presets (window margins and event vocabulary per skill; no coaching models needed).

Garage/Tools: maintained as-is; small improvements opportunistically. Not on the critical path.

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
