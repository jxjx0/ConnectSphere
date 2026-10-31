"""Tests for an Organiser setting up registration and capacity for an event."""

from datetime import datetime, timedelta, timezone

import pytest
from postgrest import APIError
from pydantic import ValidationError

import config
from fake_supabase import FakeDatabase
from models.event import Event, EventRegistrationRequest
from models.profile import Profile, Role
from services import auth_service, event_service
from services.auth_service import AuthError

EVENT_ID = "33333333-3333-3333-3333-333333333333"
ORGANISER_ID = "11111111-1111-1111-1111-111111111111"

ORGANISER = Profile(id=ORGANISER_ID, full_name="Ada Tan", role=Role.ORGANISER)
COORDINATOR = Profile(
    id="22222222-2222-2222-2222-222222222222",
    full_name="Ben Lim",
    role=Role.COORDINATOR,
)


def _in_days(days: int) -> str:
    return (datetime.now(timezone.utc) + timedelta(days=days)).isoformat()


def valid_registration(**overrides) -> dict:
    return {
        "registration_opens_at": _in_days(1),
        "registration_closes_at": _in_days(10),
        "attendee_capacity": 120,
        "publish": False,
        **overrides,
    }


def authenticate_as(monkeypatch, profile: Profile) -> None:
    monkeypatch.setattr(auth_service, "get_user_id", lambda access_token: profile.id)
    monkeypatch.setattr(
        auth_service, "get_profile", lambda access_token, user_id: profile
    )


def _event() -> Event:
    return Event(
        id=EVENT_ID,
        organiser_id=ORGANISER_ID,
        name="Annual Client Summit",
        status="confirmed",
        attendee_capacity=120,
    )


# --- Model -------------------------------------------------------------------


def test_a_valid_registration_period_passes():
    registration = EventRegistrationRequest(**valid_registration())
    assert registration.attendee_capacity == 120
    assert registration.publish is False


@pytest.mark.parametrize("closes_in_days", [1, 0])
def test_registration_must_close_after_it_opens(closes_in_days):
    with pytest.raises(ValidationError) as caught:
        EventRegistrationRequest(
            **valid_registration(registration_closes_at=_in_days(closes_in_days))
        )
    assert "Registration must close after it opens" in str(caught.value)


@pytest.mark.parametrize("capacity", [0, -5])
def test_capacity_must_be_positive(capacity):
    with pytest.raises(ValidationError):
        EventRegistrationRequest(**valid_registration(attendee_capacity=capacity))


# --- Routes ------------------------------------------------------------------


def test_organiser_can_save_registration(client, monkeypatch):
    authenticate_as(monkeypatch, ORGANISER)
    captured = {}

    def save(access_token, organiser_id, event_id, registration):
        captured.update(
            organiser_id=organiser_id, event_id=event_id, registration=registration
        )
        return _event()

    monkeypatch.setattr(event_service, "save_event_registration", save)
    response = client.put(
        f"/events/{EVENT_ID}/registration",
        json=valid_registration(publish=True),
        headers={"Authorization": "Bearer organiser-token"},
    )

    assert response.status_code == 200
    assert response.get_json()["event"]["attendee_capacity"] == 120
    assert captured["organiser_id"] == ORGANISER_ID
    assert captured["event_id"] == EVENT_ID
    assert captured["registration"].publish is True


def test_invalid_registration_is_rejected_before_service_call(client, monkeypatch):
    authenticate_as(monkeypatch, ORGANISER)

    def must_not_save(*args):
        raise AssertionError("an invalid registration must not be saved")

    monkeypatch.setattr(event_service, "save_event_registration", must_not_save)
    response = client.put(
        f"/events/{EVENT_ID}/registration",
        json=valid_registration(registration_closes_at=_in_days(1)),
        headers={"Authorization": "Bearer organiser-token"},
    )

    assert response.status_code == 400
    assert response.get_json()["errors"] == ["Registration must close after it opens"]


def test_non_organiser_cannot_save_registration(client, monkeypatch):
    authenticate_as(monkeypatch, COORDINATOR)

    def must_not_save(*args):
        raise AssertionError("only the Organiser may save registration")

    monkeypatch.setattr(event_service, "save_event_registration", must_not_save)
    response = client.put(
        f"/events/{EVENT_ID}/registration",
        json=valid_registration(),
        headers={"Authorization": "Bearer coordinator-token"},
    )

    assert response.status_code == 403


def test_saving_registration_requires_authentication(client):
    response = client.put(f"/events/{EVENT_ID}/registration", json=valid_registration())
    assert response.status_code == 401


def test_organiser_can_list_their_event_arrangements(client, monkeypatch):
    authenticate_as(monkeypatch, ORGANISER)
    database = FakeDatabase({
        ("rpc:list_event_arrangements", "rpc"): [
            {
                "kind": "venue",
                "session_id": "session-1",
                "status": "APPROVED",
                "venue_name": "Community Hall",
                "venue_location": "Campus West",
                "venue_capacity": 180,
            },
            {"kind": "equipment", "session_id": "session-1", "status": "Pending Technical Approval"},
        ],
    })
    monkeypatch.setattr(config, "get_user_client", lambda access_token: database.client)

    response = client.get(
        f"/events/{EVENT_ID}/arrangements",
        headers={"Authorization": "Bearer organiser-token"},
    )

    assert response.status_code == 200
    arrangements = response.get_json()["arrangements"]
    assert [item["kind"] for item in arrangements] == ["venue", "equipment"]
    assert arrangements[0]["venue_capacity"] == 180
    assert database.calls_to("rpc:list_event_arrangements", "rpc")[0].payload == {
        "p_event_id": EVENT_ID
    }


def test_non_organiser_cannot_list_event_arrangements(client, monkeypatch):
    authenticate_as(monkeypatch, COORDINATOR)
    response = client.get(
        f"/events/{EVENT_ID}/arrangements",
        headers={"Authorization": "Bearer coordinator-token"},
    )
    assert response.status_code == 403


# --- Service -----------------------------------------------------------------


@pytest.mark.parametrize(
    ("code", "status_code", "expected_message"),
    [
        ("42501", 403, "You do not have permission to view the event's venue and equipment."),
        ("XX000", 502, "Unable to load the event's venue and equipment."),
    ],
)
def test_arrangement_read_failures_are_reported_plainly(
    monkeypatch, code, status_code, expected_message
):
    error = APIError({"message": "boom", "code": code, "details": None, "hint": None})
    database = FakeDatabase({("rpc:list_event_arrangements", "rpc"): error})
    monkeypatch.setattr(config, "get_user_client", lambda access_token: database.client)

    with pytest.raises(AuthError) as caught:
        event_service.list_event_arrangements("organiser-token", EVENT_ID)

    assert caught.value.status_code == status_code
    assert caught.value.message == expected_message


def test_service_sends_registration_to_the_database_function(monkeypatch):
    database = FakeDatabase({("rpc:save_event_registration", "rpc"): []})
    monkeypatch.setattr(config, "get_user_client", lambda access_token: database.client)
    monkeypatch.setattr(
        event_service, "get_my_event", lambda token, organiser_id, event_id: _event()
    )
    registration = EventRegistrationRequest(**valid_registration(publish=True))

    event = event_service.save_event_registration(
        "organiser-token", ORGANISER_ID, EVENT_ID, registration
    )

    payload = database.calls_to("rpc:save_event_registration", "rpc")[0].payload
    assert payload["p_event_id"] == EVENT_ID
    assert payload["p_capacity"] == 120
    assert payload["p_publish"] is True
    assert payload["p_opens_at"] == registration.registration_opens_at.isoformat()
    assert event.id == EVENT_ID


@pytest.mark.parametrize(
    ("database_message", "status_code", "expected_message"),
    [
        ("Event request was not found", 404, "Event request was not found."),
        (
            "Registration cannot be set up for an event in its current status",
            409,
            "Registration can only be set up once the Coordinator has approved "
            "the event request.",
        ),
        (
            "Registration has already closed",
            409,
            "Registration has already closed and can no longer be edited.",
        ),
        (
            "Registration must close before the event starts",
            400,
            "Registration must close before the event starts.",
        ),
        (
            "Attendee capacity cannot exceed the combined venue capacity",
            400,
            "Attendee capacity cannot exceed the combined capacity of the "
            "sessions' approved venues.",
        ),
        # A database not yet updated still raises the earlier wording.
        (
            "Attendee capacity cannot exceed the venue capacity",
            400,
            "Attendee capacity cannot exceed the combined capacity of the "
            "sessions' approved venues.",
        ),
        (
            "Every session needs an approved venue before publishing",
            409,
            "Every session needs an approved venue before the event can be published.",
        ),
        (
            "Every equipment request must be approved before publishing",
            409,
            "Every equipment request must be approved before the event can be published.",
        ),
        (
            "The Safety Officer must approve the event before publishing",
            409,
            "The Safety Officer must approve the event before it can be published.",
        ),
    ],
)
def test_service_translates_registration_rule_rejections(
    monkeypatch, database_message, status_code, expected_message
):
    error = APIError(
        {"message": database_message, "code": "P0001", "details": None, "hint": None}
    )
    database = FakeDatabase({("rpc:save_event_registration", "rpc"): error})
    monkeypatch.setattr(config, "get_user_client", lambda access_token: database.client)

    with pytest.raises(AuthError) as caught:
        event_service.save_event_registration(
            "organiser-token",
            ORGANISER_ID,
            EVENT_ID,
            EventRegistrationRequest(**valid_registration()),
        )

    assert caught.value.status_code == status_code
    assert caught.value.message == expected_message


def test_service_hides_unexpected_database_errors(monkeypatch):
    error = APIError(
        {"message": "connection reset", "code": "XX000", "details": None, "hint": None}
    )
    database = FakeDatabase({("rpc:save_event_registration", "rpc"): error})
    monkeypatch.setattr(config, "get_user_client", lambda access_token: database.client)

    with pytest.raises(AuthError) as caught:
        event_service.save_event_registration(
            "organiser-token",
            ORGANISER_ID,
            EVENT_ID,
            EventRegistrationRequest(**valid_registration()),
        )

    assert caught.value.status_code == 502
    assert "connection reset" not in caught.value.message
