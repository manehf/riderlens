# Capture Quality Validation

September 5, 2026. Implemented, tested locally, and deployed to Fly as release v40.
The worker response schema and the mobile app are unchanged by this batch.

## Deployment Record

- Target: `riderlens-worker`, existing machine `80e47eb6d60538` in `cdg`.
- Status: deployed and healthy; public health check and authenticated capture smoke test passed.
- Published tag: `registry.fly.io/riderlens-worker:worker-quality-20260905`.
- Published immutable image: `registry.fly.io/riderlens-worker@sha256:c5096324aea71fee6dad50d701957fefc3e0e2c942d6da632d0bffab9826a915`.
- New version passed health checks at 2026-09-05 01:20:52 UTC; capture completed at 01:23:33 UTC.
- Previous release: v39, image tag `deployment-01KYXBE449BW0YNXQSWTMFVCQ7`.
- Immutable rollback image: `registry.fly.io/riderlens-worker@sha256:72cfbc215ca2f316e6dc703be121fb719f112609f4556a685654e57f01ceee11`.
- Build context now excludes `.env` and `.env.*`; production secrets are unchanged.
- Machine resources remain 8 shared CPUs / 4096 MiB RAM; no additional production machine was created.
- Remote SHA-256 hashes of `app/main.py` and `app/pose_engine.py` match the locally tested files.

### Production Smoke Test

Ran one authenticated `/capture/record` request against the live Uvicorn process
over loopback, uploading the repository fixture and selecting 4.4-5.4 seconds.
Credentials stayed on the worker. Separately verified the public HTTPS health
endpoint through Fly's proxy.

- HTTP 200; unchanged response keys, 30 series entries and 30 decodable JPEGs.
- Response 7.43 MiB; filmstrip 4.16 MiB (below the 12 MiB ceiling).
- Clean clip: 31 decoded frames at 29.8 FPS, approximately 1.040 seconds.
- Skeleton clip: 30 decoded frames at 29.8 FPS, approximately 1.007 seconds,
  with no promotional end-card frames.
- Missing credentials returned 401; `/dev` returned 404.
- Capture reservation was released and health remained OK after completion.
- End-to-end smoke request/validation took 35.9 seconds. The worker logged
  23.6 seconds for measurement/cropping (excluding upload normalization) and
  479.2 MiB RSS at completion; this is not a peak-memory measurement.
- No application traceback or OOM appeared during the test. A transient
  startup health/port warning cleared once Uvicorn finished importing at
  01:20:52 UTC; this was not a persistent port configuration error.
- The temporary test script and uploaded source used for SSH verification were
  removed. The normalized capture copy follows the normal capture TTL cleanup.

Physical iOS/Android playback and sharing checks remain manual. This deploy
changes new analysis outputs, not existing locally saved records.

## Changes and Tradeoffs

1. **One sampling clock.** Sequential decoder timestamps choose the nearest
   source frame for each constant-rate output sample, rather than using rounded
   integer strides. Measurements, filmstrip entries, and the skeleton video use
   that same clock. Output is capped at 60 FPS and 480 frames. The window is
   half-open (`start <= t < end`), avoiding an extra frame at the loop boundary.
   Variable-rate gaps may repeat a source image to preserve playback duration.
   Backends without valid timestamps fall back to source frame positions; this
   cannot reconstruct missing VFR timing information.
2. **Conservative tracking continuity.** Once a person is selected, re-detection
   uses the highest overlapping box (minimum IoU 0.1). A higher-confidence
   distant person does not replace the tracked person. The identity box survives
   missed poses so recovery does not silently select a bystander. Initial
   selection still uses pose confidence, not bicycle association or identity
   recognition. Overlapping people can still be confused; a large camera cut
   or a long occlusion can prevent reacquisition. Prefer missing lines to a
   skeleton on the wrong person; the clean video remains available.
3. **Busy is not an admitted job.** Authentication is unchanged. Acquire the
   capture reservation before spending the IP allowance, and release it even
   when rate enforcement or processing fails. HTTP 429 / `Retry-After: 30`
   remains compatible with the existing app. This does not change the app's
   free-analysis quota or refund logic.
4. **Bounded filmstrip images.** Divide a 12 MiB base64-character budget across
   the expected sampled frames. Keep the existing JPEG quality tiers; reduce
   image dimensions only when an encoded image exceeds its allowance. Preserve
   aspect ratio and every sampled timestamp. This trades some paused-image
   detail for smaller transfer/parsing/storage costs, especially on foliage and
   portrait footage. Clean and skeleton video encoding settings are unchanged.
   The ceiling is not a total response-size or decoded-RAM guarantee.
5. **Encoder cleanup.** Analysis failures and encoder finalization timeouts reap
   FFmpeg and remove partial output, rather than leaving resources behind.

## Local Comparison

Fixture: `clips/regular_jump/fail/jump_fail.mp4`, 1280x720, 29.8 FPS, selected
window 1-9 seconds, normal upload normalization, RTMPose balanced/CPU. Telemetry
and the external AI key were disabled. These are local measurements on one
clip, not production latency or general accuracy benchmarks.

| Measurement | Before | After |
| --- | ---: | ---: |
| Sampled frames / filmstrip entries | 239 | 239 |
| JSON response (MiB) | 43.83 | 30.77 |
| Gzip level 5 (MiB; simulated, not a server setting) | 33.15 | 23.26 |
| Filmstrip base64 (MiB) | 23.81 | 10.74 |
| Clean clip base64 (MiB) | 10.37 | 10.37 |
| Skeleton clip base64 (MiB) | 9.63 | 9.63 |
| Frames with a returned pose | 151 | 146 |
| Median frame confidence | 0.59 | 0.59 |

Tracking was also compared on exactly the same decoded frames using the
pre-change and new engines. The five removed poses are at 6.77-6.91 seconds,
after the fall, with low confidence. Visual inspection found sparse old
landmarks over the bike in this interval, not useful body tracking. This is
not an improvement in detection coverage. More real multi-person footage is
needed to assess how often identity is retained under occlusion.

Three paused-frame comparisons at 4.40, 4.74, and 5.07 seconds retained readable
skeletons, with image widths reduced from 845 px to 718, 718, and 676 px.
Source blur and inference mistakes remain; smaller images do not fix either.

## Automated Validation

Run from `worker/` with installed development dependencies:

```sh
env SENTRY_DSN= ANTHROPIC_API_KEY= .venv/bin/python -m pytest tests/ -q
```

Result: 111 passed; two existing protobuf deprecation warnings. Tests cover
24/29.97/60/90/120/144 FPS, a real FFmpeg-generated VFR file, timestamp-less
seek fallback, EOF, frame ceiling, encoded skeleton duration, portrait/noisy
JPEG budgets, tracking loss/recovery, busy/rate rejection, and encoder cleanup.
Inference is mocked for deterministic continuity tests. The separate real-clip
comparison above exercises RTMPose; ordinary tests default to MediaPipe.

From the repo root: `npm test` (66 passed) and `npm run typecheck` (passed).
No native rebuild was performed and no physical-device test is claimed.

## Release Checks

- Deploy only the worker; no new app fields, database migration, or secrets.
- Review the entire worker diff before deployment: this branch also contains
  the previously approved removal of promotional QR end cards.
- On the current store app, process a new clip and test play/pause, frame
  stepping, clean/skeleton switching, rotation, saving, sharing, and offline
  reopening. Existing saved clips are not rewritten by a worker deployment.
- Include a high-FPS clip and a portrait clip; check the actual selected moment
  against both players. The clean clip still uses stream-copy trimming with
  its existing keyframe/edit-list behavior, which this batch does not change.
- Check Fly error/latency/memory logs and complete a second capture after a
  failed request. Busy retries should not exhaust the IP allowance.
- Roll back to the previous worker image if needed; no data migration is
  involved. Keep a known-good image reference before deploying.

Deferred: mobile retry classification/queueing, poor-quality result messaging,
quota refunds, initial rider disambiguation, asynchronous durable jobs, and
replacing base64 payloads with separately downloaded assets.
