# Completed-result download timeout — Sentry 7728975202

## Evidence

[RIDERLENS-APP-C](https://antonio-fernandes.sentry.io/issues/RIDERLENS-APP-C)
recorded two handled errors on Android 1.0.4 (12), affecting one user on
September 12, 2026. The app was active on a cellular connection. The latest
event's breadcrumbs contain both attempts:

| Status GET completed (UTC) | Result GET aborted (UTC) | Interval |
| --- | --- | --- |
| 23:13:49.394 | 23:14:19.411 | 30.017 seconds |
| 23:14:54.529 | 23:15:24.558 | 30.029 seconds |

The upload had been accepted with HTTP 202. The repeated intervals strongly
support the client's 30-second result deadline as the reason for cancellation.
The breadcrumbs do not prove why result retrieval exceeded the deadline, how
many bytes arrived, or whether a later attempt succeeded. The status-to-abort
interval approximates result duration; Android breadcrumbs lack request-start
timestamps here. A successful status code alone does not prove the body arrived.

The September 13 Sentry audit found 40 production events across seven unresolved
issues and 16 distinct users over the preceding seven days. All events were
handled and belonged to 1.0.3/1.0.4. Four events in the preceding 24 hours were
result-recovery failures. Recent iOS events in APP-A and APP-9 also show background
transitions during retrieval, which need the existing foreground deferral path.
Absence of 1.0.5 errors is not evidence that the new builds have been validated.

## Correction

- Give completed-result GETs a dedicated 120-second deadline, including waiting
  for headers, asynchronous body transfer and JSON reading. This provides four
  times the previous allowance for a response containing base64 videos and
  filmstrip frames while retaining a finite foreground wait.
- Retain 30 seconds for job status checks. Finish their timer and lifecycle
  listener before starting result retrieval, so separate requests own separate
  deadlines.
- Track whether the client deadline actually fired. Result timeouts now use
  `RecordReadTimeoutError` with `failure_stage=result_timeout`. Poll timeouts
  retain `result_recovery` and identify `operation=status`.
- Add `readOperation`, `readTimeoutMs`, and `readElapsedMs` to Sentry extras for
  these timeout errors. Unrelated network failures, external aborts, and HTTP
  errors retain their existing classifications.
- Preserve foreground deferral, accepted job identity, saved records and retry
  behavior. Background cancellation takes precedence over a timer firing while
  the app is suspended. A parser handling its own rejection cannot turn an
  aborted health response into a successful preflight.

This change allows slower retrieval; it does not reduce server processing time,
make downloads resumable by byte range, guarantee background downloads, or solve
all network interruptions. A stalled foreground download can now occupy the
local serial queue for up to two minutes before retry scheduling. Native iOS
uploads, Android upload transport and worker response contracts are unchanged.

## Validation and release

- 173 app tests passed across 16 files; TypeScript passed on September 13.
- Regression tests cover a 25-second status response followed by a 75-second
  result transfer, both delayed headers and delayed body, a stalled transfer
  ending at 120 seconds, status JSON timeout at 30 seconds, and recovery using
  the same job without another POST.
- Tests also cover network errors and external aborts distinct from our deadline,
  HTTP 401/429/503 semantics, legacy cached results, health-body cancellation,
  and Android/iOS result-body interruption after 45 seconds followed by recovery.
- These are automated tests using controlled fetch responses and clocks. Real
  Android/iPhone validation on a slow connection and screen-lock/resume remains
  required before public rollout.
- Existing Android 1.0.5 (13) and iOS 1.0.5 (8) artifacts predate this change.
  Both platforms need new builds to distribute it; OTA is disabled. No new store
  build, worker deployment, or Sentry issue resolution was performed for this fix.
