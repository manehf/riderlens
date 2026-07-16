# RiderLens Roadmap

Status date: July 15, 2026. One page, kept honest — update as things ship.
Deep background: `riderlens-mvp-plan.md` (product), `riderlens-architecture-infrastructure-review.md` (infrastructure).

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
- [ ] **While the app sits in review: build #9 (detector-guided pose crop).** Worker-side only — deploys to Fly independent of store review, no app update needed; every user (and possibly the review tester) gets it transparently. Decision: don't block submission on pose quality; don't wait for launch to fix it either.

---

## Post-launch, in priority order

1. **Share pages — `riderlens.app/s/{id}`** *(≈3 days — the growth loop)*
   Worker publishes shared clip + metadata to Supabase under an unguessable ID; one static template page injects the video: browser player with frame stepping, phases, airtime + "Get RiderLens" CTA. Share sheet gains "Share link" next to video share (video = reach, page = depth). V1 OG: static "You have to see this send 👀" + brand card; V2: Cloudflare Worker injects per-video poster. Requires deletion path + privacy-page update (explicitly-shared clips are hosted).

2. **Detector-guided pose cropping — SHIPPED July 16.** RTMPose-m (halpe26, ONNX) behind `POSE_ENGINE=rtmpose` on Fly: YOLOX detection every 5th frame with pose-tracked boxes between, 26→33 landmark remap, honesty gate (no rider → no skeleton). Measured on the failing clip through production: **49% → 78% of frames with skeleton**, +12s wall (60→71s). Rollback: `fly secrets unset POSE_ENGINE`. Deferred polish: teleport-joint rejection, 1–2-frame gap interpolation, bicycle-prior person disambiguation. Original plan (superseded):
   Measured: full-frame pose finds distant riders in only 21–28% of frames; heavy model (shipped) adds a few points. The real fix: the worker's EfficientDet (person+bicycle) locates the rider, pose runs on the zoomed crop, landmarks remap; interpolate 1–2 frame gaps so the skeleton doesn't flicker. (Pose-bbox-following crop measured useless — detection must bootstrap.) The bicycle box disambiguates the rider from bystanders and bridges frames where person detection blips. Companions: draw nothing when no person is detected (no more skeletons on wooden beams), and reject joints that teleport between frames.
   *Endgame once the crop pipeline exists:* swap BlazePose inside the crop for **RTMPose** (ONNX, ~75 COCO AP at CPU-friendly ~30–60ms/crop — near-ViTPose accuracy without a GPU); ViTPose itself only if we ever get a GPU worker. Both are top-down (need the detector anyway) and output COCO-17 keypoints — minor overlay remap, feet approximated from ankles.

3. **Queue polish**: submit pending records one-by-one instead of racing the worker lock (removes "worker busy" noise in multi-record sessions). Cancel-while-processing as a nicety.

4. **AI rider card** *(fun/marketing)*: Gemini Flash image gen via the locked-down worker (~4¢/img) — library-picked selfie → branded rider card → share. Privacy + data-safety updates required (faces, Google as processor).

5. **On-device trim/export** *(unlocks GoPro)*: native module (AVFoundation / Media3) exports the selected ≤6s clip on-device; only that uploads. Then raise library picks 30s → 5 min. Architecture review §14–15 has the full spec.

6. **Phase 2 backend** *(when paying users justify it)*: Supabase Auth (Sign in with Apple + magic link), server-side free-quota + entitlement checks, durable async jobs (schema already provisioned), outputs as objects instead of base64 JSON. Then: record backup/restore for Pro. Privacy policy rewrite **before** any of it goes live.

---

## Known debt (from the July 14 audit — fix opportunistically)

- `index.json` writes unserialized → rare corruption wipes the visible library (recovery returns `[]`). Add write queue + temp-file rename.
- Permanent worker rejections retry forever every 30s ("failed" state is dead code). Distinguish 4xx → terminal.
- Delete-mid-processing leaves orphaned payload files on disk.
- Full base64 filmstrip in one `detail.json` — OOM risk on 2–3GB Androids; store strip thumbnails separately or generate locally from clips.
- `measure_window` timestamps synthesized (keyframe-seek offset + non-integer-fps drift) — use decoder timestamps.
- Legacy `/analysis/regular-jump` + `/jobs/{id}/analyze` endpoints + client: remove (the jobs route becomes live cross-tenant risk when Supabase keys land on Fly).
- README.md materially stale (documents legacy endpoints, nonexistent screens).
- No CI — add GitHub Actions running tsc + vitest + worker pytest.
- Worker model file (`efficientdet_lite2.tflite`) gitignored but Dockerfile depends on it — fresh clone can't build; commit via LFS or fetch in Dockerfile.

## Standing decisions (so they don't get relitigated)

- Free = 3 analyses **per month** (device-local reset; server-enforced in Phase 2). Deleting records does **not** refund analyses.
- Camera stays out of the app: film native, pick from library (originals always safe in Photos).
- Analysis window ≤ 8s (raised from 6s on July 15 device feedback); sources ≤ 30s until on-device export exists.
- Two-line brand: "See your riding, frame by frame." (identity) + "Film it. Frame it. Understand it." (action).
- Electric green is never text on light backgrounds — deep green `#2e7d32` is.
- One identity everywhere: `com.riderlens.app`.
- **No skeleton beats a wrong skeleton**: when the detector finds no rider in a frame, draw nothing (ships with #9). Hallucinated lines on beams read as "broken"; a briefly-absent skeleton reads as honest.
