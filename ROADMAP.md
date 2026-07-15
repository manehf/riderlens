# RiderLens Roadmap

Status date: July 15, 2026. One page, kept honest — update as things ship.
Deep background: `riderlens-mvp-plan.md` (product), `riderlens-architecture-infrastructure-review.md` (infrastructure).

---

## Now: ship v1.0.0 to the stores

Builds exist (iOS submitted to TestFlight, Android AAB ready). Remaining, in order:

### Antonio (dashboards)
- [ ] **Subscriptions in App Store Connect** — new RiderLens app → Monetization → group `RiderLens Pro` → `com.riderlens.app.pro.monthly` + `.annual` (same IDs = RevenueCat needs no changes). Attach to the version for review.
- [ ] Verify **Paid Apps agreement** Active + banking/tax (both stores).
- [ ] **Deploy `site/` to Cloudflare Pages** — store listings link to /privacy and /support; must be live before review.
- [ ] **Answer: Play developer account type?** Organization (like Apple MOPIU LDA) → straight to production. Personal (recent) → Google forces 12 testers × 14 days closed testing first.
- [ ] **TestFlight dress rehearsal** on a real phone: install, film, analyze, check splash/icon/paywall.
- [ ] Screenshots (6 shots, shot list in `store/listing.md`) — navigate, Claude frames/finalizes.

### Claude (when the above land)
- [ ] Fill store forms from `store/listing.md` (all copy + privacy/data-safety answers pre-written).
- [ ] Play Console app + `riderlens_pro_v1` subscription + feature graphic.
- [ ] **Flip worker enforcement**: `fly secrets set RIDERLENS_CLIENT_KEY=<value in eas.json>` once store builds are the ones in use.
- [ ] Re-invite testers to the new TestFlight app; retire "RiderLens [MVP]".
- [ ] Submit both stores.

---

## Post-launch, in priority order

1. **Share pages — `riderlens.app/s/{id}`** *(≈3 days — the growth loop)*
   Worker publishes shared clip + metadata to Supabase under an unguessable ID; one static template page injects the video: browser player with frame stepping, phases, airtime + "Get RiderLens" CTA. Share sheet gains "Share link" next to video share (video = reach, page = depth). V1 OG: static "You have to see this send 👀" + brand card; V2: Cloudflare Worker injects per-video poster. Requires deletion path + privacy-page update (explicitly-shared clips are hosted).

2. **Detector-guided pose cropping** *(≈1 day — the accuracy leap)*
   Measured: full-frame pose finds distant riders in only 21–28% of frames; heavy model (shipped) adds a few points. The real fix: the worker's EfficientDet (person+bicycle) locates the rider, pose runs on the zoomed crop, landmarks remap; interpolate 1–2 frame gaps so the skeleton doesn't flicker. (Pose-bbox-following crop measured useless — detection must bootstrap.)

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
- Analysis window ≤ 6s; sources ≤ 30s until on-device export exists.
- Two-line brand: "See your riding, frame by frame." (identity) + "Film it. Frame it. Understand it." (action).
- Electric green is never text on light backgrounds — deep green `#2e7d32` is.
- One identity everywhere: `com.riderlens.app`.
