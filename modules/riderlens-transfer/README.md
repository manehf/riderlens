# RiderLens transfer (iOS)

Local Expo module for the existing multipart `POST /capture/jobs` contract.
The native module is named `RiderLensTransfer`; only iOS is registered.

- `ensureUpload({ attemptId, url, sourceUri?, fields, headers })` persists an intent
  and returns a snapshot, normally `preparing`. It does not await upload completion.
  `fields.request_id` must equal `attemptId`. Without `sourceUri`, provide `upload_id`.
- `reconcile()` enumerates the stable native session, repairs associations and
  returns live work plus unacknowledged terminal receipts. It does not restart
  deferred preparation or suspended tasks before app ownership is checked.
- `resume(transferId)` restarts a current attempt's deferred preparation/task in
  the foreground. Call only after reconciling that transfer against the current
  record; delete/superseded attempts must be cancelled instead.
- `cancel(transferId)` requests cancellation. Treat `cancelling` as an active
  barrier until a later snapshot is `terminal`.
- `acknowledge(transferId)` removes only a terminal receipt. Persist the accepted
  job or retry outcome in app storage before calling it. Repeated ACK is harmless.
- `transferChanged` carries a snapshot; events are hints, not durable storage.

All timestamps are milliseconds since the Unix epoch. A non-2xx HTTP response is
a terminal transport outcome with `status`, not a thrown native API exception.
`body` is bounded to 256 KiB; overflow is an uncertain outcome requiring server
lookup. Preserve `retryAfter` and native error domain/code during normalization.
API failures reject with named codes such as `E_TRANSFER_BUSY`,
`E_TRANSFER_CONFLICT`, `E_TRANSFER_BACKGROUND`, or `E_TRANSFER_NOT_TERMINAL`.

`plugins/withRiderLensTransfer.js` routes only
`<bundle-id>.riderlens.analysis-transfer.v1` to the coordinator before Expo's
subscriber fan-out. Other session callbacks go to `super`. Do not add a second
Expo background-session subscriber for this module.

## Checks

The Foundation implementation can be compiled and executed on the host without
stubbing UIKit:

```sh
xcrun swiftc -module-cache-path /tmp/riderlens-transfer-swift-cache \
  modules/riderlens-transfer/ios/TransferJournal.swift \
  modules/riderlens-transfer/tests/TransferJournalChecks.swift \
  -o /tmp/riderlens-transfer-journal-checks
/tmp/riderlens-transfer-journal-checks
npm test -- tests/transferPlugin.test.ts
```

These cover file preparation and journal correctness, not iOS suspension or
URLSession callbacks. The complete module still requires an iOS SDK build and
the physical-device release gate in `docs/ios-analysis-transfer-plan.md`.

Preparation copies 64 KiB chunks into a unique protected file in Application
Support. Expiring the short preparation background allowance stops the copy;
the durable intent is its restart checkpoint. Only the file-backed URLSession
task supplies long background transfer support. User force-quit can cancel it;
the next app launch reconciles the outcome before another submission.
