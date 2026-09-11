# Capture queue rollout — September 8, 2026

## Deployed worker

- Fly release v43, machine `8d7155be92e578`, Paris (`cdg`). The prior machine was replaced to attach the persistent volume.
- Image: `registry.fly.io/riderlens-worker@sha256:a6e591399f5d82054002a7350ac1b7bd7bb243dd6b493ac18d7974c3f1e35d64`.
- Previous v42 image: `registry.fly.io/riderlens-worker@sha256:8c565b13ade797574e6a6a73b6e9914e86a4664a665a11ae1ee0988e6f00074e`.
- Resources: unchanged 8 shared vCPUs / 4096 MiB. One running machine, one analysis at a time.
- New encrypted volume `vol_re1k2yjpdyzlxql4`, name `capture_jobs`, 5 GB, mounted at `/data`. Scheduled snapshots disabled for temporary media retention.
- `RIDERLENS_JOB_DIR=/data/jobs`, `RIDERLENS_MAX_QUEUED_JOBS=4`, `RIDERLENS_LEGACY_WAIT_SECONDS=10`.
- Autostop disabled: background jobs must complete when the phone disconnects. This increases billed uptime compared with the former suspend-at-idle configuration.

## Compatibility

Build 11 keeps `POST /capture/record` and receives the complete final JSON with HTTP 200. One overlapping legacy request can wait at most ten seconds; overflow still returns 429 / Retry-After 30 without spending IP allowance. No indefinite waiting is added to its five-minute upload/processing/download deadline.

App 1.0.4 negotiates `/health.captureJobsEnabled`, submits once to `/capture/jobs`, persists the attempt/job ID, polls status, and retrieves `/capture/result/{id}` when ready. Older workers still use the synchronous fallback. A lost submission acknowledgement is recovered by ID without reuploading. Queued/busy states are ordinary waiting in mobile diagnostics; permanent failures require manual intervention.

Queue state, inputs, and results survive process/machine replacement using the same volume. Startup requeues interrupted processing; a durably saved result prevents recalculation. A crash before a result is committed can repeat work. The queue is not distributed and is not a backup of the user's library. Multiple machines/processes require a separate shared-dispatch design.

Results/terminal job status expire after 45 minutes, unstarted queued inputs after 24 hours. Completed/failed jobs discard their source. Cleanup runs while the worker is alive. Multipart input spooling precedes endpoint admission; aggregate incoming-body protection remains a separate infrastructure concern.

## Validation

- Full worker suite: 141 passed outside the macOS sandbox. Four real MediaPipe tests initially failed inside the sandbox because NSOpenGLPixelFormat was unavailable; rerunning outside passed them.
- After fingerprint verification was added: all 25 queue/module/API tests passed (18 queue tests plus seven API tests).
- Mobile suite: 87 passed; TypeScript and diff checks passed. Includes retry ordering, deadlines, lost acknowledgements, no-upload polling, terminal errors, local index write recovery, and stale-attempt guards.
- Live `scripts/verify_capture_queue.py`: legacy final response HTTP 200 in 33.78 seconds; two queued submissions HTTP 202 in 0.14 and 0.12 seconds. Both completed. Every result had nine series/filmstrip frames and both video data URLs; authentication and missing-job handling passed. These short-fixture timings are not a general throughput benchmark or physical-device playback validation.
- Health passing with `captureJobsEnabled=true`; Fly config confirms the mounted volume and disabled autostop.

## Mobile release

Version 1.0.4 production builds requested:

- Android build 12: `e9bdcafb-5585-44a7-8102-ebe2b2d21675`.
- iOS build 7: `ab568945-526c-45a0-ba8b-13f431602939`.

Builds include the working tree (including prior session changes); the EAS git label refers to the last commit and does not describe the complete uploaded source. Build completion/store submission are recorded separately when confirmed. Do not raise minimum supported versions: build 11 remains compatible.

## Rollback

For an application regression, deploy the previous v42 image while preserving the volume. Its health response omits the async capability; new clients use the legacy route for new attempts. Existing queued job IDs cannot finish on the old image and must be recovered after the queue-enabled worker returns; a rollback is not a migration of active jobs. Keep the volume and queued inputs until the queue-enabled release is restored or jobs have been deliberately handled. Do not destroy storage as part of a routine rollback.


Release status update (8 September 2026): Android 1.0.4 (12) and iOS 1.0.4 (7) builds finished successfully. iOS EAS submission `af0e8d36-aa04-4cd1-893c-d0a8278a4cb6` finished successfully (App Store Connect upload, not App Review). Android AAB and iOS IPA are saved in `release-artifacts/`. Android production release `12 (1.0.4)` was sent for review through Play Console account `media@mopiu.com`. Publishing overview shows **Changes in review**, after quick checks completed; full rollout is 100% and managed publishing is off. The updated Apple Developer Program License Agreement was accepted on 8 September 2026 with explicit user authorization; its blocking banner disappeared from App Store Connect. iOS version 1.0.4 (build 7) was submitted to App Review on 8 September 2026. App Store Connect confirmed **1 Item Submitted** and **Waiting for Review**, with no remaining draft submissions. Automatic release to all users after approval is configured. [Apple review submission](https://appstoreconnect.apple.com/apps/6790874129/distribution/reviewsubmissions/details/5a95f774-88f4-4dea-a607-c5e0cae67bf7). Further store details are in `docs/releases/1.0.4.md` at the repository root.
