# Android progress recovery after screen lock — Sentry 7726521907

## Evidence

The supplied production event occurred September 11, 2026 at 14:26:04 UTC on
Android 1.0.4 (12). The failed operation was a GET of an existing analysis job,
classified as `result_recovery`, during an automatic retry. Breadcrumbs show
screen off/background, two status-zero GET failures, then foreground/resume.
The exception was handled. The trace supports an interrupted progress check;
it does not establish worker overload, a failed server analysis, or eventual
successful recovery. Network loss versus operating-system suspension cannot be
distinguished from this event alone.

## Confirmed client gap and correction

The 1.0.5 (13) Android build still used the generic no-op
`watchAnalysisBackground`. Only the iOS adapter watched AppState. Therefore a
background interruption of polling could still be classified as an analysis
failure on Android even though retry was possible.

Added `analysisTransport.android.ts` so Metro selects an Android adapter that
aborts foreground health/status/result reads when the app leaves active state.
The existing fetch wrapper remembers that transition even if the rejection is
delivered after resume, then returns `RecordForegroundWaitingError`. The existing
hook preserves the job ID, schedules recovery, avoids incrementing the failure
counter, and records a breadcrumb rather than an analysis-failure exception.
Actual network failures while foreground remain visible and retryable.

Android uploads retain their existing transport. No worker/web deployment or
change to the iOS uploader is part of this correction. It does not guarantee
background execution or recovery after all forms of process termination.

## Validation and delivery

- 36 capture regression tests passed across Android, iOS and legacy API behavior.
- New Android tests cover interrupted polling and result retrieval, delayed error
  delivery after resume, recovery of the same job without a POST, listener/timer
  cleanup, actual foreground failure, and already-background health checks.
- TypeScript passed.
- Physical Android screen-lock/mobile-network recovery remains to be checked.
- The correction was made after Android build 13 was published internally. It
  requires a new Android build/version code; no updated binary was submitted as
  part of this incident investigation. OTA updates are disabled in the event.
