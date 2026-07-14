from app import main


def test_get_supabase_prefers_new_secret_key(monkeypatch):
    calls = []
    client = object()

    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SECRET_KEY", "sb_secret_new")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "legacy-service-role")
    monkeypatch.setattr(main, "create_client", lambda url, key: calls.append((url, key)) or client)

    assert main.get_supabase() is client
    assert calls == [("https://example.supabase.co", "sb_secret_new")]


def test_get_supabase_supports_legacy_service_role_key(monkeypatch):
    calls = []
    client = object()

    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.delenv("SUPABASE_SECRET_KEY", raising=False)
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "legacy-service-role")
    monkeypatch.setattr(main, "create_client", lambda url, key: calls.append((url, key)) or client)

    assert main.get_supabase() is client
    assert calls == [("https://example.supabase.co", "legacy-service-role")]


def test_get_supabase_is_optional(monkeypatch):
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SECRET_KEY", raising=False)
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)

    assert main.get_supabase() is None
