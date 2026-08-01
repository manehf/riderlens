"""Public share package contract and legacy-page compatibility."""

import hashlib
import json

import pytest
from fastapi.testclient import TestClient

import app.main as main


client = TestClient(main.app)


class FakeShareBucket:
    def __init__(self, fail_suffix: str | None = None):
        self.objects: dict[str, bytes] = {}
        self.removed: list[str] = []
        self.fail_suffix = fail_suffix

    def upload(self, path: str, payload: bytes, _options: dict):
        if self.fail_suffix and path.endswith(self.fail_suffix):
            raise RuntimeError("storage unavailable")
        self.objects[path] = bytes(payload)

    def download(self, path: str) -> bytes:
        if path not in self.objects:
            raise KeyError(path)
        return self.objects[path]

    def remove(self, paths: list[str]):
        self.removed.extend(paths)
        for path in paths:
            self.objects.pop(path, None)


@pytest.fixture(autouse=True)
def reset_share_security(monkeypatch):
    monkeypatch.delenv("RIDERLENS_CLIENT_KEY", raising=False)
    monkeypatch.setenv("RIDERLENS_RATE_LIMIT_MAX", "1000")
    monkeypatch.setenv("SUPABASE_URL", "https://project.supabase.co")
    main.RATE_BUCKETS.clear()
    yield
    main.RATE_BUCKETS.clear()


@pytest.fixture
def share_bucket(monkeypatch) -> FakeShareBucket:
    bucket = FakeShareBucket()
    monkeypatch.setattr(main, "_share_storage", lambda: bucket)
    monkeypatch.setattr(main, "video_duration_seconds", lambda _path: 8.0)
    monkeypatch.setattr(
        main,
        "_extract_share_poster",
        lambda _video, poster, _duration: poster.write_bytes(b"generated-poster"),
    )
    monkeypatch.setattr(main, "_validate_share_poster", lambda _path: None)
    return bucket


def object_names(bucket: FakeShareBucket, share_id: str) -> set[str]:
    prefix = f"{share_id}/"
    return {path.removeprefix(prefix) for path in bucket.objects if path.startswith(prefix)}


def test_legacy_share_emits_v1_manifest_and_delete_control(share_bucket):
    response = client.post(
        "/share",
        files={"video": ("clip.mp4", b"legacy-video", "video/mp4")},
        data={
            "airtime_seconds": "1.23",
            "height_meters": "1.2",
            "rider_name": "  Alex  ",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["schemaVersion"] == 1
    assert main.SHARE_ID_PATTERN.fullmatch(body["id"])
    assert len(body["id"]) >= 22
    assert len(body["deleteToken"]) >= 22
    assert object_names(share_bucket, body["id"]) == {
        "clip.mp4",
        "poster.jpg",
        "meta.json",
        "control.json",
    }

    manifest = json.loads(share_bucket.objects[f'{body["id"]}/meta.json'])
    assert manifest["schemaVersion"] == 1
    assert manifest["shareId"] == body["id"]
    assert manifest["skillType"] == "regular_jump"
    assert manifest["durationSeconds"] == 8.0
    assert manifest["sharedByName"] == "Alex"
    assert manifest["airtimeSeconds"] == 1.23
    assert manifest["heightMeters"] == 1.2
    assert manifest["events"] == []
    assert manifest["assets"] == {
        "clean": "clip.mp4",
        "poster": "poster.jpg",
        "playback": "clip.mp4",
    }

    control_bytes = share_bucket.objects[f'{body["id"]}/control.json']
    control = json.loads(control_bytes)
    assert control["deleteTokenHash"] == hashlib.sha256(body["deleteToken"].encode()).hexdigest()
    assert body["deleteToken"].encode() not in control_bytes

    page = client.get(f'/{body["id"]}')
    assert page.status_code == 200
    assert "Alex shared <em>this send</em>" in page.text
    assert f'{body["id"]}/clip.mp4' in page.text
    assert f'/s/{body["id"]}/download' in page.text
    assert "airtime <b>1.23s</b>" in page.text
    assert "height <b>1.2m</b>" in page.text

    download = client.get(f'/s/{body["id"]}/download', follow_redirects=False)
    assert download.status_code == 307
    assert download.headers["location"].endswith(
        f'/shares/{body["id"]}/clip.mp4?download=riderlens-send.mp4'
    )


def test_enriched_share_stores_both_clips_detail_and_flight(share_bucket):
    detail = {"series": [{"t": 0.0}], "filmstrip": [{"t": 0.0, "image": "data:image/jpeg;base64,AA=="}]}
    flight = {
        "airtimeSeconds": 0.82,
        "heightMeters": 0.82,
        "method": "symmetric",
        "endedIn": "landing",
        "takeoffTime": 1.1,
        "landingTime": 1.92,
    }
    events = [
        {"name": "takeoff", "time_seconds": 1.1, "why": "Both tires leave the lip."},
        {"name": "landing", "time_seconds": 1.92, "why": "Both tires return to the trail."},
    ]
    response = client.post(
        "/share",
        files={
            "clean_video": ("clean.mp4", b"clean-video", "video/mp4"),
            "skeleton_video": ("skeleton.mp4", b"skeleton-video", "video/mp4"),
            "poster": ("poster.jpg", b"poster-image", "image/jpeg"),
            "detail": ("detail.json", json.dumps(detail).encode(), "application/json"),
        },
        data={
            "skill_type": "regular_jump",
            "flight_json": json.dumps(flight),
            "events_json": json.dumps(events),
            "shared_by_name": "Taylor",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert object_names(share_bucket, body["id"]) == {
        "clean.mp4",
        "skeleton.mp4",
        "poster.jpg",
        "detail.json",
        "meta.json",
        "control.json",
    }
    manifest = json.loads(share_bucket.objects[f'{body["id"]}/meta.json'])
    assert manifest["sharedByName"] == "Taylor"
    assert manifest["flight"] == flight
    assert manifest["events"] == events
    assert manifest["assets"] == {
        "clean": "clean.mp4",
        "skeleton": "skeleton.mp4",
        "poster": "poster.jpg",
        "detail": "detail.json",
        "playback": "skeleton.mp4",
    }
    assert "airtimeSeconds" not in manifest
    assert json.loads(share_bucket.objects[f'{body["id"]}/detail.json']) == detail

    page = client.get(f'/s/{body["id"]}')
    assert page.status_code == 200
    assert "Taylor shared <em>this send</em>" in page.text
    assert f'{body["id"]}/skeleton.mp4' in page.text
    assert "airtime <b>0.82s</b>" in page.text
    download = client.get(f'/s/{body["id"]}/download', follow_redirects=False)
    assert download.headers["location"].endswith(
        f'/shares/{body["id"]}/skeleton.mp4?download=riderlens-send.mp4'
    )


def test_enriched_share_without_skeleton_plays_clean_clip(share_bucket):
    response = client.post(
        "/share",
        files={
            "clean_video": ("clean.mp4", b"clean-video", "video/mp4"),
            "detail": ("detail.json", b'{"series":[],"filmstrip":[]}', "application/json"),
        },
    )

    assert response.status_code == 200
    body = response.json()
    manifest = json.loads(share_bucket.objects[f'{body["id"]}/meta.json'])
    assert manifest["assets"]["playback"] == "clean.mp4"
    assert "skeleton" not in manifest["assets"]
    assert f'{body["id"]}/clean.mp4' in client.get(f'/{body["id"]}').text


@pytest.mark.parametrize(
    ("files", "data", "detail"),
    [
        (
            {"clean_video": ("clean.mp4", b"video", "video/mp4")},
            {},
            "Enriched shares require a detail file.",
        ),
        (
            {
                "clean_video": ("clean.mp4", b"video", "video/mp4"),
                "detail": ("detail.json", b"{}", "application/json"),
            },
            {},
            "detail must be JSON with series and filmstrip arrays.",
        ),
        (
            {
                "clean_video": ("clean.mp4", b"video", "video/mp4"),
                "detail": ("detail.json", b'{"series":[],"filmstrip":[]}', "application/json"),
            },
            {"flight_json": "{}"},
            "flight_json is not a valid flight estimate.",
        ),
        (
            {
                "clean_video": ("clean.mp4", b"video", "video/mp4"),
                "detail": ("detail.json", b'{"series":[],"filmstrip":[]}', "application/json"),
            },
            {"events_json": "{}"},
            "events_json must be a valid event list.",
        ),
    ],
)
def test_enriched_share_rejects_incomplete_or_invalid_metadata(share_bucket, files, data, detail):
    response = client.post("/share", files=files, data=data)
    assert response.status_code == 422
    assert response.json()["detail"] == detail
    assert share_bucket.objects == {}


def test_share_rejects_video_over_duration_limit(share_bucket, monkeypatch):
    monkeypatch.setattr(main, "video_duration_seconds", lambda _path: 15.01)
    response = client.post(
        "/share",
        files={"video": ("clip.mp4", b"video", "video/mp4")},
    )
    assert response.status_code == 422
    assert response.json()["detail"] == "Video must be 15 seconds or shorter."
    assert share_bucket.objects == {}


def test_share_rolls_back_objects_when_storage_upload_fails(monkeypatch):
    bucket = FakeShareBucket(fail_suffix="meta.json")
    monkeypatch.setattr(main, "_share_storage", lambda: bucket)
    monkeypatch.setattr(main, "video_duration_seconds", lambda _path: 8.0)
    monkeypatch.setattr(
        main,
        "_extract_share_poster",
        lambda _video, poster, _duration: poster.write_bytes(b"generated-poster"),
    )
    monkeypatch.setattr(main, "_validate_share_poster", lambda _path: None)

    response = client.post(
        "/share",
        files={"video": ("clip.mp4", b"video", "video/mp4")},
    )

    assert response.status_code == 502
    assert bucket.objects == {}
    assert any(path.endswith("clip.mp4") for path in bucket.removed)
    assert any(path.endswith("poster.jpg") for path in bucket.removed)


def test_pre_manifest_share_page_still_renders(share_bucket):
    share_id = "legacy12"
    share_bucket.objects[f"{share_id}/meta.json"] = json.dumps(
        {
            "durationSeconds": 8.0,
            "airtimeSeconds": 0.7,
            "heightMeters": 0.6,
            "riderName": "Old client",
        }
    ).encode()

    response = client.get(f"/{share_id}")

    assert response.status_code == 200
    assert "Old client shared <em>this send</em>" in response.text
    assert f"{share_id}/clip.mp4" in response.text
    assert f"{share_id}/poster.jpg" in response.text
