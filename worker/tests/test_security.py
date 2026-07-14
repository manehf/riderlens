"""Abuse containment: client key, rate limit, upload size cap."""

from fastapi.testclient import TestClient

import app.main as main

client = TestClient(main.app)
CLIP = "../clips/regular_jump/fail/jump_fail.mp4"


def test_client_key_not_enforced_until_configured(monkeypatch):
    monkeypatch.delenv("RIDERLENS_CLIENT_KEY", raising=False)
    # Missing video -> validation error, proving the request got past auth.
    response = client.post("/capture/analyze")
    assert response.status_code == 422


def test_client_key_rejects_missing_and_wrong_key(monkeypatch):
    monkeypatch.setenv("RIDERLENS_CLIENT_KEY", "trail-secret")
    assert client.post("/capture/analyze").status_code == 401
    assert client.post("/capture/analyze", headers={"x-riderlens-key": "wrong"}).status_code == 401
    assert client.post("/capture/record", data={"start_seconds": 0, "end_seconds": 1}).status_code == 401


def test_client_key_accepts_the_shipped_key(monkeypatch):
    monkeypatch.setenv("RIDERLENS_CLIENT_KEY", "trail-secret")
    response = client.post("/capture/analyze", headers={"x-riderlens-key": "trail-secret"})
    assert response.status_code == 422  # past auth, missing the video file


def test_health_stays_open(monkeypatch):
    monkeypatch.setenv("RIDERLENS_CLIENT_KEY", "trail-secret")
    assert client.get("/health").status_code == 200


def test_rate_limit_returns_429_with_retry_after(monkeypatch):
    monkeypatch.delenv("RIDERLENS_CLIENT_KEY", raising=False)
    monkeypatch.setenv("RIDERLENS_RATE_LIMIT_MAX", "2")
    main.RATE_BUCKETS.clear()
    try:
        assert client.post("/capture/analyze").status_code == 422
        assert client.post("/capture/analyze").status_code == 422
        response = client.post("/capture/analyze")
        assert response.status_code == 429
        assert int(response.headers["Retry-After"]) >= 1
    finally:
        main.RATE_BUCKETS.clear()


def test_oversized_upload_is_rejected_and_not_kept(monkeypatch, tmp_path):
    monkeypatch.delenv("RIDERLENS_CLIENT_KEY", raising=False)
    monkeypatch.setenv("RIDERLENS_MAX_UPLOAD_BYTES", "1024")
    monkeypatch.setattr(main, "CAPTURE_DIR", tmp_path)
    with open(CLIP, "rb") as video:
        response = client.post("/capture/analyze", files={"video": ("jump.mp4", video, "video/mp4")})
    assert response.status_code == 413
    assert "too large" in response.json()["detail"].lower()
    assert list(tmp_path.iterdir()) == []  # partial file removed
