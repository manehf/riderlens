"""Tests for the dev analysis-lab endpoints (no MediaPipe processing involved)."""

from fastapi.testclient import TestClient

import app.main as main

client = TestClient(main.app)


def test_dev_dashboard_serves_html():
    response = client.get("/dev")
    assert response.status_code == 200
    assert "RiderLens Analysis Lab" in response.text


def test_dev_clips_lists_manifest_entries():
    response = client.get("/dev/clips")
    assert response.status_code == 200
    clips = response.json()["clips"]
    assert any(entry["file"] == "regular_jump/fail/jump_fail.mp4" and entry["available"] for entry in clips)


def test_dev_analyze_clip_rejects_path_traversal():
    response = client.post("/dev/analyze-clip", json={"file": "../.env"})
    assert response.status_code == 400


def test_dev_analyze_clip_unknown_file_is_404():
    response = client.post("/dev/analyze-clip", json={"file": "regular_jump/good/does-not-exist.mp4"})
    assert response.status_code == 404


def test_dev_ui_flag_disables_endpoints(monkeypatch):
    monkeypatch.setattr(main, "DEV_UI_ENABLED", False)
    assert client.get("/dev").status_code == 404
    assert client.get("/dev/clips").status_code == 404
    assert client.post("/dev/analyze-clip", json={"file": "x.mp4"}).status_code == 404


def test_ai_review_requires_frame_images():
    metric = {
        "phase": "takeoff",
        "frameTime": 2.5,
        "torsoAngle": 49,
        "hipAngle": 106,
        "kneeAngle": 130,
        "elbowAngle": 168,
        "bikePitchAngle": -5,
        "floorAngle": -6,
        "tireBaselineAngle": -5,
        "landingAlignmentAngle": 12,
        "geometrySource": "estimated",
        "geometry": {
            key: {"start": {"x": 0.1, "y": 0.9}, "end": {"x": 0.9, "y": 0.9}}
            for key in ["floor", "tireBaseline", "torso", "kneeUpper", "kneeLower", "landing"]
        },
        "confidence": 0.9,
    }
    response = client.post("/dev/ai-review", json={"metrics": [metric]})
    assert response.status_code == 422
    assert "frame images" in response.json()["detail"]


def test_find_key_frames_rejects_path_traversal():
    response = client.post("/dev/find-key-frames", json={"file": "../.env"})
    assert response.status_code == 400


def test_contact_sheet_samples_frames_in_order():
    sheet = main.build_contact_sheet("../clips/regular_jump/fail/jump_fail.mp4", 0, None, count=8, width=320)
    assert len(sheet) == 8
    times = [time_seconds for time_seconds, _ in sheet]
    assert times == sorted(times)
    assert all(image.startswith("data:image/jpeg;base64,") for _, image in sheet)


def test_save_labels_writes_labels_file(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "LABELS_PATH", tmp_path / "labels.json")
    payload = {
        "file": "regular_jump/fail/jump_fail.mp4",
        "frame_time": 4.33,
        "phase": "takeoff",
        "geometry": {"floor": {"start": {"x": 0, "y": 0.9}, "end": {"x": 1, "y": 0.9}}},
    }
    first = client.post("/dev/save-labels", json=payload)
    assert first.status_code == 200 and first.json()["count"] == 1
    # Saving the same frame again replaces the entry instead of duplicating it.
    second = client.post("/dev/save-labels", json=payload)
    assert second.json()["count"] == 1
    import json as json_module

    saved = json_module.loads((tmp_path / "labels.json").read_text())
    assert saved["labels"][0]["frameTime"] == 4.33


def test_save_ground_truth_updates_manifest(tmp_path, monkeypatch):
    import json as json_module

    manifest_path = tmp_path / "manifest.json"
    manifest_path.write_text(json_module.dumps({"clips": [{"file": "a.mp4", "label": "crash"}]}))
    monkeypatch.setattr(main, "MANIFEST_PATH", manifest_path)

    response = client.post(
        "/dev/save-ground-truth",
        json={"file": "a.mp4", "event_type": "crash", "events": [{"name": "crash", "time_seconds": 6.1, "why": "x"}]},
    )
    assert response.status_code == 200
    saved = json_module.loads(manifest_path.read_text())
    assert saved["clips"][0]["groundTruth"]["eventType"] == "crash"

    missing = client.post("/dev/save-ground-truth", json={"file": "nope.mp4", "event_type": "crash", "events": []})
    assert missing.status_code == 404


def test_measure_window_produces_series():
    series, air_frames, filmstrip, overlay = main.measure_window(
        "../clips/regular_jump/fail/jump_fail.mp4", 4.0, 5.5, (4.4, 5.1)
    )
    assert len(series) > 20
    times = [row["t"] for row in series]
    assert times == sorted(times)
    assert any(row["kneeAngle"] is not None for row in series)
    assert all(
        set(row) == {"t", "kneeAngle", "torsoAngle", "hipHeight", "pitch", "confidence"} for row in series
    )
    assert 1 <= len(air_frames) <= 8
    assert len(filmstrip) >= 20  # whole-window coverage for the user-facing strip
    assert all(frame["image"].startswith("data:image/jpeg;base64,") for frame in filmstrip)
    assert overlay is None  # not requested


def test_filmstrip_quality_uses_more_of_landscape_pixel_budget():
    landscape_width, landscape_quality = main.filmstrip_encode_settings(250, 1024, 576)
    portrait_width, portrait_quality = main.filmstrip_encode_settings(250, 1080, 1920)

    assert (landscape_width, landscape_quality) == (768, 78)
    assert (portrait_width, portrait_quality) == (640, 78)


def test_filmstrip_quality_respects_explicit_width_and_source_size():
    assert main.filmstrip_encode_settings(450, 1024, 576, 480) == (480, 74)
    assert main.filmstrip_encode_settings(80, 640, 360) == (640, 88)


def test_measure_window_renders_shareable_overlay_clip():
    _series, _air, _filmstrip, overlay = main.measure_window(
        "../clips/regular_jump/fail/jump_fail.mp4", 4.0, 5.0, (4.4, 5.0), include_bike=False, render_overlay=True
    )
    assert overlay is not None
    assert len(overlay) > 10_000  # a real encoded mp4, not an empty stub
    assert overlay[4:8] == b"ftyp"  # mp4 container signature


def test_measure_window_can_skip_unused_air_frames():
    series, air_frames, filmstrip, overlay = main.measure_window(
        "../clips/regular_jump/fail/jump_fail.mp4",
        4.0,
        4.5,
        (4.0, 4.5),
        include_bike=False,
        include_air_frames=False,
    )
    assert series
    assert filmstrip
    assert air_frames == []
    assert overlay is None
