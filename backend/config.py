"""Environment configuration and Supabase client creation."""

import os

from dotenv import load_dotenv
from supabase import Client, create_client

load_dotenv()

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY", "")
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
SENDGRID_API_KEY = os.environ.get("SENDGRID_API_KEY", "")
SENDGRID_FROM_EMAIL = os.environ.get("SENDGRID_FROM_EMAIL", "")
FRONTEND_ORIGIN = os.environ.get("FRONTEND_ORIGIN", "http://localhost:5173")


def _require_settings() -> None:
    """Fail loudly if the .env file has not been filled in."""
    missing = [
        name
        for name, value in (
            ("SUPABASE_URL", SUPABASE_URL),
            ("SUPABASE_ANON_KEY", SUPABASE_ANON_KEY),
        )
        if not value
    ]
    if missing:
        raise RuntimeError(
            f"Missing environment variable(s): {', '.join(missing)}. "
            "Copy backend/.env.example to backend/.env and fill it in."
        )


def get_client() -> Client:
    """An anonymous Supabase client, used for signup and login."""
    _require_settings()
    return create_client(SUPABASE_URL, SUPABASE_ANON_KEY)


def get_user_client(access_token: str) -> Client:
    """A Supabase client acting as the logged-in user who owns `access_token`.

    Database calls made with this client run under that user's row-level
    security policies, so a user can only read and write their own rows.
    """
    _require_settings()
    client = create_client(SUPABASE_URL, SUPABASE_ANON_KEY)
    client.postgrest.auth(access_token)
    return client


def get_admin_client() -> Client:
    """A Supabase client using the service-role key.

    This client skips row-level security and can use the Auth admin API, so
    it must only be used where the system acts on its own behalf -- today
    that is just services/notification_service.py. Never use it for a
    request a user makes about their own data.
    """
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        raise RuntimeError(
            "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. "
            "Copy backend/.env.example to backend/.env and fill it in."
        )
    return create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
