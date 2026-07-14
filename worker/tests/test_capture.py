"""Tests for the production capture endpoints and pixel-space angle math."""

import base64
import tempfile

import pytest
from fastapi.testclient import TestClient

import app.main as main

client = TestClient(main.app)
CLIP = "../clips/regular_jump/fail/jump_fail.mp4"


def test_px_angles_are_aspect_true():
    line = main.FrameLine(start=main.FramePoint(x=0, y=0), end=main.FramePoint(x=1, y=1))
    # Corner-to-corner on 16:9 is atan2(720, 1280) ~= 29.36deg, not 45.
    assert main.px_line_angle(line, 1280, 720) == pytest.approx(29.36, abs=0.05)
    assert main.px_line_angle(line, 100, 100) == pytest.approx(45.0, abs=1e-6)
    # Straight joint stays straight in any aspect ratio.
    a = main.FramePoint(x=0.1, y=0.1)
    b = main.FramePoint(x=0.5, y=0.5)
    c = main.FramePoint(x=0.9, y=0.9)
    assert main.px_joint_angle(a, b, c, 1280, 720) == pytest.approx(180.0, abs=1e-3)


def test_capture_analyze_without_credentials_returns_manual_fallback(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    with open(CLIP, "rb") as video:
        response = client.post("/capture/analyze", files={"video": ("jump.mp4", video, "video/mp4")})
    assert response.status_code == 200
    body = response.json()
    assert body["aiAvailable"] is False
    assert body["window"] is None
    assert body["durationSeconds"] > 8
    assert main.UPLOAD_ID_PATTERN.match(body["uploadId"])


def test_capture_record_manual_window_produces_record():
    with open(CLIP, "rb") as video:
        response = client.post(
            "/capture/record",
            files={"video": ("jump.mp4", video, "video/mp4")},
            data={"start_seconds": "4.4", "end_seconds": "5.4"},
        )
    assert response.status_code == 200
    body = response.json()
    assert body["clip"].startswith("data:video/mp4;base64,")
    assert "metrics" not in body  # pose-only records: no key-frame metrics
    assert len(body["series"]) > 10
    assert len(body["filmstrip"]) > 5
    assert body["window"] == {"start": 4.4, "end": 5.4}

    # The clip must be a playable video roughly covering the window (stream copy
    # starts at the previous keyframe, so it may be a little longer).
    clip_bytes = base64.b64decode(body["clip"].split(",", 1)[1])
    with tempfile.NamedTemporaryFile(suffix=".mp4") as tmp:
        tmp.write(clip_bytes)
        tmp.flush()
        duration = main.video_duration_seconds(tmp.name)
    assert 0.8 <= duration <= 6.0


def test_capture_record_rejects_expired_upload_id():
    response = client.post(
        "/capture/record",
        data={"start_seconds": "0", "end_seconds": "1", "upload_id": "0" * 32},
    )
    assert response.status_code == 410


def test_capture_record_requires_a_source():
    response = client.post("/capture/record", data={"start_seconds": "0", "end_seconds": "1"})
    assert response.status_code == 422


def test_capture_record_rejects_oversized_analysis_window():
    with open(CLIP, "rb") as video:
        response = client.post(
            "/capture/record",
            files={"video": ("jump.mp4", video, "video/mp4")},
            data={"start_seconds": "0", "end_seconds": str(main.CAPTURE_MAX_WINDOW_SECONDS + 1)},
        )
    assert response.status_code == 422
    assert response.json()["detail"] == "Select an analysis window of 6 seconds or less."


def test_capture_record_rejects_overlapping_job():
    assert main.CAPTURE_JOB_LOCK.acquire(blocking=False)
    try:
        response = client.post(
            "/capture/record",
            data={"start_seconds": "0", "end_seconds": "1", "upload_id": "0" * 32},
        )
    finally:
        main.CAPTURE_JOB_LOCK.release()
    assert response.status_code == 429
    assert response.headers["retry-after"] == "30"
