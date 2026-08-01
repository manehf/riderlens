from fastapi.testclient import TestClient

from app import main


client = TestClient(main.app)


def test_app_version_returns_store_defaults(monkeypatch):
    for name in (
        "RIDERLENS_IOS_LATEST_VERSION",
        "RIDERLENS_IOS_MINIMUM_VERSION",
        "RIDERLENS_IOS_STORE_URL",
        "RIDERLENS_UPDATE_MESSAGE",
    ):
        monkeypatch.delenv(name, raising=False)

    response = client.get("/app/version", params={"platform": "ios"})

    assert response.status_code == 200
    assert response.json() == {
        "platform": "ios",
        "latestVersion": "1.0.1",
        "minimumSupportedVersion": "1.0.0",
        "storeUrl": "https://apps.apple.com/us/app/riderlens-mtb-skills-analysis/id6790874129",
        "message": "A new RiderLens version is available with fixes and improvements.",
    }


def test_app_version_uses_platform_overrides(monkeypatch):
    monkeypatch.setenv("RIDERLENS_ANDROID_LATEST_VERSION", "1.3.0")
    monkeypatch.setenv("RIDERLENS_ANDROID_MINIMUM_VERSION", "1.1.0")
    monkeypatch.setenv("RIDERLENS_ANDROID_STORE_URL", "https://play.google.com/custom")
    monkeypatch.setenv("RIDERLENS_UPDATE_MESSAGE", "Update for smoother playback.")

    response = client.get("/app/version", params={"platform": "android"})

    assert response.status_code == 200
    assert response.json() == {
        "platform": "android",
        "latestVersion": "1.3.0",
        "minimumSupportedVersion": "1.1.0",
        "storeUrl": "https://play.google.com/custom",
        "message": "Update for smoother playback.",
    }


def test_app_version_rejects_unknown_platform():
    assert client.get("/app/version", params={"platform": "web"}).status_code == 422


def test_app_version_remains_public_when_worker_auth_is_enabled(monkeypatch):
    monkeypatch.setenv("RIDERLENS_CLIENT_KEY", "private-analysis-key")

    response = client.get("/app/version", params={"platform": "android"})

    assert response.status_code == 200
