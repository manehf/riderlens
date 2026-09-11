# Owned HTTPS transfer fault fixture

`worker/scripts/transfer_fault_fixture.py` is a Python 3.9+ standard-library test
server. It receives video submissions, durably records admission, and returns a
queued job. It never calls RiderLens production or runs an analysis. It supports
submission, lost-acknowledgement recovery and idempotency tests; it cannot validate
finished result downloads, model quality, quotas or production load.

No service is deployed by adding this artifact. Device validation needs an endpoint
that you own and can reach from the iPhone, with a certificate trusted by that
phone and matching the hostname. Do not disable certificate verification or change
production ATS settings. Use a dedicated test build, fixture URL and key; do not
send synthetic fault traffic to production.

## Run on an owned test host

Supply a separate private test key as `RIDERLENS_FIXTURE_KEY` through your local
secret/environment setup; configure the test app to send it in `x-riderlens-key`.
Do not reuse or print the production worker key.

```sh
python3 worker/scripts/transfer_fault_fixture.py \
  --host 0.0.0.0 --port 8443 \
  --cert /private/path/test-fullchain.pem \
  --key /private/path/test-private-key.pem \
  --state-dir /private/path/riderlens-fixture-state \
  --upload-bytes-per-second 32768 \
  --drop-ack --response-delay 10
```

TLS is mandatory unless `--allow-http` is explicitly supplied. That exception
only binds `127.0.0.1` or `localhost`, for short local smoke tests:

```sh
python3 worker/scripts/transfer_fault_fixture.py --allow-http --port 8443
```

This HTTP exception is not suitable for physical-device suspension validation.
Startup prints the private state directory; omitted `--state-dir` creates a fresh
private temporary directory. Keep the same directory across fixture restarts to
exercise durable recovery. Ctrl-C stops the process.

## Behavior and acceptance checks

- `GET /health`: authenticated `200`, `captureJobsEnabled: true`.
- `POST /capture/jobs`: requires `Content-Length`, multipart `video`, `request_id`,
  `start_seconds`, `end_seconds`; optional `events_json` and `rotate_degrees`.
  The fixture streams the body to a temporary disk spool, then scans it without
  loading the video into Python memory. Maximum body defaults to 100 MiB.
  Temporary upload bodies are deleted after handling; only hashes/counters remain.
- Accepted jobs return `202` with a matching ID and `queued` status.
  `--drop-ack` closes the first accepted response connection **after** its SQLite
  transaction commits, once per state directory, including across restarts.
  The native networking stack may retry the POST transparently; check counters.
- `--response-delay` delays subsequent accepted acknowledgements after persistence.
  `--upload-bytes-per-second` throttles server reads. TCP/TLS buffers can absorb a
  short upload initially; use 5 MB and 14 MB clips and inspect native timestamps
  rather than assuming perfectly smooth UI progress.
- `GET /capture/jobs/<id>` returns the persisted queued job, or `404` if absent.
  All result paths return `404`. Jobs deliberately stay queued without expiry;
  stop the test afterward so the app does not poll indefinitely.
- Same ID, video content and normalized parameters: one admission, incremented
  POST count. Multipart boundaries may differ. Different content/parameters under
  the same ID: `409`. Malformed fields: `400`; body limit: `413`; invalid key: `401`.
  Server storage or upload connection failure yields `503` when a response remains
  possible. No results, pre-upload IDs, chunked bodies or resumable byte ranges.

Inspect the private SQLite state locally after the test:

```sh
sqlite3 /private/path/riderlens-fixture-state/jobs.sqlite3 \
  'SELECT request_id, accepted_count, post_count, video_sha256 FROM jobs;'
```

For duplicate delivery/recovery, `accepted_count` must remain **1**. `post_count`
counts matching submissions; it can exceed 1 after a native transparent retry.
The app should recover the queued job by ID without starting another upload while
its native transfer is active. The database also retains the first multipart hash,
canonical fingerprint and acceptance time. Console logs include a hashed request
ID only, never authorization headers, body data or source paths.

Validate interruption during upload, successful background completion, loss of
acknowledgement, server restart after acceptance, and re-opening the app. Keep the
release-build/iPhone-without-debugger gate from `docs/ios-analysis-transfer-plan.md`.
The fixture and simulator alone do not prove iOS suspension behavior. Delete the
private fixture state intentionally after inspection; a fresh directory resets
both admissions and the one-time lost-ack flag.
