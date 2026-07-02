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
