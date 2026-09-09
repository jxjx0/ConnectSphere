"""Tests for signup, login, and the protected /me route."""

import pytest
from pydantic import ValidationError

from models.profile import Profile, Role, SignupRequest
from services import auth_service
from services.auth_service import AuthError

VALID_SIGNUP = {
    "full_name": "Ada Tan",
    "email": "ada@example.com",
    "password": "correct-horse",
    "role": "organiser",
}


# --- models/profile.py: who may self-register ---------------------------


@pytest.mark.parametrize("role", ["organiser", "attendee"])
def test_external_roles_may_self_register(role):
    request = SignupRequest(**{**VALID_SIGNUP, "role": role})

    assert request.role == Role(role)


@pytest.mark.parametrize("role", ["coordinator", "venue_staff", "tech_support"])
def test_internal_roles_may_not_self_register(role):
    with pytest.raises(ValidationError) as caught:
        SignupRequest(**{**VALID_SIGNUP, "role": role})

    assert "cannot be self-registered" in str(caught.value)


def test_unknown_role_is_rejected():
    with pytest.raises(ValidationError):
        SignupRequest(**{**VALID_SIGNUP, "role": "administrator"})


def test_short_password_is_rejected():
    with pytest.raises(ValidationError):
        SignupRequest(**{**VALID_SIGNUP, "password": "short"})


def test_malformed_email_is_rejected():
    with pytest.raises(ValidationError):
        SignupRequest(**{**VALID_SIGNUP, "email": "not-an-email"})


def test_blank_full_name_is_rejected():
    with pytest.raises(ValidationError):
        SignupRequest(**{**VALID_SIGNUP, "full_name": "   "})


def test_full_name_is_stripped():
    request = SignupRequest(**{**VALID_SIGNUP, "full_name": "  Ada Tan  "})

    assert request.full_name == "Ada Tan"


# --- POST /signup -------------------------------------------------------


def test_signup_returns_token_and_profile(client, monkeypatch, organiser_profile):
    monkeypatch.setattr(
        auth_service,
        "signup",
        lambda request: {"access_token": "token-123", "profile": organiser_profile},
    )

    response = client.post("/signup", json=VALID_SIGNUP)

    assert response.status_code == 201
    body = response.get_json()
    assert body["access_token"] == "token-123"
    assert body["profile"]["role"] == "organiser"
    assert body["profile"]["full_name"] == "Ada Tan"


def test_signup_as_internal_role_is_rejected_by_the_backend(client, monkeypatch):
    """The frontend has no coordinator signup page, but the server does not
    rely on that -- it refuses the request on its own."""

    def fail(request):
        raise AssertionError("the service should never be reached")

    monkeypatch.setattr(auth_service, "signup", fail)

    response = client.post("/signup", json={**VALID_SIGNUP, "role": "coordinator"})

    assert response.status_code == 400
    assert "cannot be self-registered" in " ".join(response.get_json()["errors"])


def test_signup_with_missing_fields_is_rejected(client):
    response = client.post("/signup", json={"email": "ada@example.com"})

    assert response.status_code == 400
    assert response.get_json()["errors"]


def test_signup_with_no_body_is_rejected(client):
    response = client.post("/signup")

    assert response.status_code == 400


def test_signup_reports_a_duplicate_email(client, monkeypatch):
    def already_registered(request):
        raise AuthError("User already registered", status_code=400)

    monkeypatch.setattr(auth_service, "signup", already_registered)

    response = client.post("/signup", json=VALID_SIGNUP)

    assert response.status_code == 400
    assert response.get_json()["error"] == "User already registered"


# --- POST /login --------------------------------------------------------


def test_login_returns_token_and_profile(client, monkeypatch, organiser_profile):
    monkeypatch.setattr(
        auth_service,
        "login",
        lambda request: {"access_token": "token-123", "profile": organiser_profile},
    )

    response = client.post(
        "/login", json={"email": "ada@example.com", "password": "correct-horse"}
    )

    assert response.status_code == 200
    assert response.get_json()["access_token"] == "token-123"


def test_login_with_bad_credentials_is_unauthorised(client, monkeypatch):
    def rejected(request):
        raise AuthError("Invalid email or password.", status_code=401)

    monkeypatch.setattr(auth_service, "login", rejected)

    response = client.post(
        "/login", json={"email": "ada@example.com", "password": "wrong"}
    )

    assert response.status_code == 401
    assert response.get_json()["error"] == "Invalid email or password."


def test_login_with_missing_password_is_rejected(client):
    response = client.post("/login", json={"email": "ada@example.com"})

    assert response.status_code == 400


# --- GET /me ------------------------------------------------------------


def test_me_returns_the_current_profile(client, monkeypatch, organiser_profile):
    monkeypatch.setattr(auth_service, "get_user_id", lambda token: organiser_profile.id)
    monkeypatch.setattr(
        auth_service, "get_profile", lambda token, user_id: organiser_profile
    )

    response = client.get("/me", headers={"Authorization": "Bearer token-123"})

    assert response.status_code == 200
    assert response.get_json()["profile"]["id"] == organiser_profile.id


def test_me_without_a_token_is_unauthorised(client):
    response = client.get("/me")

    assert response.status_code == 401


def test_me_with_a_malformed_header_is_unauthorised(client):
    response = client.get("/me", headers={"Authorization": "token-123"})

    assert response.status_code == 401


def test_me_with_an_invalid_token_is_unauthorised(client, monkeypatch):
    def rejected(token):
        raise AuthError("Invalid or expired token.", status_code=401)

    monkeypatch.setattr(auth_service, "get_user_id", rejected)

    response = client.get("/me", headers={"Authorization": "Bearer nonsense"})

    assert response.status_code == 401
    assert response.get_json()["error"] == "Invalid or expired token."


def test_profile_serialises_the_role_as_a_plain_string(organiser_profile):
    assert organiser_profile.model_dump(mode="json")["role"] == "organiser"


def test_profile_accepts_a_supabase_row():
    row = {
        "id": "22222222-2222-2222-2222-222222222222",
        "full_name": "Ben Lim",
        "role": "attendee",
        "created_at": "2026-09-10T04:00:00+00:00",
    }

    profile = Profile(**row)

    assert profile.role == Role.ATTENDEE
