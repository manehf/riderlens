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


@pytest.mark.parametrize("fps", [24, 30, 60])
def test_skeleton_clip_contains_only_analyzed_frames(monkeypatch, tmp_path, fps):
    class NoPose:
        def process(self, frame):
            return None

        def close(self):
            pass

    monkeypatch.setattr(main, "create_pose_engine", lambda **kwargs: NoPose())
    source_path = tmp_path / "source.avi"
    writer = main.cv2.VideoWriter(
        str(source_path), main.cv2.VideoWriter_fourcc(*"MJPG"), fps, (320, 180)
    )
    assert writer.isOpened()
    try:
        for index in range(fps * 2):
            writer.write(main.np.full((180, 320, 3), 40 + index, dtype=main.np.uint8))
    finally:
        writer.release()

    series, _, filmstrip, overlay_clip = main.measure_window(
        str(source_path), 0.25, 1.25, (0.25, 1.25),
        include_bike=False, render_overlay=True, include_air_frames=False,
    )
    assert len(series) > 10
    assert len(filmstrip) == len(series)
    assert overlay_clip is not None
    overlay_path = tmp_path / "skeleton.mp4"
    overlay_path.write_bytes(overlay_clip)
    capture = main.cv2.VideoCapture(str(overlay_path))
    assert capture.isOpened()
    try:
        assert capture.get(main.cv2.CAP_PROP_FPS) == pytest.approx(fps)
        decoded_frames = 0
        while capture.read()[0]:
            decoded_frames += 1
        # The playback asset must end with the analysis, never a promotional card.
        assert decoded_frames == len(series)
    finally:
        capture.release()


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
    assert response.json()["detail"] == "Select an analysis window of 8 seconds or less."


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


def test_busy_retries_do_not_spend_the_ip_allowance(monkeypatch):
    monkeypatch.delenv("RIDERLENS_CLIENT_KEY", raising=False)
    monkeypatch.setenv("RIDERLENS_RATE_LIMIT_MAX", "2")
    main.RATE_BUCKETS.clear()
    assert main.CAPTURE_JOB_LOCK.acquire(blocking=False)
    try:
        for _ in range(4):
            response = client.post(
                "/capture/record",
                data={"start_seconds": "0", "end_seconds": "1", "upload_id": "0" * 32},
            )
            assert response.status_code == 429
            assert response.headers["retry-after"] == "30"
    finally:
        main.CAPTURE_JOB_LOCK.release()
    try:
        # Validation still spends allowance, but the earlier busy responses do not.
        for _ in range(2):
            response = client.post(
                "/capture/record",
                data={"start_seconds": "0", "end_seconds": "1", "upload_id": "0" * 32},
            )
            assert response.status_code == 410
            assert not main.CAPTURE_JOB_LOCK.locked()
        assert client.post("/capture/record").status_code == 429
        assert not main.CAPTURE_JOB_LOCK.locked()
    finally:
        main.RATE_BUCKETS.clear()


@pytest.mark.parametrize("fps", [24, 29.97, 60, 90, 120, 144])
def test_sampling_keeps_video_time_at_non_integer_strides(monkeypatch, tmp_path, fps):
    sampled_indices = []

    class FrameReader:
        def process(self, frame):
            sampled_indices.append(round(float(frame[10:30, 10:30].mean())) - 10)
            return None

        def close(self):
            pass

    monkeypatch.setattr(main, "create_pose_engine", lambda **kwargs: FrameReader())
    source_path = tmp_path / "source.avi"
    writer = main.cv2.VideoWriter(
        str(source_path), main.cv2.VideoWriter_fourcc(*"MJPG"), fps, (160, 90)
    )
    assert writer.isOpened()
    for index in range(int(fps * 1.5)):
        writer.write(main.np.full((90, 160, 3), 10 + index, dtype=main.np.uint8))
    writer.release()
    series, _, filmstrip, overlay = main.measure_window(
        str(source_path), 0.2, 1.2, (0.2, 1.2),
        include_bike=False, render_overlay=True, include_air_frames=False,
    )
    assert len(series) == len(filmstrip) == len(sampled_indices)
    assert len(series) <= 60
    for row, index in zip(series, sampled_indices):
        assert index / fps == pytest.approx(row["t"], abs=1 / fps + 0.002)
    assert series[-1]["t"] < 1.2
    output = tmp_path / "skeleton.mp4"
    output.write_bytes(overlay)
    assert main.video_duration_seconds(str(output)) == pytest.approx(1, abs=1 / min(fps, 60) + 0.002)
