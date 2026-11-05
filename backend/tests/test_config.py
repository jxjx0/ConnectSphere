"""Client factories validate settings and preserve user-token isolation."""

from pathlib import Path
import runpy
from unittest.mock import Mock

import httpx
import pytest
from flask import Flask

import config


@pytest.fixture
def factory(monkeypatch):
    factory = Mock()
    monkeypatch.setattr(config, "create_client", factory)
    monkeypatch.setattr(config, "SUPABASE_URL", "https://example.invalid")
    monkeypatch.setattr(config, "SUPABASE_ANON_KEY", "test-anon")
    monkeypatch.setattr(config, "SUPABASE_SERVICE_ROLE_KEY", "test-service")
    return factory


@pytest.mark.parametrize("missing", ["SUPABASE_URL", "SUPABASE_ANON_KEY"])
@pytest.mark.parametrize("kind", ["anonymous", "user"])
def test_missing_public_settings_prevent_client_creation(factory, monkeypatch, missing, kind):
    monkeypatch.setattr(config, missing, "")
    with pytest.raises(RuntimeError, match=missing):
        config.get_client() if kind == "anonymous" else config.get_user_client("token")
    factory.assert_not_called()


def test_anonymous_client_uses_public_key(factory):
    assert config.get_client() is factory.return_value
    factory.assert_called_once_with("https://example.invalid", "test-anon")
    factory.return_value.postgrest.auth.assert_not_called()


def test_user_client_attaches_supplied_token_to_public_key_client(factory):
    assert config.get_user_client("signed-in-token") is factory.return_value
    factory.assert_called_once_with("https://example.invalid", "test-anon")
    factory.return_value.postgrest.auth.assert_called_once_with("signed-in-token")


@pytest.mark.parametrize("missing", ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"])
def test_admin_factory_requires_both_private_settings(factory, monkeypatch, missing):
    monkeypatch.setattr(config, missing, "")
    with pytest.raises(RuntimeError, match="Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY"):
        config.get_admin_client()
    factory.assert_not_called()


def test_admin_factory_uses_service_key(factory):
    assert config.get_admin_client() is factory.return_value
    factory.assert_called_once_with("https://example.invalid", "test-service")


def test_development_entrypoint_starts_app_on_expected_port_without_opening_a_server(monkeypatch):
    run = Mock()
    monkeypatch.setattr(Flask, "run", run)
    runpy.run_path(str(Path(__file__).resolve().parents[1] / "app.py"), run_name="__main__")
    run.assert_called_once_with(debug=True, port=5000)


def test_suite_blocks_external_http_before_transport_or_credentials_can_be_used():
    handler = Mock()
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(pytest.fail.Exception, match="External HTTP is disabled in backend tests"):
            client.get("https://example.invalid", headers={"Authorization": "Bearer test-token"})
    handler.assert_not_called()


def test_suite_guard_allows_loopback_http_for_local_integrations():
    handler = Mock(return_value=httpx.Response(200, json={"status": "ok"}))
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        response = client.get("http://127.0.0.1/health")
    assert response.json() == {"status": "ok"}
    assert handler.call_count == 1
