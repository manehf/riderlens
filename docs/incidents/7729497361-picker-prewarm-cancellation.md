# Picker warm-up cancellation — Sentry 7729497361

## Evidence

[RIDERLENS-APP-D](https://antonio-fernandes.sentry.io/issues/RIDERLENS-APP-D)
recorded eight events from five users on Android `com.riderlens.app@1.0.5+14`
in the September 13, 2026 audit. First seen: 09:52:39 UTC; latest event:
13:58:10 UTC. The mechanism is `onunhandledrejection`.

The reported event shows a tap on the add action, an activity pause, a cancelled
`GET /health`, and an activity resume. The stack identifies the intentional
`RecordForegroundWaitingError` emitted when a foreground read is interrupted.
It does not establish a failed upload, lost record, server overload, or a crash.
The low battery reading alone does not establish a cause.

## Cause and correction

`App.onCapturePress` started `isAnalysisWorkerReachable()` without awaiting or
handling its rejection, then opened the native picker. The lifecycle guard
correctly cancelled the health probe when the activity paused. Unlike the
processing and retry paths, this optional warm-up caller did not handle the
foreground deferral, so Sentry recorded a global promise rejection. The generic
"analysis is saved" exception message was misleading in this pre-upload context.

The add action now uses `prewarmAnalysisWorker`, which handles its own rejection.
An expected foreground deferral finishes quietly; an unexpected defect is
reported with `failure_stage=worker_prewarm`. The picker starts immediately.
There is no global Sentry filter, timeout increase, or change to actual analysis
failure classification. Processing still preserves deferred work and job IDs.
An interrupted warm-up does not cache the worker as unavailable.

The same event also contained `readAsStringAsync` deprecation warnings. The
fragmented-MP4 probe imported this method from `expo-file-system`; in the installed
SDK 54 version, that entry point warns and throws. Its existing catch returned
false, disabling format detection while allowing import to continue. It now uses
`expo-file-system/legacy`, consistent with record storage and the
[Expo SDK 54 documentation](https://docs.expo.dev/versions/v54.0.0/sdk/filesystem/#using-legacy-filesystem-api).
The probe still reads only the first 64 KiB and an unreadable file does not block
import. This warning was independent of the foreground cancellation.

## Validation and delivery

- All 181 app tests across 17 files passed; TypeScript passed.
- Android adapter regression covers picker/background interruption, delayed
  native error delivery after resume, no Sentry error, no remaining timers or
  listeners, and retrieval of the same job without another upload.
- Warm-up tests cover expected deferral, reachable/unreachable results, and
  reporting unexpected errors. Existing Android/iOS processing tests retain
  foreground deferral and real error handling.
- File tests exercise regular and fragmented containers through the legacy read
  API, the 64 KiB bound, and an unreadable file.
- Native-device picker/return and record recovery still need validation on the
  replacement signed builds. Automated tests do not substitute for that check.

The fix affects shared Android/iOS app code. Existing Android build 14 and iOS
build 9 do not contain it. New mobile builds are needed because OTA is disabled;
a web/worker deployment cannot fix this caller. No new build, store submission,
review cancellation, or Sentry issue resolution was performed for this incident.
The prior iOS submission uses manual release after approval.

## Separate finding

The build-14 Sentry search also found
[RIDERLENS-APP-E](https://antonio-fernandes.sentry.io/issues/RIDERLENS-APP-E):
three billing warning events from one user. The latest is a restore operation
with RevenueCat code `3` (`PURCHASE_NOT_ALLOWED_ERROR` in the installed SDK).
That is separate from this cancellation; these data do not establish a global
RevenueCat configuration fault. Billing behavior was not changed in this fix.
