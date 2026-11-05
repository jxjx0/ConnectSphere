"""Setup for integration tests: real services against a real local Supabase.

These tests only run when SUPABASE_TEST_URL is set, and they refuse to run
against anything except this computer, so they can never touch shared data.
"""

import os
from types import SimpleNamespace
from urllib.parse import urlsplit
from uuid import uuid4

import pytest

import config
from services import notification_service

LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}


@pytest.fixture(autouse=True)
def local_supabase(monkeypatch):
    """Point the app at local Supabase, replacing any settings from backend/.env."""
    url = os.environ.get("SUPABASE_TEST_URL")
    if not url:
        pytest.skip("SUPABASE_TEST_URL is not configured")
    if urlsplit(url).hostname not in LOCAL_HOSTS:
        raise pytest.UsageError("Integration tests must use a local Supabase.")

    anon_key = os.environ.get("SUPABASE_TEST_ANON_KEY")
    service_role_key = os.environ.get("SUPABASE_TEST_SERVICE_ROLE_KEY")
    if not anon_key or not service_role_key:
        raise pytest.UsageError(
            "Set SUPABASE_TEST_ANON_KEY and SUPABASE_TEST_SERVICE_ROLE_KEY."
        )

    monkeypatch.setattr(config, "SUPABASE_URL", url)
    monkeypatch.setattr(config, "SUPABASE_ANON_KEY", anon_key)
    monkeypatch.setattr(config, "SUPABASE_SERVICE_ROLE_KEY", service_role_key)


@pytest.fixture(autouse=True)
def no_real_email(monkeypatch):
    """SendGrid stays fake. In-app notifications still save to the local database."""
    monkeypatch.setattr(notification_service, "send_email", lambda *args, **kwargs: None)


@pytest.fixture
def admin(local_supabase):
    """Sets up data and reads results, separately from the code being tested."""
    return config.get_admin_client()


@pytest.fixture
def make_user(admin):
    """Create a real user with a role, and log them in for a real access token."""

    def create(role):
        email = f"{role}-{uuid4().hex}@example.com"
        password = uuid4().hex
        user = admin.auth.admin.create_user(
            {"email": email, "password": password, "email_confirm": True}
        ).user
        admin.table("profiles").insert(
            {"id": user.id, "full_name": f"Test {role}", "role": role}
        ).execute()
        session = config.get_client().auth.sign_in_with_password(
            {"email": email, "password": password}
        ).session
        return SimpleNamespace(id=user.id, email=email, token=session.access_token)

    return create
