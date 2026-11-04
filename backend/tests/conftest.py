"""Shared test fixtures.

Tests never reach Supabase. Route tests replace the auth service functions,
so they check our own wiring -- status codes, request parsing, error
shapes -- and nothing else.
"""

import os
from urllib.parse import urlsplit

import httpx
import pytest

from app import create_app
from models.profile import Profile, Role


@pytest.fixture(autouse=True)
def block_external_http(monkeypatch):
    """Never use local credentials against shared services during backend tests.

    Loopback HTTP remains available for local integrations. Direct PostgreSQL
    connections used by the existing disposable-database tests are unaffected.
    """
    original_send = httpx.Client.send

    def send(client, request, *args, **kwargs):
        if request.url.host not in {"localhost", "127.0.0.1", "::1"}:
            pytest.fail("External HTTP is disabled in backend tests; replace the client with a test double.", pytrace=False)
        return original_send(client, request, *args, **kwargs)

    monkeypatch.setattr(httpx.Client, "send", send)


@pytest.fixture
def app():
    return create_app()


@pytest.fixture
def client(app):
    return app.test_client()


@pytest.fixture
def organiser_profile():
    return Profile(
        id="11111111-1111-1111-1111-111111111111",
        full_name="Ada Tan",
        role=Role.ORGANISER,
    )


@pytest.fixture
def venue_payload():
    """Provide fresh valid input for venue model and service tests."""
    return {
        "name": "Community Hall",
        "location": "Campus West",
        "capacity": 180,
        "facilities": {"parking": True, "projectors": 2},
        "accessibility": ["Step-free access"],
        "layouts": [{"name": "Theatre", "capacity": 120}],
        "operating_hours": {"open": "08:00", "close": "20:00"},
    }


@pytest.fixture(scope="session", autouse=True)
def require_loopback_database():
    """Integration fixtures are destructive and must never target Supabase."""
    url = os.environ.get("CANCELLATION_TEST_DATABASE_URL")
    if url and urlsplit(url).hostname not in {"localhost", "127.0.0.1", "::1"}:
        raise pytest.UsageError("Backend integration tests require a disposable loopback PostgreSQL URL.")
