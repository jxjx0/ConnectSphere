"""Tests for signup, login, and the protected /me route."""

from types import SimpleNamespace
from unittest.mock import Mock

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
    "contact_number": "9123 4567",
    "organization": "Acme Events",
}


# --- models/profile.py: who may self-register ---------------------------


# Organiser and attendee are the two external roles, so both must be accepted.
@pytest.mark.parametrize("role", ["organiser", "attendee"])
def test_external_roles_may_self_register(role):
    request = SignupRequest(**{**VALID_SIGNUP, "role": role})

    assert request.role == Role(role)


# The three internal roles are created by the team in Supabase, never through
# signup, so each one must be refused with our own message.
@pytest.mark.parametrize("role", ["coordinator", "venue_staff", "tech_support"])
def test_internal_roles_may_not_self_register(role):
    with pytest.raises(ValidationError) as caught:
        SignupRequest(**{**VALID_SIGNUP, "role": role})

    assert "cannot be self-registered" in str(caught.value)


# A role that is not in the Role enum at all is refused, not stored as-is.
def test_unknown_role_is_rejected():
    with pytest.raises(ValidationError):
        SignupRequest(**{**VALID_SIGNUP, "role": "administrator"})


# Passwords must be at least 8 characters.
def test_short_password_is_rejected():
    with pytest.raises(ValidationError):
        SignupRequest(**{**VALID_SIGNUP, "password": "short"})


# Passwords are capped at 72 characters, and the message names the field
# rather than using Pydantic's generic "String should have at most...".
def test_long_password_is_rejected():
    with pytest.raises(ValidationError) as caught:
        SignupRequest(**{**VALID_SIGNUP, "password": "a" * 73})

    assert "Password should have at most 72 characters" in str(caught.value)


# 72 characters exactly is the last accepted length, not the first rejected.
def test_password_of_exactly_72_characters_is_accepted():
    request = SignupRequest(**{**VALID_SIGNUP, "password": "a" * 72})

    assert len(request.password) == 72


# The email field has to actually look like an email address.
def test_malformed_email_is_rejected():
    with pytest.raises(ValidationError):
        SignupRequest(**{**VALID_SIGNUP, "email": "not-an-email"})


# A name of only spaces counts as blank, even though it is not an empty string.
def test_blank_full_name_is_rejected():
    with pytest.raises(ValidationError):
        SignupRequest(**{**VALID_SIGNUP, "full_name": "   "})


# contact_number is required for both external roles.
@pytest.mark.parametrize("role", ["organiser", "attendee"])
def test_missing_contact_number_is_rejected(role):
    payload = {**VALID_SIGNUP, "role": role}
    del payload["contact_number"]

    with pytest.raises(ValidationError) as caught:
        SignupRequest(**payload)

    assert "contact_number must not be blank" in str(caught.value)


# Spaces-only counts as blank here too, same as full_name.
def test_blank_contact_number_is_rejected():
    with pytest.raises(ValidationError) as caught:
        SignupRequest(**{**VALID_SIGNUP, "contact_number": "   "})

    assert "contact_number must not be blank" in str(caught.value)


# organization is required for organisers only -- attendees don't have it.
def test_missing_organization_is_rejected_for_organiser():
    payload = {**VALID_SIGNUP, "role": "organiser"}
    del payload["organization"]

    with pytest.raises(ValidationError) as caught:
        SignupRequest(**payload)

    assert "organization must not be blank" in str(caught.value)


def test_organization_is_not_required_for_attendee():
    payload = {**VALID_SIGNUP, "role": "attendee"}
    del payload["organization"]

    request = SignupRequest(**payload)

    assert request.organization is None


# Surrounding spaces are trimmed, so we never store " Ada Tan ".
def test_full_name_is_stripped():
    request = SignupRequest(**{**VALID_SIGNUP, "full_name": "  Ada Tan  "})

    assert request.full_name == "Ada Tan"


# --- POST /signup -------------------------------------------------------


# The happy path: a valid signup returns 201 with the token and profile in the
# shape the frontend expects.
#
# `monkeypatch` replaces auth_service.signup for this one test, so no Supabase
# call happens -- we are checking the route's own wiring, not the database.
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


# The stand-in raises if it is called, which proves the request was stopped by
# validation before it reached the service -- no account could be created.
def test_signup_as_internal_role_is_rejected_by_the_backend(client, monkeypatch):
    """The frontend has no coordinator signup page, but the server does not
    rely on that -- it refuses the request on its own."""

    def fail(request):
        raise AssertionError("the service should never be reached")

    monkeypatch.setattr(auth_service, "signup", fail)

    response = client.post("/signup", json={**VALID_SIGNUP, "role": "coordinator"})

    assert response.status_code == 400
    assert "cannot be self-registered" in " ".join(response.get_json()["errors"])


# A body missing most fields gives a 400 with a list of reasons, not a crash.
def test_signup_with_missing_fields_is_rejected(client):
    response = client.post("/signup", json={"email": "ada@example.com"})

    assert response.status_code == 400
    assert response.get_json()["errors"]


# No body at all is still a clean 400 -- this is what stops it being a 500.
def test_signup_with_no_body_is_rejected(client):
    response = client.post("/signup")

    assert response.status_code == 400


# When Supabase rejects a repeat email, that error reaches the caller intact
# instead of surfacing as a generic server error.
def test_signup_reports_a_duplicate_email(client, monkeypatch):
    def already_registered(request):
        raise AuthError("User already registered", status_code=400)

    monkeypatch.setattr(auth_service, "signup", already_registered)

    response = client.post("/signup", json=VALID_SIGNUP)

    assert response.status_code == 400
    assert response.get_json()["error"] == "User already registered"


@pytest.mark.parametrize("role", ["organiser", "attendee"])
def test_signup_route_and_service_create_auth_user_and_matching_profile(client, monkeypatch, role):
    """Exercise the actual route and service with only Supabase replaced."""
    user_id = "22222222-2222-2222-2222-222222222222"
    auth_client = Mock()
    auth_client.auth.sign_up.return_value = SimpleNamespace(
        user=SimpleNamespace(id=user_id), session=SimpleNamespace(access_token="new-user-token")
    )
    user_client = Mock()
    profile_table = user_client.table.return_value
    payload = {**VALID_SIGNUP, "role": role, "full_name": "  Ada Tan  "}
    if role == "attendee":
        del payload["organization"]
    expected_profile = {
        "id": user_id,
        "full_name": "Ada Tan",
        "role": role,
        "contact_number": VALID_SIGNUP["contact_number"],
        "organization": VALID_SIGNUP["organization"] if role == "organiser" else None,
    }
    profile_table.insert.return_value.execute.return_value = SimpleNamespace(data=[expected_profile])
    get_user_client = Mock(return_value=user_client)
    monkeypatch.setattr(auth_service.config, "get_client", lambda: auth_client)
    monkeypatch.setattr(auth_service.config, "get_user_client", get_user_client)
    monkeypatch.setattr(auth_service.config, "get_admin_client", Mock(side_effect=AssertionError("Signup must not bypass RLS")))

    response = client.post("/signup", json=payload)

    assert response.status_code == 201
    auth_client.auth.sign_up.assert_called_once_with({
        "email": VALID_SIGNUP["email"], "password": VALID_SIGNUP["password"]
    })
    get_user_client.assert_called_once_with("new-user-token")
    user_client.table.assert_called_once_with("profiles")
    profile_table.insert.assert_called_once_with(expected_profile)
    body = response.get_json()
    assert body["access_token"] == "new-user-token"
    assert all(body["profile"][key] == value for key, value in expected_profile.items())
    assert "password" not in body["profile"]


def test_signup_without_session_reports_failure_without_inserting_profile(client, monkeypatch):
    auth_client = Mock()
    auth_client.auth.sign_up.return_value = SimpleNamespace(user=SimpleNamespace(id="new-user"), session=None)
    get_user_client = Mock(side_effect=AssertionError("No profile write without a session"))
    monkeypatch.setattr(auth_service.config, "get_client", lambda: auth_client)
    monkeypatch.setattr(auth_service.config, "get_user_client", get_user_client)

    response = client.post("/signup", json=VALID_SIGNUP)

    assert response.status_code == 502
    assert "Signup did not return a session" in response.get_json()["error"]
    get_user_client.assert_not_called()


# --- POST /login --------------------------------------------------------


# The happy path: correct credentials give 200 and an access token.
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


# A wrong password gives 401, and the message stays vague on purpose: it must
# not reveal whether the email exists.
def test_login_with_bad_credentials_is_unauthorised(client, monkeypatch):
    def rejected(request):
        raise AuthError("Invalid email or password.", status_code=401)

    monkeypatch.setattr(auth_service, "login", rejected)

    response = client.post(
        "/login", json={"email": "ada@example.com", "password": "wrong"}
    )

    assert response.status_code == 401
    assert response.get_json()["error"] == "Invalid email or password."


# A login attempt with no password is a bad request (400), not a failed login.
def test_login_with_missing_password_is_rejected(client):
    response = client.post("/login", json={"email": "ada@example.com"})

    assert response.status_code == 400


# --- GET /me ------------------------------------------------------------


# The happy path: a valid token returns that user's own profile.
def test_me_returns_the_current_profile(client, monkeypatch, organiser_profile):
    monkeypatch.setattr(auth_service, "get_user_id", lambda token: organiser_profile.id)
    monkeypatch.setattr(
        auth_service, "get_profile", lambda token, user_id: organiser_profile
    )

    response = client.get("/me", headers={"Authorization": "Bearer token-123"})

    assert response.status_code == 200
    assert response.get_json()["profile"]["id"] == organiser_profile.id


# No Authorization header at all is refused -- the route is genuinely protected.
def test_me_without_a_token_is_unauthorised(client):
    response = client.get("/me")

    assert response.status_code == 401


# A header missing the "Bearer " prefix is refused too, rather than being
# read as a token by accident.
def test_me_with_a_malformed_header_is_unauthorised(client, monkeypatch):
    def reject_malformed_token(token):
        pytest.fail("malformed headers must be rejected before token validation")

    monkeypatch.setattr(auth_service, "get_user_id", reject_malformed_token)

    response = client.get("/me", headers={"Authorization": "token-123"})

    assert response.status_code == 401


# A well-formed but invalid token: the header parses, then Supabase rejects it,
# and that 401 is passed through to the caller.
def test_me_with_an_invalid_token_is_unauthorised(client, monkeypatch):
    def rejected(token):
        raise AuthError("Invalid or expired token.", status_code=401)

    monkeypatch.setattr(auth_service, "get_user_id", rejected)

    response = client.get("/me", headers={"Authorization": "Bearer nonsense"})

    assert response.status_code == 401
    assert response.get_json()["error"] == "Invalid or expired token."


# --- models/profile.py: the Profile shape -------------------------------


# The role must reach the frontend as "organiser", not "Role.ORGANISER".
def test_profile_serialises_the_role_as_a_plain_string(organiser_profile):
    assert organiser_profile.model_dump(mode="json")["role"] == "organiser"


# A row shaped the way Supabase returns it maps cleanly onto our Profile model.
def test_profile_accepts_a_supabase_row():
    row = {
        "id": "22222222-2222-2222-2222-222222222222",
        "full_name": "Ben Lim",
        "role": "attendee",
        "created_at": "2026-09-10T04:00:00+00:00",
    }

    profile = Profile(**row)

    assert profile.role == Role.ATTENDEE
