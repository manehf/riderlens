# iOS analysis transfer reliability

Status: implementation completed; native iOS SDK integration and signed 1.0.5 (8)
build passed. TestFlight upload completed on September 11; no public App Review
submission for 1.0.5. Physical-device release gate remains open.
Date: 2026-09-10. Incidents: Sentry 7724795355 and 7724892971, iOS 1.0.4 (7).

## Outcome and scope

An analysis upload must survive ordinary iOS suspension. Opening the app must
reconcile uploads, accepted jobs and results without starting another upload while
the previous native transfer is active. Failed or interrupted work must retain its
source and become recoverable, with an accurate visible phase.

Phase 1 changes the iOS submission transport for `/capture/jobs`, its application
coordinator, progress UI and diagnostics. Keep Android and legacy synchronous
worker compatibility, the current analysis pipeline, quota rules, server API,
four-job capacity and 45-minute terminal/result retention. Polling and result
download remain foreground operations. Native upload completion does not require
foreground JavaScript; final media persistence can wait until the app opens.

This is not a promise of uninterrupted transfer after a user force-quits the app,
byte-range upload resumption, permanent deduplication, or next-day result recovery
without recomputation. Those are different guarantees.

## Evidence and limits

| Incident | Confirmed | Not established |
| --- | --- | --- |
| 7724795355 | Recovery GETs returned 404; a 4,882,432-byte POST was reported; transport failed after approximately 143 seconds; app entered background; client timeout flag was false. | Exact number of bytes received by server, native network error, whether suspension caused failure, eventual recovery. |
| 7724892971 | Client timeout flag and AbortError show the client cancellation path; a 13,631,488-byte POST was reported; background transition; error recorded approximately 14m37 after request start despite a 300-second JS timer. | Exact native cancellation time, whether full upload was accepted, actual server processing duration. |

The delayed timer/error path is consistent with suspension, not proof of its exact
cause. `/capture/jobs` responds after persisting admission; it does not wait for the
analysis pipeline. The current worker-slow message is therefore too specific.
Health checks and unrelated successful analyses cannot establish either user's
outcome. Add correlation rather than infer it.

Existing strengths: local source copy, persisted attempt ID before submission,
job/result lookup before retry, server deduplication by ID/content/parameters,
backoff and Retry-After. Existing gap: a pending fetch holds the local serial queue;
foreground retries inspect pending/failed records rather than reconciling live
processing transfers. Twenty-one existing capture/retry/store tests passed during
both incident reviews; these mock the network and do not validate iOS suspension.

## Transport decision and acceptance contract

Implement a narrow local Expo iOS module under `modules/riderlens-transfer/`, using
Apple's background URLSession. The first implementation milestone is a clean-build
integration spike; production integration depends on passing its acceptance checks.
The module must expose durable task enumeration and terminal receipts, stable background
session restoration, file-based multipart preparation with bounded memory,
native resource timeout, and observable completion of cancellation. Compatibility
must be built against this project's Expo 54 / RN 0.81.5 / New Architecture.

The installed `expo-file-system/legacy` uploader does not satisfy that complete
contract: it uses a random session identifier, does not expose upload reattachment,
builds multipart in memory, reuses a temporary basename and lacks a configurable
native resource deadline. It can improve ordinary suspension, but is not the
selected complete fix by itself.

The independent library review checked the npm release
`@kesha-antonov/react-native-background-downloader@4.6.2`, published commit
`707da821c07136261749a47f0b00099447f3f65a`. It supports uploads, stable sessions and
task enumeration, but its multipart path reads and appends the entire source into
memory; native timeouts are hardcoded to one hour of inactivity and 24 hours of
resource time. Its completion path emits an event and removes persisted task
metadata without the durable receipt/ACK contract required here. Its generated
AppDelegate background handler also lacks the session-specific forwarding needed
for our Expo integration. Adopting it would therefore require owning substantial
native changes rather than a TypeScript adapter. The released source supports the
local-module decision; New Architecture compatibility remains a build/test gate.

This choice adds native code that the project must maintain, but makes its durable
receipt, file preparation and cancellation guarantees explicit and testable. Keep
the module limited to submission transport; application policy stays in TypeScript.
Do not modify generated `ios/` files manually;
integration must survive clean EAS prebuild. Do not migrate Expo/RN as part of this
fix. Use a platform adapter so Android never imports an unavailable iOS module.

### Native ownership and interface

Use one stable, bundle-specific session identifier (development and production
must differ). Persist an atomic native journal and associate both `attemptId`
(server request ID) and `transferId` (unique transport execution) in task metadata.
Only one native submission may run at a time. Other jobs may still be polled.
Pending records are admitted from the foreground; this release does not initiate
all queued videos autonomously while the app is suspended.

```ts
ensureUpload(input): Promise<TransferSnapshot>; // returns after durable scheduling
reconcile(): Promise<TransferSnapshot[]>;       // native tasks + journal + receipts
resume(transferId): Promise<TransferSnapshot>;  // only after checking current ownership
cancel(transferId): Promise<TransferSnapshot>;  // request, possibly still cancelling
acknowledge(transferId): Promise<void>;         // terminal receipt consumed durably
// transferChanged is a notification; snapshots are authoritative after restart.
```

Snapshots include attempt/transfer IDs, preparing/running/cancelling/terminal state,
byte counts, timestamps, HTTP status and a bounded response, or native error
domain/code. `ensureUpload` is idempotent for an active attempt and returns an
existing unacknowledged terminal receipt instead of starting another POST. A new
execution is admitted only after the coordinator has consumed the previous outcome
and checked its durable retry deadline. Changed parameters under the same ID are
rejected. Transport failures and non-2xx HTTP responses are
different outcomes. A cancellation/null result never means accepted submission.

Prepare multipart incrementally into a unique per-transfer file outside purgeable
cache, with atomic rename, checked writes and disk-space errors. Preserve the
existing field names, MIME type, worker key and request ID. Use files accessible
after first unlock, exclude staging/journal from backup, and validate locked-screen
access. Keep the source in the app library. Bound response buffering to 256 KiB;
overflow becomes an uncertain submission outcome to reconcile by request ID.

Ordering: persist intent -> prepare file -> create suspended task with metadata ->
persist association -> resume. Reconciliation enumerates session tasks before
creating replacements, including the crash window between creation and association.
Preparation runs off the JS/main thread. Before a file-backed URLSession task
exists, background transfer guarantees do not apply: if iOS ends a short preparation
background allowance, checkpoint/stop preparation and resume on foreground rather
than pretending an upload is running. Preserve the source and clean partial files.
Persist terminal receipt before notifying JS or completing the system background
event callback. Remove the multipart file only after the native task is terminal;
retain the small receipt until JS has durably consumed it. Sweep incomplete/orphan
preparations only after enumeration proves no task owns them.

### Expo background callback integration

An integration spike must verify completion exactly once and coexistence with
`expo-file-system`, Meta SDK and existing Expo delegates. Installed Expo broadcasts
background-session events and waits for every subscriber; its FileSystem subscriber
stores identifiers without filtering ownership. Simply adding another subscriber
can leave another subscriber's completion pending.

Prefer an idempotent config plugin that routes only the RiderLens session to its
coordinator in the generated AppDelegate and forwards all other identifiers to
`super`. Confirm the pinned template and Swift visibility in a clean prebuild;
fail the plugin clearly if its insertion anchor changes. This must not override
or drop other SDK callbacks. Prove relaunch handling without a running JS bridge.

## Application state and scheduling

Keep `RecordStatus` compatible. Add optional `analysisPhase` and
`analysisTransferId`; migrate records lacking them by checking their existing
attempt/job IDs and native snapshots. Native journal owns transport truth; the
record index owns the rider's record, current attempt and accepted server job.

Phases: preparing -> uploading -> awaiting acceptance -> queued -> processing ->
downloading -> ready. Retryable interruption returns to pending with an explicit
phase/reason. Upload at 100% only means bytes sent, not server acceptance.

Move coordination into a testable service (`analysisCoordinator.ts`) and introduce
a transport interface (`analysisTransport.ts` plus platform implementations).
Separate submit, status and result operations currently combined in `processRecord`.
Keep compatibility tests for the legacy path and existing HTTP error handling.

The JS queue performs short scheduling/persistence operations; it does not await
the lifetime of native uploads. Foreground polling and result requests remain
bounded. On hydration and every transition to active, run a single-flight reconcile
pass covering pending AND processing/uploading records before admitting uploads.
Enumerate all native snapshots, including ones without a matching live record or
current attempt. Cancel orphaned/superseded tasks before admitting replacements;
consume and clean their terminal receipts without applying them to a new attempt.
This also completes interrupted deletion/reprocessing after an app crash.

| Observed state | Action |
| --- | --- |
| Native preparation/running/cancelling exists | Reattach/update progress; do not submit another POST. |
| Unconsumed 202 receipt | Validate matching job ID; persist job/phase; then acknowledge that transfer receipt. |
| Native transport outcome unknown/failed, or retryable response, no active task | First consume any terminal receipt and persist its classification/deadline. Query job/result using the persisted request ID; retry upload only after genuine 404s and the retry deadline, never on lookup transport failure. Permanent rejection takes precedence over this rule. |
| Known queued/processing job | Poll with server delay; no video upload. |
| Ready result | Download/persist in foreground, then mark ready. |
| Server 429 | Preserve shared cooldown and Retry-After, avoiding new native admission during it. |
| Server 410 for upload ID | Recover using the original source as today. |
| Permanent server rejection | Mark failed, require intentional retry/reprocessing. |
| Background during result transfer | Stop/retry foreground retrieval safely; never label this worker-processing timeout. |

For every terminal receipt, persist the accepted job or the failure classification
and retry deadline before ACK. A failed index write leaves the receipt unconsumed
and blocks a replacement upload; foreground reconciliation can safely retry it.

Deletion first persists record removal, then cancels owned transfers and removes
files when native preparation/reading has finished. Reprocessing first persists a
new attempt ID; old native work is cancelled, and new upload waits for terminal
cancellation. Already accepted server work may finish, but cannot update the new
attempt. Use per-attempt media staging plus a serialized commit/current-attempt
check to prevent late results overwriting files, not just late state updates.

## Deadlines and diagnostics

Initial native settings: request inactivity 120 seconds; total resource transfer
and retry budget 30 minutes. These are testable starting policy values, not a claim
that iOS executes callbacks at exact wall-clock deadlines. Background URLSession
automatically waits for connectivity and can retry request timeouts; the resource
deadline supplies the overall bound. Do not run the existing five-minute JS abort
timer against native uploads. Terminal unknown outcomes always reconcile first.

Keep existing bounded health/status/result operations and backoff. Resource deadline
expiry schedules a later app retry; do not immediately loop another 30-minute task.
Cancel/delete remain available while another record is uploading. Exact transition
and native deadline behavior must pass the device gate before release.

Sentry fields: request/transfer ID, phase, app version, native error domain/code,
bytes sent/expected, wall-clock start, background transition, native completion,
receipt persistence, retry count and recovery outcome. Do not log clips, full
multipart/response bodies, local paths, auth headers or personal data. Preserve
Sentry visibility of unexpected/repeated failures; known cancellation is not an
analysis failure. Do not suppress all background transport errors.

Worker observability is an additive separate change: use the same hashed request ID
in admission, accepted, processing, completion and result-recovery logs. Prefer an
early validated correlation header if distinguishing body receipt from admission
is needed; request IDs in multipart alone are available only after body parsing.
No API migration or capacity increase is required for the transport change.

## Implementation sequence and checks

1. **Transport integration spike.** Pin selected implementation; build a minimal
   local native fixture through clean Expo prebuild. Prove stable enumeration,
   durable receipt without JS, streaming multipart, cancellation barrier and Expo
   delegate coexistence. Failure here is a stop for full integration, not a reason
   to ship a blind library swap.
2. **Coordinator and storage.** Implement state/transport interfaces, migration,
   foreground reconciliation, server recovery and delete/reprocess ordering with
   fake transport tests. Existing Android/legacy behavior must remain covered.
3. **Production transport integration.** Wire the native coordinator and HTTP
   outcome normalization. Keep receipts until record persistence succeeds. Test
   local disk failures, native task/receipt recovery and terminal cleanup.
4. **UI and diagnostics.** Show sending percentage, waiting for confirmation,
   waiting for analysis, analysing and retrieving result. Product copy remains
   English. Add correlation and stage-specific error text; verify event semantics.
5. **Device validation and release.** Build TestFlight, run the matrix below,
   review correlated evidence, then submit a new iOS store version. OTA is disabled.

### Required validation matrix

| Layer | Acceptance cases |
| --- | --- |
| JS unit/integration | 404+404+failed POST recovery; 404 with native task still active; accepted response lost; receipt consumed twice; index write fails before ACK; old callback after reprocess; deletion with active transfer; foreground reconciliation includes uploading; native upload never holds all status polling; exact Retry-After/410/permanent-error behavior. |
| Native | Crash at each preparation/task/journal step; stable session reattachment; task missing without receipt; terminal receipt without JS; cancellation requested vs completed; bounded response; HTTP non-2xx; insufficient disk; unique files; no memory allocation proportional to full video; completion callback exactly once including other SDK sessions. |
| Worker contract | Multipart fields/MIME unchanged; request ID preserved; repeated body creates one admitted job within retention; different content under same ID rejected; result recovery and expiry behavior unchanged; run focused queue/API tests. |
| Physical iPhone, release build without debugger | 5 MB and 14 MB clips; lock screen/background for >5 minutes; slow connection; offline then online; switch Wi-Fi/cellular; force quit then reopen; system termination/relaunch where reproducible; server accepts before app terminates; reprocess/delete races; low disk; large supported clip; retry after 45-minute result expiry. |
| Regression | Current mobile suite + typecheck; Android capture/retry regression; legacy worker compatibility; persisted records from 1.0.4; foreground result payload and playback still usable. |

For deterministic device timing tests, use an owned HTTPS fixture that can throttle
reads, drop the acknowledgement, and return delayed status without running costly
analysis. Never introduce faults or synthetic long uploads against production.
Use the same app coordinator and native transport; only the test endpoint changes.

Pass criteria: source preserved; one active native upload per attempt; no new POST
while previous transfer is active; one accepted server job within retention;
pending work never becomes permanently stuck after reopen; no stale result overwrite;
native receipt survives JS loss; no orphaned task-owned files are removed; terminal
staging files are cleaned; error phase and eventual outcome can be correlated.

Simulator and automated tests can establish implementation/build correctness, but
not real iOS suspension behavior. Physical testing is a release gate. The user has
no iPhone; a TestFlight tester or another real-device arrangement is required. Do
not silently substitute simulator evidence. Selecting/booking a paid device service
or contacting a tester requires separate user authorization.

## Rollout, rollback and explicit exclusions

Use an internal TestFlight build first, with a source-level transport switch for
comparison. Turning off native admission must drain/reconcile existing native tasks
before falling back; never leave a background task alive and start fetch for the
same attempt. No remote kill switch is assumed to exist. Store rollback means
pausing rollout and shipping a corrected build, not remotely replacing installed
native code. Do not raise the worker's minimum supported app version.

The implementation uses the build-time `EXPO_PUBLIC_NATIVE_ANALYSIS_UPLOADS=0`
comparison switch. It still loads the native module, consumes receipts and waits
for existing transfers to drain before foreground submission. This is not a
remote switch. Local HTTP development workers keep the foreground transport.

`eas build --platform ios --profile transfer-validation` compiles a release-mode
simulator build through a clean cloud prebuild, without store submission, signing
changes or a build-number increment. Sentry source-map upload is disabled for that
validation profile. It does not satisfy the physical-device gate.

## Implementation evidence

- September 11 release preparation: 154 app tests and TypeScript passed; native
  Foundation checks passed again. Signed iOS 1.0.5 (8) and Android 1.0.5 (13)
  builds completed. iOS was uploaded to App Store Connect/TestFlight; Android
  is available to internal testers. See [the release record](releases/1.0.5.md).
- Local module: `modules/riderlens-transfer/`; session-specific Expo integration:
  `plugins/withRiderLensTransfer.js`. Autolinking resolves `RiderLensTransfer` on iOS.
- `analysisCoordinator.ts` checks ownership before resuming deferred preparation,
  persists before receipt ACK, and cancels orphaned transfers. `capture.ts` consumes
  receipts before health/status calls and uses native scheduling for iOS HTTPS jobs.
- The record index now stores phase/progress, receipt ownership, admission cooldown
  and per-payload detail URI. Durable deletion intents survive crashes. Storage read
  errors stop hydration instead of replacing saved records with an empty library.
- Current automated app suite: 141 tests passing and TypeScript passing; 25 worker
  queue/API compatibility tests passing. Deliberate foreground-read cancellation
  is deferred work and preserves the accepted job rather than reporting failure.
  Foundation
  tests compile and execute the real multipart/journal implementation with a 14 MiB
  binary fixture; UIKit/URLSession lifecycle behavior is not mocked as device proof.
- An owned HTTPS fault fixture is supplied in
  `worker/scripts/transfer_fault_fixture.py`, with instructions in
  `worker/docs/transfer-fault-fixture.md`. Its local smoke verified lost acceptance
  acknowledgement, recovery, repeated submissions with one accepted job, content
  conflicts and SQLite persistence. It does not run the analysis pipeline.
- First full iOS simulator SDK build succeeded on EAS:
  `e6dcf7bf-62d7-4bff-8655-9917c37cf5c3`. The second integration build also succeeded:
  `ca7d2b14-cbf1-4036-b3e9-66a27ca84ad5`. These are compile validation artifacts,
  not TestFlight releases. Foreground-read deferral was added after their archive
  snapshots and is covered by the final TypeScript and automated tests above;
  a release/TestFlight build must use the final working tree.

No site deployment, Android native uploader, on-device trimming/compression,
background result downloader, permanent result retention, new account/auth system,
quota changes or worker scaling in this phase. If retention is extended later,
change both job and result expiry together and size disk usage explicitly.

## Sources

- `src/services/capture.ts`, `analysisRetry.ts`, `recordStore.ts`,
  `src/hooks/useRiderLensMvp.ts`, `src/types/domain.ts`.
- `worker/app/capture_jobs.py`, `worker/app/main.py`,
  `worker/docs/capture-queue-rollout.md`.
- Installed `react-native/Libraries/Network/RCTHTTPRequestHandler.mm`;
  `expo-file-system/ios/Legacy/NetworkingHelpers.swift` and
  `FileSystemBackgroundSessionHandler.swift`;
  `expo-modules-core/ios/AppDelegates/ExpoAppDelegateSubscriberManager.swift`.
- [Apple background sessions](https://developer.apple.com/documentation/foundation/urlsessionconfiguration/background%28withidentifier%3A%29).
- [Apple request timeout](https://developer.apple.com/documentation/foundation/urlsessionconfiguration/timeoutintervalforrequest),
  [resource timeout](https://developer.apple.com/documentation/foundation/urlsessionconfiguration/timeoutintervalforresource),
  [connectivity waiting](https://developer.apple.com/documentation/foundation/urlsessionconfiguration/waitsforconnectivity).
- [Expo local modules](https://docs.expo.dev/modules/get-started/),
  [Expo AppDelegate subscribers](https://docs.expo.dev/modules/appdelegate-subscribers/),
  [Expo 54 legacy FileSystem](https://docs.expo.dev/versions/v54.0.0/sdk/filesystem-legacy/).
- [Background downloader 4.6.2 published native source](https://github.com/kesha-antonov/react-native-background-downloader/blob/707da821c07136261749a47f0b00099447f3f65a/ios/RNBackgroundDownloader.mm)
  and its config plugin at the same published commit (independent source review).
