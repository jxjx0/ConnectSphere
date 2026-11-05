"""Exercise authentication decisions with only the external client replaced."""

from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from postgrest import APIError
from supabase import AuthApiError

import config
from fake_supabase import FakeDatabase
from models.profile import LoginRequest, SignupRequest
from services import auth_service
from services.auth_service import AuthError
from test_auth import VALID_SIGNUP


@pytest.fixture
def auth_clients(monkeypatch):
    anonymous = Mock()
    database = FakeDatabase()
    user_client = Mock(return_value=database.client)
    monkeypatch.setattr(config, "get_client", lambda: anonymous)
    monkeypatch.setattr(config, "get_user_client", user_client)
    monkeypatch.setattr(config, "get_admin_client", Mock(side_effect=AssertionError("Auth must respect RLS")))
    return anonymous, database, user_client


def test_signup_preserves_provider_error_without_writing_profile(auth_clients):
    anonymous, database, user_client = auth_clients
    error = AuthApiError("User already registered", 422, None)
    anonymous.auth.sign_up.side_effect = error

    with pytest.raises(AuthError, match="User already registered") as caught:
        auth_service.signup(SignupRequest(**VALID_SIGNUP))

    assert caught.value.status_code == 400
    assert caught.value.__cause__ is error
    user_client.assert_not_called()
    assert database.calls == []


def test_signup_without_user_does_not_write_profile(auth_clients):
    anonymous, _, user_client = auth_clients
    anonymous.auth.sign_up.return_value = SimpleNamespace(
        user=None, session=SimpleNamespace(access_token="token")
    )
    with pytest.raises(AuthError, match="Signup did not return a session") as caught:
        auth_service.signup(SignupRequest(**VALID_SIGNUP))
    assert caught.value.status_code == 502
    user_client.assert_not_called()


def test_signup_does_not_report_success_when_profile_insert_fails(auth_clients):
    anonymous, database, user_client = auth_clients
    anonymous.auth.sign_up.return_value = SimpleNamespace(
        user=SimpleNamespace(id="new-user"), session=SimpleNamespace(access_token="new-token")
    )
    error = APIError({"code": "42501", "message": "profile insert denied"})
    database.responses[("profiles", "insert")] = error
    with pytest.raises(AuthError, match="Unable to create your profile") as caught:
        auth_service.signup(SignupRequest(**VALID_SIGNUP))
    assert caught.value.__cause__ is error
    assert caught.value.status_code == 502
    assert "profile insert denied" not in caught.value.message
    user_client.assert_called_once_with("new-token")
    assert database.calls_to("profiles", "insert")[0].payload["id"] == "new-user"


def test_login_reads_profile_using_returned_token_and_verified_user(auth_clients, organiser_profile):
    anonymous, database, user_client = auth_clients
    anonymous.auth.sign_in_with_password.return_value = SimpleNamespace(
        user=SimpleNamespace(id=organiser_profile.id),
        session=SimpleNamespace(access_token="verified-token"),
    )
    database.responses[("profiles", "select")] = [organiser_profile.model_dump()]

    result = auth_service.login(LoginRequest(email="ada@example.com", password="secret"))

    assert result == {"access_token": "verified-token", "profile": organiser_profile}
    anonymous.auth.sign_in_with_password.assert_called_once_with(
        {"email": "ada@example.com", "password": "secret"}
    )
    user_client.assert_called_once_with("verified-token")
    assert database.calls[0].filters == [("eq", "id", organiser_profile.id)]


def test_login_provider_failure_does_not_disclose_account_existence(auth_clients):
    anonymous, _, user_client = auth_clients
    error = AuthApiError("Email not confirmed for ada@example.com", 400, None)
    anonymous.auth.sign_in_with_password.side_effect = error
    with pytest.raises(AuthError) as caught:
        auth_service.login(LoginRequest(email="ada@example.com", password="secret"))
    assert caught.value.message == "Invalid email or password."
    assert caught.value.status_code == 401
    assert caught.value.__cause__ is error
    user_client.assert_not_called()


@pytest.mark.parametrize("user,session", [
    (None, SimpleNamespace(access_token="token")),
    (SimpleNamespace(id="user"), None), (None, None),
])
def test_login_requires_both_verified_user_and_session(auth_clients, user, session):
    anonymous, _, user_client = auth_clients
    anonymous.auth.sign_in_with_password.return_value = SimpleNamespace(user=user, session=session)
    with pytest.raises(AuthError, match="Invalid email or password") as caught:
        auth_service.login(LoginRequest(email="ada@example.com", password="secret"))
    assert caught.value.status_code == 401
    user_client.assert_not_called()


def test_token_verification_returns_provider_user_id(auth_clients):
    anonymous, _, user_client = auth_clients
    anonymous.auth.get_user.return_value = SimpleNamespace(user=SimpleNamespace(id="verified-user"))
    assert auth_service.get_user_id("signed-token") == "verified-user"
    anonymous.auth.get_user.assert_called_once_with("signed-token")
    user_client.assert_not_called()


@pytest.mark.parametrize("response", [None, SimpleNamespace(user=None)])
def test_token_verification_rejects_missing_user(auth_clients, response):
    anonymous, _, _ = auth_clients
    anonymous.auth.get_user.return_value = response
    with pytest.raises(AuthError, match="Invalid or expired token") as caught:
        auth_service.get_user_id("invalid-token")
    assert caught.value.status_code == 401


def test_token_verification_translates_provider_error(auth_clients):
    anonymous, _, _ = auth_clients
    error = AuthApiError("JWT expired", 401, None)
    anonymous.auth.get_user.side_effect = error
    with pytest.raises(AuthError, match="Invalid or expired token") as caught:
        auth_service.get_user_id("expired-token")
    assert caught.value.status_code == 401
    assert caught.value.__cause__ is error


def test_missing_profile_is_not_treated_as_logged_in(auth_clients):
    _, database, user_client = auth_clients
    with pytest.raises(AuthError, match="No profile found") as caught:
        auth_service.get_profile("user-token", "user-id")
    assert caught.value.status_code == 404
    user_client.assert_called_once_with("user-token")
    assert database.calls[0].filters == [("eq", "id", "user-id")]


@pytest.mark.parametrize("rows", [None, [], [{"id": "coord", "full_name": "Coordinator"}]])
def test_coordinator_choices_are_scoped_by_role(auth_clients, rows):
    _, database, user_client = auth_clients
    database.responses[("profiles", "select")] = rows
    assert auth_service.get_coordinators("user-token") == (rows or [])
    user_client.assert_called_once_with("user-token")
    assert database.calls[0].filters == [("eq", "role", "coordinator")]


def test_coordinator_choices_read_failure_hides_database_details(auth_clients):
    _, database, _ = auth_clients
    error = APIError({"code": "42P01", "message": "relation profiles does not exist"})
    database.responses[("profiles", "select")] = error
    with pytest.raises(AuthError) as caught:
        auth_service.get_coordinators("user-token")
    assert caught.value.status_code == 502
    assert caught.value.message == "Unable to load coordinators. Please try again."
    assert caught.value.__cause__ is error


def test_login_without_a_profile_does_not_return_a_usable_session(auth_clients):
    anonymous, database, user_client = auth_clients
    anonymous.auth.sign_in_with_password.return_value = SimpleNamespace(
        user=SimpleNamespace(id="missing-profile"), session=SimpleNamespace(access_token="verified-token"),
    )
    with pytest.raises(AuthError, match="No profile found") as caught:
        auth_service.login(LoginRequest(email="ada@example.com", password="secret"))
    assert caught.value.status_code == 404
    user_client.assert_called_once_with("verified-token")
    assert database.calls_to("profiles", "select")[0].filters == [("eq", "id", "missing-profile")]
