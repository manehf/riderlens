# RiderLens Roadmap

Status date: July 15, 2026. One page, kept honest — update as things ship.
Deep background: `riderlens-mvp-plan.md` (product), `riderlens-architecture-infrastructure-review.md` (infrastructure).

---

## September 8: compatible persistent analysis queue

- Worker v43 deployed: legacy build 11 still receives the final synchronous result; one overlap can wait up to ten seconds. A separate capability-negotiated API accepts up to four queued/processing jobs, dispatching one at a time.
- SQLite, input videos and results use a 5 GB encrypted Fly volume. The worker stays running to finish jobs after the app closes. This adds persistence and absorbs bursts; it does not increase simultaneous pose processing or provide multi-machine dispatch.
- App 1.0.4 has serial requests, persisted job IDs/deadlines, Retry-After/backoff, progress polling without repeat uploads, and waiting UI without Sentry failure noise. Index writes are serialized and recoverable.
- Validation: 87 mobile tests/typecheck; full worker suite 141 passed, plus updated focused queue/API suite 25 passed. Production legacy and two queued fixture analyses completed. Android build 12 and iOS build 7 requested; store release still depends on successful builds and submission/review.
- Details and rollback: `worker/docs/capture-queue-rollout.md`.

---

## September 7: interrupted-response recovery

- Completed analysis responses are cached on the worker for 45 minutes behind an unguessable per-attempt ID. When Android or iOS suspends the app during the response download, foreground/manual retry retrieves the completed payload instead of uploading and processing the video again.
- Explicit reprocessing creates a new attempt ID, while automatic/manual retries preserve it. Older pending records use a deterministic migration fallback.
- Client errors now distinguish reachability, request transport/timeout, worker response, result recovery, response download, and local save in Sentry/GA4 diagnostics.
- Validation: TypeScript check, 66 app tests, 116 worker tests plus focused idempotency tests. One existing real-MediaPipe macOS test remains environment-dependent because headless OpenGL creation can fail; the rest of the worker suite passes.

---

## September 5: worker reliability batch (deployed, Fly v40)

- Decoder-timestamp resampling replaces integer frame strides in `measure_window`; the filmstrip, measurements, and skeleton video share a constant-rate clock, capped at 60 FPS / 480 samples. Missing decoder timestamps fall back to source frame positions.
- RTMPose re-detection prefers the previous person's overlapping box, including after missed detections, rather than switching to a more confident distant bystander. Initial rider selection and large camera cuts remain limitations; this is continuity, not person recognition.
- Busy `/capture/record` responses no longer spend the IP rate allowance. Authentication and rate enforcement remain in place; mobile free-analysis quota and retry scheduling are unchanged.
- Filmstrip base64 images have a combined 12 MiB ceiling without thinning sampled frames. Resolution adapts when needed; both video encodings are unchanged. Local 8-second fixture: JSON 43.83 -> 30.77 MiB, 239 frames retained.
- Failed analysis and encoder timeouts now close/reap the video encoder and remove temporary output.
- Validation: 111 worker tests, 66 app tests, TypeScript check, real RTMPose comparison. Deployed September 5: public health and an authenticated production capture passed (30 frames, both videos decoded, no end card). See `worker/docs/capture-quality-validation.md` for image/rollback references, tradeoffs, and release checks. No app rebuild was needed; existing saved records are unaffected. Physical-device playback verification remains manual.

---

## Now: ship v1.0.0 to the stores

Builds exist (iOS submitted to TestFlight, Android AAB ready). Remaining, in order:

### Antonio (dashboards)
- [x] **Subscriptions in App Store Connect** — new RiderLens app → Monetization → group `RiderLens Pro` → `riderlens.pro.monthly` + `riderlens.pro.annual` (fresh IDs - Apple permanently burns subscription product IDs account-wide, even deleted ones; RC entitlement + offering repointed). Attach to the version for review.
- [ ] Verify **Paid Apps agreement** Active + banking/tax (both stores).
- [x] **Deploy `site/` to Cloudflare Pages** — live at riderlens.app. — store listings link to /privacy and /support; must be live before review.
- [x] **Play developer account type: Organisation (MOPIU, LDA)** — no closed-testing requirement; straight to production once review passes.
- [x] Dress rehearsal (Android internal testing; iOS via simulator + Test Store) on a real phone: install, film, analyze, check splash/icon/paywall.
- [x] Screenshots — Antonio's designed set in `store/screenshots-2/` (+ Play derivatives, feature graphic).

### Claude (when the above land)
- [x] **Apple submitted July 16** — version 1.0.0 (build 3, 8s window, iPhone-only) + both subscriptions, manual release. Play forms in progress.
- [x] **Play submitted July 16** — vc7 (health permissions BODY_SENSORS/ACTIVITY_RECOGNITION stripped — they triggered Play's health-apps policy gate; READ_MEDIA_VIDEO declared as core-feature use; advertising ID declared unused). Managed publishing on — go-live is a manual click after approval.
- [x] **Worker enforcement live (July 16)** — anonymous requests get 401; production builds carry the key.
- [ ] Re-invite testers to the new TestFlight app; retire "RiderLens [MVP]".
- [x] Both stores submitted July 16. Remaining: on approval, release Apple (manual) + publish Play (managed) together; retire "RiderLens [MVP]" TestFlight app.
- [ ] **v1.0.1 batch sits in the repo** — Share-link button, capture-stepper seek fix, fragmented-MP4 warning, record-player polish (July 20: flush sheet with edge-to-edge viewer and tags below the player; bigger draggable filmstrip; portrait-fullscreen controls docked under the footage instead of the home indicator; landscape fullscreen rebuilt as edge-to-edge video + auto-hiding overlay with the same filmstrip scrubber — the Slider fallback is gone; portrait re-locks *before* the fullscreen modal dismisses, killing the sideways-sheet bug). First post-launch release (or rides a rejection resubmission for free).
- [ ] **While the app sits in review: build #9 (detector-guided pose crop).** Worker-side only — deploys to Fly independent of store review, no app update needed; every user (and possibly the review tester) gets it transparently. Decision: don't block submission on pose quality; don't wait for launch to fix it either.

---

## Post-launch, in priority order

1. **Share pages — SHIPPED July 17.** Live at `https://s.riderlens.app/{id}`: worker-rendered `share.html` (frame stepping, ¼ speed, metric chips, download band), clip + poster + `meta.json` under an unguessable ID in the public `shares` Supabase bucket, per-URL OG tags with an ffmpeg-extracted poster and personalized "«name» shared a send with you 👀". Fly `auto_stop_machines = 'suspend'` keeps cold first-paint ~1s. App-side "Share link" button rides v1.0.1. Removal path: mailto on the page until #3 release two ships revocation.

2. **Detector-guided pose cropping — SHIPPED July 16.** RTMPose-m (halpe26, ONNX) behind `POSE_ENGINE=rtmpose` on Fly: YOLOX detection every 5th frame with pose-tracked boxes between, 26→33 landmark remap, honesty gate (no rider → no skeleton). Measured on the failing clip through production: **49% → 78% of frames with skeleton**, +12s wall (60→71s). Rollback: `fly secrets unset POSE_ENGINE`. Deferred polish: teleport-joint rejection, 1–2-frame gap interpolation, bicycle-prior person disambiguation. Original plan (superseded):
   Measured: full-frame pose finds distant riders in only 21–28% of frames; heavy model (shipped) adds a few points. The real fix: the worker's EfficientDet (person+bicycle) locates the rider, pose runs on the zoomed crop, landmarks remap; interpolate 1–2 frame gaps so the skeleton doesn't flicker. (Pose-bbox-following crop measured useless — detection must bootstrap.) The bicycle box disambiguates the rider from bystanders and bridges frames where person detection blips. Companions: draw nothing when no person is detected (no more skeletons on wooden beams), and reject joints that teleport between frames.
   *Endgame once the crop pipeline exists:* swap BlazePose inside the crop for **RTMPose** (ONNX, ~75 COCO AP at CPU-friendly ~30–60ms/crop — near-ViTPose accuracy without a GPU); ViTPose itself only if we ever get a GPU worker. Both are top-down (need the detector anyway) and output COCO-17 keypoints — minor overlay remap, feet approximated from ankles.

3. **Shared-session import + QR** *(the receiving half of the growth loop — two releases; plan settled July 19)*
   A filmer shares a jump; the rider previews it and saves an independent local copy — account-free, never auto-saved, works offline after saving. **Import costs no quota** (it consumes no analysis compute); reprocessing an imported clip follows normal quota rules.

   **Release one — enriched package, deep links, import preview, Show QR** *(needs a native rebuild; v1.0.2-class, after the v1.0.1 batch)*:
   - **Share package** (`worker/app/main.py` `create_share`): upload `clean.mp4` + `skeleton.mp4` + `poster.jpg` + `detail.json` + versioned `meta.json` (`schemaVersion`, `shareId`, `createdAt`, `skillType`, `durationSeconds`, `sharedByName`, `flight`, `events`, asset names). Evolve `POST /share` in place — no distributed build calls it (the Share-link button first ships in v1.0.1), so no `/shares/v2`. Form field `rider_name` → `shared_by_name`: the app owner is usually the filmer, not the rider. Share IDs `token_urlsafe(8)` → `token_urlsafe(16)` (128 bits); the response adds a separate 128-bit `deleteToken` the app stores with the record. Keep the public `shares` bucket + capability-link model — no signed URLs, no private bucket. Antonio (dashboard): confirm anon can read objects but **cannot list** the bucket.
   - **Deep links**: links tapped in other apps (WhatsApp, Messages) use Universal Links / App Links — `associatedDomains` + verified `https://s.riderlens.app` intent filter in `app.json`, `apple-app-site-association` + `.well-known/assetlinks.json` served by the worker. The share-page "Open in RiderLens" button uses `riderlens://s/{id}` with a store fallback + iOS Smart App Banner, because iOS suppresses same-domain universal-link handoff for in-browser taps. No router in the app: handle cold-start and foregrounded URLs with `Linking` in `App.tsx`. Uninstalled recipients land on the share page → store; after installing they reopen the original message link.
   - **Import** (new service + `src/hooks/useRiderLensMvp.ts`): fetch manifest → preview sheet (clean/skeleton toggle, airtime + height, sharedByName, `Save to my library` / Cancel) → download into a temp dir, validate manifest + required files, move atomically into `records/<newId>/`, write the record with `origin: "shared"` + `sourceShareId` (also the duplicate-import guard), clean clip as `sourceVideoUri`, status `ready` immediately. Clean temp files on failure or cancel.
   - **Show QR** in the share dialog (`src/components/RecordCard.tsx`; `createShareLink` in `src/services/capture.ts` gains `ensureRecordShare(record)` so repeat shares reuse the upload): black-on-white QR of `https://s.riderlens.app/{id}`, copy-link + system share, "Anyone with this QR can view and save this jump". QR rendering is pure JS over react-native-svg (already installed via lucide). Rides release one if ready, else release two.

   **Release two:** revocation UI (`DELETE /share/{share_id}` with the stored delete token), cleanup tooling, analytics. September 4 decision: drop promotional QR end cards from generated videos; use share links for app discovery instead. The worker change shipped September 5 in Fly v40. Existing local clips and hosted shares keep their encoded end cards until regenerated; the player retains its legacy loop boundary.

   **Retention & revocation (settled):** no automatic expiry; the sender can revoke. Share URLs stay permanently resolvable — a revoked/deleted share renders a branded tombstone page (a `share.html` variant), never a generic 404, so QR codes burned into videos never dead-end. Revocation cannot recall already-imported copies (say so in the UI). Share pages stay `noindex`; the privacy page's hosted-clips section covers hosting (redeploy `site/` — the live copy predates it). Dropped by decision: `/shares/v2`, remote feature flag, `allowSave`, private bucket/signed URLs, automatic expiry.

4. **Queue polish**: submit pending records one-by-one instead of racing the worker lock (removes "worker busy" noise in multi-record sessions). Cancel-while-processing as a nicety.

5. **AI rider card** *(fun/marketing)*: Gemini Flash image gen via the locked-down worker (~4¢/img) — library-picked selfie → branded rider card → share. Privacy + data-safety updates required (faces, Google as processor).

6. **On-device trim/export** *(unlocks GoPro)*: native module (AVFoundation / Media3) exports the selected ≤8s clip on-device; only that uploads. Then raise library picks 30s → 5 min. Architecture review §14–15 has the full spec.

7. **Someday: on-device analysis** — the same RTMPose exists compiled for phone NPUs (Qualcomm AI Hub "RTMPose_Body2d" for Snapdragon; CoreML route for iPhone). Would eliminate upload latency and per-analysis server cost at the price of two native inference stacks and losing server-deploy upgradability. Revisit if server costs or offline demand ever justify it.

8. **Phase 2 backend** *(when paying users justify it)*: Supabase Auth (Sign in with Apple + magic link), server-side free-quota + entitlement checks, durable async jobs (schema already provisioned), outputs as objects instead of base64 JSON. Then: record backup/restore for Pro. Privacy policy rewrite **before** any of it goes live.

9. **Mobile attribution / AppsFlyer** *(defer until paid acquisition has meaningful volume)*: keep the current measurement stack for now — GA4 for the in-app analysis funnel, Meta App Events for Meta campaigns, RevenueCat for trials/subscriptions/revenue, and Sentry for failures. Revisit AppsFlyer when acquisition spend reaches roughly **€300–500/month**, when two or more ad networks are running at useful volume, or when Reddit install/post-install attribution is needed for campaign optimization. At that point, integrate the React Native SDK in both store builds, configure iOS SKAdNetwork/ATT and Android Install Referrer, connect Meta + Reddit, and forward only decision-useful events (`install`, `app_open`, `analysis_completed`, `start_trial`, `subscribe`, `purchase`). Update App Store privacy details, Google Play Data Safety, and the privacy policy before release. Use one MMP only; do not add Adjust, Branch, Kochava, or Singular in parallel.

---

## Known debt (from the July 14 audit — fix opportunistically)

- `index.json` writes unserialized → rare corruption wipes the visible library (recovery returns `[]`). Add write queue + temp-file rename.
- Permanent worker rejections retry forever every 30s ("failed" state is dead code). Distinguish 4xx → terminal.
- Delete-mid-processing leaves orphaned payload files on disk.
- Full base64 filmstrip in one `detail.json` — OOM risk on 2–3GB Androids; store strip thumbnails separately or generate locally from clips.
- Decoder-timestamp sampling shipped in the September 5 batch above. Clean-clip stream-copy/keyframe behavior and timestamp-less decoder fallbacks still need device coverage.
- Legacy `/analysis/regular-jump` + `/jobs/{id}/analyze` endpoints + client: remove (the jobs route becomes live cross-tenant risk when Supabase keys land on Fly).
- README.md materially stale (documents legacy endpoints, nonexistent screens).
- No CI — add GitHub Actions running tsc + vitest + worker pytest.
- Worker model file (`efficientdet_lite2.tflite`) gitignored but Dockerfile depends on it — fresh clone can't build; commit via LFS or fetch in Dockerfile.
- Fragmented MP4s (streaming containers) scrub unreliably in the trim preview — cameras never produce them; the picker warns since v1.0.1 (`videoFormat.ts`); a real fix needs precise-timing asset flags in expo-video (upstream).

## Standing decisions (so they don't get relitigated)

- Free = 3 analyses **per month** (device-local reset; server-enforced in Phase 2). Deleting records does **not** refund analyses.
- Camera stays out of the app: film native, pick from library (originals always safe in Photos).
- Analysis window ≤ 8s (raised from 6s on July 15 device feedback); sources ≤ 30s until on-device export exists.
- Two-line brand: "See your riding, frame by frame." (identity) + "Film it. Frame it. Understand it." (action).
- Electric green is never text on light backgrounds — deep green `#2e7d32` is.
- One identity everywhere: `com.riderlens.app`.
- **No skeleton beats a wrong skeleton**: when the detector finds no rider in a frame, draw nothing (ships with #9). Hallucinated lines on beams read as "broken"; a briefly-absent skeleton reads as honest.
- **Shares are capability links**: public bucket + unguessable 128-bit ID; no accounts, no automatic expiry; sender can revoke, and revoked URLs render a branded tombstone — never a 404 (QR codes burned into videos must never dead-end). Importing a shared session is free (no analysis compute); reprocessing an import follows normal quota rules.
- Share metadata carries `sharedByName`, never `riderName` — the app owner is usually the filmer, not the rider.
- Generated clips contain only analyzed footage, with no promotional QR end cards. App discovery belongs on the share page. The existing watermark is unchanged; Pro watermark policy is a separate decision.
