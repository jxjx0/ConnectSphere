"""Withdrawal route/service tests. SQL rules have separate PostgreSQL tests."""

from unittest.mock import Mock

import pytest
from postgrest import APIError

from fake_supabase import FakeDatabase
from models.attendee_registration import AttendeeRegistration
from models.profile import Profile, Role
from services import attendee_registration_service as service
from services import auth_service, notification_service
from services.auth_service import AuthError


ATTENDEE_ID = "44444444-4444-4444-4444-444444444444"
REGISTRATION_ID = "55555555-5555-5555-5555-555555555555"
HEADERS = {"Authorization": "Bearer attendee-token"}
URL = f"/attendee/registrations/{REGISTRATION_ID}/withdraw"


def registration(**changes):
    return {
        "id": REGISTRATION_ID,
        "event_id": "33333333-3333-3333-3333-333333333333",
        "attendee_id": ATTENDEE_ID,
        "full_name": "Cara Ng",
        "email": "cara@example.com",
        "contact_number": None,
        "event_name": "Workshop",
        "event_status": "confirmed",
        "status": "withdrawn",
        "withdrawn_at": "2026-11-01T05:00:00Z",
        "can_withdraw": False,
        **changes,
    }


def authenticate(monkeypatch, role=Role.ATTENDEE):
    monkeypatch.setattr(auth_service, "get_user_id", lambda token: ATTENDEE_ID)
    monkeypatch.setattr(auth_service, "get_profile", lambda *args: Profile(
        id=ATTENDEE_ID, full_name="Cara Ng", role=role,
    ))


def use_rpc(monkeypatch, response):
    db = FakeDatabase({("rpc:withdraw_event_registration", "rpc"): response})
    user_client = Mock(return_value=db.client)
    monkeypatch.setattr(service.config, "get_user_client", user_client)
    return db, user_client


@pytest.mark.parametrize("changed", [True, False])
def test_withdrawal_emails_only_on_the_first_transition_without_in_app_notice(monkeypatch, changed):
    db, user_client = use_rpc(monkeypatch, {
        "registration": registration(), "changed": changed,
    })
    notify = Mock()
    monkeypatch.setattr(notification_service, "notify", notify)
    email = Mock(return_value=True)
    monkeypatch.setattr(notification_service, "try_send_email", email)

    result = service.withdraw_registration("token", REGISTRATION_ID)

    assert result.status == "withdrawn"
    assert result.can_withdraw is False
    assert result.contact_number is None
    assert "address" not in result.model_dump()
    user_client.assert_called_once_with("token")
    assert db.calls[0].payload == {"p_registration_id": REGISTRATION_ID}
    notify.assert_not_called()
    assert email.call_count == int(changed)
    if changed:
        email.assert_called_once_with(
            "cara@example.com",
            "Registration withdrawn: Workshop",
            "Your registration for 'Workshop' has been withdrawn. "
            "You no longer hold a place at this event.",
        )


@pytest.mark.parametrize("message,code,status", [
    ("Only a signed-in attendee can withdraw a registration", "P0001", 403),
    ("Registration was not found", "P0001", 404),
    ("invalid uuid", "22P02", 404),
    ("Withdrawal is unavailable once the event has started", "P0001", 409),
    ("Withdrawal is unavailable for an event that has ended or been cancelled", "P0001", 409),
    ("function missing", "PGRST202", 503),
    ("permission denied", "42501", 403),
    ("private database detail", "XX000", 502),
])
def test_errors_are_translated_without_notifying(monkeypatch, message, code, status):
    use_rpc(monkeypatch, APIError({"message": message, "code": code}))
    notify = Mock()
    monkeypatch.setattr(notification_service, "notify", notify)
    email = Mock()
    monkeypatch.setattr(notification_service, "try_send_email", email)

    with pytest.raises(AuthError) as caught:
        service.withdraw_registration("token", REGISTRATION_ID)

    assert caught.value.status_code == status
    assert "private database detail" not in str(caught.value)
    notify.assert_not_called()
    email.assert_not_called()


def test_route_returns_saved_registration(client, monkeypatch):
    authenticate(monkeypatch)
    withdraw = Mock(return_value=AttendeeRegistration(**registration()))
    monkeypatch.setattr(service, "withdraw_registration", withdraw)
    response = client.post(URL, headers=HEADERS)
    assert response.status_code == 200
    assert response.json["registration"]["status"] == "withdrawn"
    withdraw.assert_called_once_with("attendee-token", REGISTRATION_ID)


def test_route_requires_login(client, monkeypatch):
    withdraw = Mock()
    monkeypatch.setattr(service, "withdraw_registration", withdraw)
    assert client.post(URL).status_code == 401
    withdraw.assert_not_called()


@pytest.mark.parametrize("role", [role for role in Role if role != Role.ATTENDEE])
def test_other_roles_cannot_withdraw(client, monkeypatch, role):
    authenticate(monkeypatch, role)
    withdraw = Mock()
    monkeypatch.setattr(service, "withdraw_registration", withdraw)
    assert client.post(URL, headers=HEADERS).status_code == 403
    withdraw.assert_not_called()


def test_route_returns_conflict(client, monkeypatch):
    authenticate(monkeypatch)
    monkeypatch.setattr(service, "withdraw_registration", Mock(
        side_effect=AuthError("Event has started.", status_code=409),
    ))
    response = client.post(URL, headers=HEADERS)
    assert response.status_code == 409
    assert response.json["error"] == "Event has started."


def test_email_failure_does_not_undo_withdrawal(monkeypatch, caplog):
    use_rpc(monkeypatch, {"registration": registration(), "changed": True})
    save_notification = Mock()
    monkeypatch.setattr(notification_service, "_save_notification", save_notification)
    monkeypatch.setattr(notification_service, "send_email", Mock(
        side_effect=RuntimeError("unavailable"),
    ))
    assert service.withdraw_registration("token", REGISTRATION_ID).status == "withdrawn"
    assert "Could not send email" in caplog.text
    save_notification.assert_not_called()
