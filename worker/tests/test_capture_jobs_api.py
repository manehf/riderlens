"""Contract coverage for old synchronous clients and opt-in queued clients."""

import json
import threading
import time

import pytest
from fastapi.testclient import TestClient

from app import main
from app.capture_jobs import CaptureJobQueue


PARAMETERS = {"request_id": "analysis-contract-123456789", "start_seconds": "0", "end_seconds": "1"}
RESULT = {
    "clip": "data:video/mp4;base64,Y2xpcA==", "skeletonClip": None,
    "window": {"start": 0, "end": 1}, "series": [], "filmstrip": [], "events": [], "flight": None,
}


@pytest.fixture
def api(monkeypatch, tmp_path):
    monkeypatch.delenv("RIDERLENS_CLIENT_KEY", raising=False)
    monkeypatch.setenv("RIDERLENS_RATE_LIMIT_MAX", "30")
    monkeypatch.setenv("RIDERLENS_LEGACY_WAIT_SECONDS", "0")
    monkeypatch.setattr(main, "CAPTURE_JOB_LOCK", threading.Lock())
    monkeypatch.setattr(main, "CAPTURE_WAIT_LOCK", threading.Lock())
    monkeypatch.setattr(main, "CAPTURE_SUBMIT_LOCK", threading.Lock())
    monkeypatch.setattr(main, "CAPTURE_RESULT_DIR", tmp_path / "results")
    monkeypatch.setattr(main, "CAPTURE_DIR", tmp_path / "captures")
    monkeypatch.setattr(main, "RATE_BUCKETS", {})
    calls = []

    def handler(job):
        calls.append(job.request_id)
        main._save_capture_result(job.request_id, json.dumps(RESULT))

    queue = CaptureJobQueue(tmp_path, handler, max_jobs=2, poll_interval=0.01,
                            acquire_slot=lambda: main.CAPTURE_JOB_LOCK.acquire(blocking=False),
                            release_slot=main.CAPTURE_JOB_LOCK.release)
    monkeypatch.setattr(main, "CAPTURE_QUEUE", queue)
    yield TestClient(main.app), queue, calls
    queue.stop()


def submit(client, **changes):
    return client.post("/capture/jobs", data={**PARAMETERS, **changes},
                       files={"video": ("clip.mp4", b"source video", "video/mp4")})


def wait_ready(queue, request_id):
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        if queue.get(request_id).status == "ready":
            return
        time.sleep(0.01)
    pytest.fail("Job did not complete")


def test_submission_poll_and_result_are_separate_and_deduplicated(api):
    client, queue, calls = api
    assert client.get("/health").json()["captureJobsEnabled"] is True
    response = submit(client)
    assert response.status_code == 202
    assert response.json()["status"] == "queued"
    assert response.json()["jobId"] == PARAMETERS["request_id"]
    assert "clip" not in response.json()
    assert calls == []
    assert submit(client).json() == response.json()
    assert len(list(queue.upload_dir.iterdir())) == 1
    assert sum(map(len, main.RATE_BUCKETS.values())) == 1
    assert client.get(f"/capture/result/{PARAMETERS['request_id']}").status_code == 404
    queue.start()
    wait_ready(queue, PARAMETERS["request_id"])
    assert calls == [PARAMETERS["request_id"]]
    status = client.get(f"/capture/jobs/{PARAMETERS['request_id']}")
    assert status.json()["status"] == "ready"
    assert status.headers["cache-control"] == "private, no-store"
    result = client.get(f"/capture/result/{PARAMETERS['request_id']}")
    assert result.status_code == 200
    assert result.json() == RESULT


def test_full_queue_and_conflicts_do_not_spend_allowance_or_save_upload(api):
    client, queue, _ = api
    assert submit(client).status_code == 202
    assert submit(client, end_seconds="2").status_code == 409
    wrong_video = client.post("/capture/jobs", data=PARAMETERS,
                              files={"video": ("clip.mp4", b"different source", "video/mp4")})
    assert wrong_video.status_code == 409
    assert submit(client, request_id="analysis-other-123456789").status_code == 202
    response = submit(client, request_id="analysis-overflow-123456789")
    assert response.status_code == 429
    assert response.headers["retry-after"] == "30"
    assert len(list(queue.upload_dir.iterdir())) == 2
    assert sum(map(len, main.RATE_BUCKETS.values())) == 2


def test_queue_requires_auth_and_valid_window(api, monkeypatch):
    client, queue, _ = api
    assert submit(client, end_seconds="NaN").status_code == 422
    assert submit(client, end_seconds="9").status_code == 422
    assert submit(client, events_json="{}").status_code == 422
    monkeypatch.setenv("RIDERLENS_CLIENT_KEY", "test-key")
    assert submit(client).status_code == 401
    assert client.get(f"/capture/jobs/{PARAMETERS['request_id']}").status_code == 401
    assert client.get(f"/capture/result/{PARAMETERS['request_id']}").status_code == 401
    assert list(queue.upload_dir.iterdir()) == []


def test_legacy_post_keeps_complete_200_payload_with_queue_enabled(api, monkeypatch):
    client, _, _ = api
    monkeypatch.setattr(main, "_save_capture_upload", lambda video: "0" * 32)
    monkeypatch.setattr(main, "_capture_path", lambda _: "source.mp4")
    monkeypatch.setattr(main, "_process_capture_source", lambda *args: RESULT)
    response = client.post("/capture/record", data={"start_seconds": "0", "end_seconds": "1"},
                           files={"video": ("clip.mp4", b"source", "video/mp4")})
    assert response.status_code == 200
    assert response.json() == RESULT
    assert not main.CAPTURE_JOB_LOCK.locked()


def test_legacy_brief_wait_finishes_without_429(api, monkeypatch):
    client, _, _ = api
    monkeypatch.setenv("RIDERLENS_LEGACY_WAIT_SECONDS", "1")
    monkeypatch.setattr(main, "_capture_path", lambda _: "source.mp4")
    monkeypatch.setattr(main, "_process_capture_source", lambda *args: RESULT)
    assert main.CAPTURE_JOB_LOCK.acquire(False)
    timer = threading.Timer(0.05, main.CAPTURE_JOB_LOCK.release)
    timer.start()
    try:
        response = client.post("/capture/record", data={"start_seconds": "0", "end_seconds": "1", "upload_id": "0" * 32})
    finally:
        timer.join()
    assert response.status_code == 200
    assert response.json() == RESULT
    assert not main.CAPTURE_WAIT_LOCK.locked()


def test_legacy_wait_is_bounded_and_does_not_spend_allowance(api, monkeypatch):
    client, _, _ = api
    monkeypatch.setenv("RIDERLENS_LEGACY_WAIT_SECONDS", "0.02")
    assert main.CAPTURE_JOB_LOCK.acquire(False)
    try:
        response = client.post("/capture/record", data={"start_seconds": "0", "end_seconds": "1"})
    finally:
        main.CAPTURE_JOB_LOCK.release()
    assert response.status_code == 429
    assert main.RATE_BUCKETS == {}
    assert not main.CAPTURE_WAIT_LOCK.locked()


def test_queue_handler_reuses_durable_result_after_interruption(api, tmp_path):
    _, queue, _ = api
    source = queue.upload_dir / "source.mp4"
    source.write_bytes(b"source")
    job = queue.submit(PARAMETERS["request_id"], source, {})
    main._save_capture_result(job.request_id, json.dumps(RESULT))
    # No decoder is needed, even when the source has already been removed.
    source.unlink()
    main._run_capture_job(job)
    assert main._load_capture_result(job.request_id) is not None
