"""Shared test fixtures.

Tests never reach Supabase. Route tests replace the auth service functions,
so they check our own wiring -- status codes, request parsing, error
shapes -- and nothing else.
"""

import pytest

from app import create_app
from models.profile import Profile, Role


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
