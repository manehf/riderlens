"""Durability, admission and dispatch tests without importing the pose pipeline."""

from concurrent.futures import ThreadPoolExecutor
import hashlib
import multiprocessing
import os
from pathlib import Path
import sqlite3
import threading
import time

import pytest

from app.capture_jobs import CaptureJobQueue, InvalidJobId, JobConflict, JobProcessingError, QueueFull


def stage(queue, name="video.mp4", content=b"source-video"):
    path = queue.upload_dir / name
    path.write_bytes(content)
    return path


def wait_until(predicate, timeout=3):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError("Queue did not reach the expected state.")


def make_queue(tmp_path, handler=lambda job: None, **kwargs):
    return CaptureJobQueue(tmp_path, handler, poll_interval=0.01, **kwargs)


def update_times(queue, request_id, *, created_at=None, updated_at=None):
    with sqlite3.connect(queue.database_path) as connection:
        if created_at is not None:
            connection.execute("UPDATE capture_jobs SET created_at=? WHERE request_id=?", (created_at, request_id))
        if updated_at is not None:
            connection.execute("UPDATE capture_jobs SET updated_at=? WHERE request_id=?", (updated_at, request_id))


def test_submit_is_durable_without_starting_dispatcher(tmp_path):
    called = []
    queue = make_queue(tmp_path, called.append)
    path = stage(queue)
    first = queue.submit("analysis-persistent-123", path, {"end": 2, "start": 1})
    reopened = make_queue(tmp_path, called.append)
    restored = reopened.get(first.request_id)
    assert restored == first
    assert restored.status == "queued"
    assert path.read_bytes() == b"source-video"
    assert called == []


def test_capacity_counts_processing_and_dedupe_does_not_spend_it(tmp_path):
    entered, release = threading.Event(), threading.Event()

    def handler(job):
        entered.set()
        assert release.wait(3)

    queue = make_queue(tmp_path, handler, max_jobs=2)
    first_path = stage(queue, "first.mp4")
    queue.submit("analysis-capacity-1", first_path, {})
    queue.start()
    try:
        assert entered.wait(3)
        queue.submit("analysis-capacity-2", stage(queue, "second.mp4"), {})
        assert not queue.has_capacity()
        duplicate = queue.submit("analysis-capacity-1", stage(queue, "duplicate.mp4"), {})
        assert duplicate.status == "processing"
        assert duplicate.upload_path == first_path
        with pytest.raises(QueueFull):
            queue.submit("analysis-capacity-3", stage(queue, "third.mp4"), {})
    finally:
        release.set()
        queue.stop()


def test_dispatch_is_serial_and_obeys_shared_reservation(tmp_path):
    shared_slot = threading.Lock()
    shared_slot.acquire()
    calls = []
    concurrent = []
    active = 0

    def handler(job):
        nonlocal active
        active += 1
        concurrent.append(active)
        calls.append(job.request_id)
        time.sleep(0.02)
        active -= 1

    queue = make_queue(
        tmp_path, handler, acquire_slot=lambda: shared_slot.acquire(blocking=False),
        release_slot=shared_slot.release,
    )
    for index in range(3):
        queue.submit(f"analysis-serial-{index}", stage(queue, f"{index}.mp4"), {})
    queue.start()
    try:
        time.sleep(0.04)
        assert calls == []
        assert queue.get("analysis-serial-0").status == "queued"
        shared_slot.release()
        wait_until(lambda: all(queue.get(f"analysis-serial-{i}").status == "ready" for i in range(3)))
        assert calls == [f"analysis-serial-{i}" for i in range(3)]
        assert concurrent == [1, 1, 1]
        wait_until(lambda: not list(queue.upload_dir.iterdir()))
        assert not shared_slot.locked()
    finally:
        queue.stop()


def test_dedupe_checks_content_and_parameters_and_keeps_ready(tmp_path):
    calls = []
    queue = make_queue(tmp_path, calls.append)
    original = queue.submit("analysis-dedupe-123", stage(queue), {"start": 1, "end": 2})
    identical = queue.submit("analysis-dedupe-123", stage(queue, "retry.mp4"), {"end": 2, "start": 1})
    assert identical == original
    with pytest.raises(JobConflict):
        queue.submit("analysis-dedupe-123", stage(queue, "different.mp4", b"other-video"), {"start": 1, "end": 2})
    with pytest.raises(JobConflict):
        queue.submit("analysis-dedupe-123", stage(queue, "trim.mp4"), {"start": 1, "end": 3})
    queue.start()
    try:
        wait_until(lambda: queue.get(original.request_id).status == "ready")
        ready = queue.submit(original.request_id, stage(queue, "ready-retry.mp4"), {"start": 1, "end": 2})
        assert ready.status == "ready"
        assert len(calls) == 1
    finally:
        queue.stop()


def test_retryable_failure_requeues_same_input_with_new_upload(tmp_path):
    calls = []

    def handler(job):
        calls.append(job)
        if len(calls) == 1:
            raise JobProcessingError("Try later", retryable=True)

    queue = make_queue(tmp_path, handler)
    original = stage(queue)
    queue.submit("analysis-retryable-123", original, {})
    queue.start()
    try:
        wait_until(lambda: queue.get("analysis-retryable-123").status == "failed")
        failed = queue.get("analysis-retryable-123")
        assert failed.retryable and failed.error == "Try later"
        wait_until(lambda: not original.exists())
        adopted = stage(queue, "retry.mp4")
        retry = queue.submit(failed.request_id, adopted, {})
        assert retry.status == "queued"
        assert retry.upload_path == adopted
        assert retry.error is None
        wait_until(lambda: queue.get(failed.request_id).status == "ready")
        assert len(calls) == 2
    finally:
        queue.stop()


def test_terminal_failure_does_not_reprocess_and_dispatch_continues(tmp_path):
    calls = []

    def handler(job):
        calls.append(job.request_id)
        if job.request_id == "analysis-invalid-123":
            raise JobProcessingError("Unsupported clip", retryable=False)

    queue = make_queue(tmp_path, handler)
    queue.submit("analysis-invalid-123", stage(queue), {})
    queue.submit("analysis-valid-123", stage(queue, "valid.mp4"), {})
    queue.start()
    try:
        wait_until(lambda: queue.get("analysis-valid-123").status == "ready")
        failed = queue.submit("analysis-invalid-123", stage(queue, "retry.mp4"), {})
        assert failed.status == "failed"
        assert not failed.retryable
        assert failed.error == "Unsupported clip"
        assert calls == ["analysis-invalid-123", "analysis-valid-123"]
    finally:
        queue.stop()


def _crashed_dispatcher(directory, entered):
    def handler(job):
        entered.set()
        time.sleep(60)

    queue = make_queue(directory, handler)
    queue.start()
    time.sleep(60)


def test_restart_recovers_a_job_interrupted_by_process_exit(tmp_path):
    queue = make_queue(tmp_path)
    original = stage(queue)
    queue.submit("analysis-crashed-123", original, {"start": 1})
    context = multiprocessing.get_context("spawn")
    entered = context.Event()
    process = context.Process(target=_crashed_dispatcher, args=(tmp_path, entered))
    process.start()
    try:
        assert entered.wait(5)
        assert queue.get("analysis-crashed-123").status == "processing"
    finally:
        process.terminate()
        process.join(5)
    assert original.exists()
    calls = []
    recovered = make_queue(tmp_path, calls.append)
    recovered.start()
    try:
        wait_until(lambda: recovered.get("analysis-crashed-123").status == "ready")
        assert len(calls) == 1
        assert calls[0].parameters == {"start": 1}
    finally:
        recovered.stop()


def test_second_dispatcher_cannot_recover_an_active_job(tmp_path):
    entered, release = threading.Event(), threading.Event()

    def handler(job):
        entered.set()
        release.wait(3)

    queue = make_queue(tmp_path, handler)
    queue.submit("analysis-ownership-123", stage(queue), {})
    queue.start()
    try:
        assert entered.wait(3)
        another = make_queue(tmp_path)
        with pytest.raises(RuntimeError, match="Another capture dispatcher"):
            another.start()
        assert another.get("analysis-ownership-123").status == "processing"
        assert queue.stop(timeout=0) is False
        with pytest.raises(RuntimeError, match="Another capture dispatcher"):
            another.start()
    finally:
        release.set()
        queue.stop()


def test_expiry_preserves_active_processing_and_pending_inputs(tmp_path):
    queue = make_queue(tmp_path, terminal_ttl_seconds=10, pending_ttl_seconds=60)
    pending_path = stage(queue, "pending.mp4")
    processing_path = stage(queue, "processing.mp4")
    queue.submit("analysis-pending-123", pending_path, {})
    queue.submit("analysis-processing-123", processing_path, {})
    with sqlite3.connect(queue.database_path) as connection:
        connection.execute("UPDATE capture_jobs SET status='processing' WHERE request_id='analysis-processing-123'")
    queue.cleanup()
    assert pending_path.exists() and processing_path.exists()
    old = time.time() - 120
    update_times(queue, "analysis-pending-123", created_at=old)
    update_times(queue, "analysis-processing-123", created_at=old, updated_at=old)
    queue.cleanup()
    expired = queue.get("analysis-pending-123")
    assert expired.status == "failed" and expired.retryable
    assert not pending_path.exists()
    assert processing_path.exists()
    assert queue.get("analysis-processing-123").status == "processing"
    update_times(queue, expired.request_id, updated_at=time.time() - 20)
    queue.cleanup()
    assert queue.get(expired.request_id) is None
    assert queue.get("analysis-processing-123") is not None


@pytest.mark.parametrize("request_id", ["short", "../invalid", "a" * 161, "invalid id"])
def test_invalid_ids_and_unmanaged_uploads_are_rejected(tmp_path, request_id):
    queue = make_queue(tmp_path / "queue")
    with pytest.raises(InvalidJobId):
        queue.submit(request_id, stage(queue), {})
    outside = tmp_path / "outside.mp4"
    outside.write_bytes(b"source")
    with pytest.raises(ValueError, match="inside the queue"):
        queue.submit("analysis-outside-123", outside, {})
    assert outside.exists()


def test_same_upload_cannot_be_adopted_by_two_jobs(tmp_path):
    queue = make_queue(tmp_path)
    path = stage(queue)
    queue.submit("analysis-shared-file-1", path, {})
    with pytest.raises(JobConflict):
        queue.submit("analysis-shared-file-2", path, {})


def test_simultaneous_submissions_dedupe_atomically(tmp_path):
    queue = make_queue(tmp_path, max_jobs=1)
    paths = [stage(queue, f"{index}.mp4") for index in range(8)]
    with ThreadPoolExecutor(max_workers=8) as executor:
        jobs = list(executor.map(lambda path: queue.submit("analysis-concurrent-123", path, {}), paths))
    assert len({job.upload_path for job in jobs}) == 1
    assert not queue.has_capacity()


def test_unexpected_failure_hides_internal_exception_details(tmp_path):
    def handler(job):
        raise RuntimeError("secret token and /internal/server/path")

    queue = make_queue(tmp_path, handler)
    queue.submit("analysis-private-error-123", stage(queue), {})
    queue.start()
    try:
        wait_until(lambda: queue.get("analysis-private-error-123").status == "failed")
        failed = queue.get("analysis-private-error-123")
        assert failed.retryable
        assert failed.error == "Analysis could not finish. Your video is saved; please retry."
    finally:
        queue.stop()


def test_cleanup_removes_expired_results_but_keeps_recent_ones(tmp_path):
    queue = make_queue(tmp_path, terminal_ttl_seconds=10)
    result_dir = queue.directory / "results"
    result_dir.mkdir()
    expired = result_dir / ("a" * 64 + ".json")
    recent = result_dir / ("b" * 64 + ".json")
    expired.write_text('{}')
    recent.write_text('{}')
    old = time.time() - 20
    os.utime(expired, (old, old))
    queue.cleanup()
    assert not expired.exists()
    assert recent.exists()


def test_matches_validates_video_and_parameters_without_mutating_the_job(tmp_path):
    queue = make_queue(tmp_path)
    path = stage(queue)
    job = queue.submit("analysis-match-123", path, {"start": 1, "end": 2})
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    assert queue.matches(job.request_id, {"end": 2, "start": 1}, digest)
    assert not queue.matches(job.request_id, {"start": 1, "end": 3}, digest)
    assert not queue.matches(job.request_id, job.parameters, hashlib.sha256(b"other-video").hexdigest())
    assert not queue.matches("analysis-missing-123", job.parameters, digest)
    assert queue.get(job.request_id) == job
    assert list(queue.upload_dir.iterdir()) == [path]
