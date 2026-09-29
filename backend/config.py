"""Environment configuration and Supabase client creation."""

import os

from dotenv import load_dotenv
from supabase import Client, create_client

load_dotenv()

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY", "")
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
    # Keep the token on the shared options too: PostgREST's auth helper only
    # updates its own client, while Storage is created lazily from these
    # shared headers.
    client.options.headers["Authorization"] = f"Bearer {access_token}"
    client.postgrest.auth(access_token)
    return client
