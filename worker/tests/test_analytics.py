import json
import pytest

from fastapi.testclient import TestClient

import app.main as main


client = TestClient(main.app)


def analytics_payload(**overrides):
    payload = {
        "clientId": "analysis.record-12345678",
        "eventId": "event-12345678",
        "name": "analysis_completed",
        "timestampMicros": 1_788_688_800_000_000,
        "sessionId": 1_788_688_800,
        "platform": "ios",
        "appVersion": "1.0.3",
        "parameters": {
            "skill_type": "regular_jump",
            "clip_duration_seconds": 4.2,
            "has_skeleton_video": True,
        },
    }
    payload.update(overrides)
    return payload


def test_analytics_event_requires_client_key(monkeypatch):
    monkeypatch.setenv("RIDERLENS_CLIENT_KEY", "trail-secret")
    response = client.post("/analytics/event", json=analytics_payload())
    assert response.status_code == 401


def test_analytics_event_stays_queued_when_ga4_is_not_configured(monkeypatch):
    monkeypatch.delenv("RIDERLENS_CLIENT_KEY", raising=False)
    monkeypatch.delenv("GA4_MEASUREMENT_ID", raising=False)
    monkeypatch.delenv("GA4_API_SECRET", raising=False)
    response = client.post("/analytics/event", json=analytics_payload())
    assert response.status_code == 503


def test_analytics_event_forwards_minimal_payload_to_ga4(monkeypatch):
    monkeypatch.setenv("RIDERLENS_CLIENT_KEY", "trail-secret")
    monkeypatch.setenv("GA4_MEASUREMENT_ID", "G-TEST123")
    monkeypatch.setenv("GA4_API_SECRET", "server-only-secret")
    captured = {}

    class Response:
        status = 204

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

    def fake_urlopen(request, timeout):
        captured["url"] = request.full_url
        captured["body"] = json.loads(request.data)
        captured["timeout"] = timeout
        return Response()

    monkeypatch.setattr(main.urllib.request, "urlopen", fake_urlopen)
    response = client.post(
        "/analytics/event",
        headers={"x-riderlens-key": "trail-secret"},
        json=analytics_payload(),
    )

    assert response.status_code == 200
    assert response.json() == {"accepted": True}
    assert "measurement_id=G-TEST123" in captured["url"]
    assert "api_secret=server-only-secret" in captured["url"]
    assert captured["timeout"] == 8
    assert captured["body"]["client_id"] == "analysis.record-12345678"
    event = captured["body"]["events"][0]
    assert event["name"] == "analysis_completed"
    assert event["params"]["app_platform"] == "ios"
    assert event["params"]["event_source"] == "mobile_app_via_worker"
    serialized = json.dumps(captured["body"]).lower()
    assert "data:video" not in serialized
    assert "data:image" not in serialized


def test_analytics_event_rejects_unknown_event_and_parameter(monkeypatch):
    monkeypatch.delenv("RIDERLENS_CLIENT_KEY", raising=False)
    monkeypatch.setenv("GA4_MEASUREMENT_ID", "G-TEST123")
    monkeypatch.setenv("GA4_API_SECRET", "server-only-secret")

    unknown_event = client.post("/analytics/event", json=analytics_payload(name="user_email"))
    assert unknown_event.status_code == 422

    payload = analytics_payload(parameters={"email": "rider@example.com"})
    unknown_parameter = client.post("/analytics/event", json=payload)
    assert unknown_parameter.status_code == 422


@pytest.mark.parametrize("name", [
    "allowance_exhausted", "allowance_blocked", "paywall_requested",
    "paywall_result", "billing_error", "restore_result",
])
def test_billing_events_forward_context_without_customer_identifiers(monkeypatch, name):
    monkeypatch.delenv("RIDERLENS_CLIENT_KEY", raising=False)
    monkeypatch.setenv("GA4_MEASUREMENT_ID", "G-TEST123")
    monkeypatch.setenv("GA4_API_SECRET", "server-only-secret")
    captured = {}

    class Response:
        status = 204

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

    def fake_urlopen(request, timeout):
        captured.update(json.loads(request.data))
        return Response()

    monkeypatch.setattr(main.urllib.request, "urlopen", fake_urlopen)
    response = client.post("/analytics/event", json=analytics_payload(
        name=name, clientId="billing.session-12345678", parameters={
            "paywall_source": "monthly_limit", "paywall_flow_id": "paywall-12345678",
            "paywall_result": "cancelled", "presentation_confirmed": True,
            "has_pro": False, "allowance_month": "2026-09", "free_used": 3,
            "free_limit": 3, "free_remaining": 0,
        },
    ))
    assert response.status_code == 200
    assert captured["events"][0]["name"] == name
    assert captured["events"][0]["params"]["paywall_source"] == "monthly_limit"
    assert captured["events"][0]["params"]["has_pro"] is False


def test_billing_rejects_customer_id_and_receipts(monkeypatch):
    monkeypatch.delenv("RIDERLENS_CLIENT_KEY", raising=False)
    monkeypatch.setenv("GA4_MEASUREMENT_ID", "G-TEST123")
    monkeypatch.setenv("GA4_API_SECRET", "server-only-secret")
    for parameter in ["revenuecat_user_id", "receipt", "error_message"]:
        response = client.post("/analytics/event", json=analytics_payload(
            name="billing_error", parameters={parameter: "sensitive"},
        ))
        assert response.status_code == 422
