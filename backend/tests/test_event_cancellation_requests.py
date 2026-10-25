"""Tests for an Organiser requesting event cancellation."""

from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from pydantic import ValidationError
from postgrest import APIError

import config
from models.event import (
    Event,
    EventCancellationRequest,
    EventCancellationRequestSubmit,
    EventStatus,
)
from models.profile import Profile, Role
from services import auth_service, event_service
from services.auth_service import AuthError

EVENT_ID = "33333333-3333-3333-3333-333333333333"
ORGANISER_ID = "11111111-1111-1111-1111-111111111111"
COORDINATOR_ID = "22222222-2222-2222-2222-222222222222"

ORGANISER = Profile(
    id=ORGANISER_ID,
    full_name="Ada Tan",
    role=Role.ORGANISER,
)
COORDINATOR = Profile(
    id=COORDINATOR_ID,
    full_name="Ben Lim",
    role=Role.COORDINATOR,
)


def authenticate_as(monkeypatch, profile: Profile) -> None:
    monkeypatch.setattr(
        auth_service, "get_user_id", lambda access_token: profile.id
    )
    monkeypatch.setattr(
        auth_service, "get_profile", lambda access_token, user_id: profile
    )


def test_cancellation_request_requires_a_nonblank_reason():
    request = EventCancellationRequestSubmit(reason="  Plans have changed  ")
    assert request.reason == "Plans have changed"

    with pytest.raises(ValidationError):
        EventCancellationRequestSubmit(reason="   ")


def test_service_submits_reason_to_atomic_rpc_and_loads_saved_request(monkeypatch):
    request_id = "44444444-4444-4444-4444-444444444444"
    captured = {}
    row = {
        "id": request_id,
        "event_id": EVENT_ID,
        "organiser_id": ORGANISER_ID,
        "reason": "Plans have changed",
        "previous_event_status": "confirmed",
        "status": "pending",
        "created_at": datetime.now(timezone.utc).isoformat(),
    }

    class Query:
        def __init__(self, rows):
            self.rows = rows

        def select(self, *columns):
            return self

        def eq(self, column, value):
            captured.setdefault("filters", []).append((column, value))
            return self

        def execute(self):
            return SimpleNamespace(data=self.rows)

    class Client:
        def rpc(self, name, payload):
            captured["rpc"] = (name, payload)
            return SimpleNamespace(execute=lambda: SimpleNamespace(data=request_id))

        def table(self, name):
            captured["table"] = name
            return Query([row])

    monkeypatch.setattr(config, "get_user_client", lambda token: Client())

    saved = event_service.submit_event_cancellation_request(
        "organiser-token",
        ORGANISER_ID,
        EVENT_ID,
        EventCancellationRequestSubmit(reason=" Plans have changed "),
    )

    assert saved.reason == "Plans have changed"
    assert saved.previous_event_status == EventStatus.CONFIRMED
    assert captured["rpc"] == (
        "submit_event_cancellation_request",
        {"p_event_id": EVENT_ID, "p_reason": "Plans have changed"},
    )
    assert captured["table"] == "event_cancellation_requests"
    assert captured["filters"] == [
        ("id", request_id),
        ("organiser_id", ORGANISER_ID),
    ]


@pytest.mark.parametrize(
    ("database_message", "status_code", "expected_message"),
    [
        (
            "A pending cancellation request already exists",
            409,
            "A cancellation request is already waiting for review.",
        ),
        (
            "Event cannot be cancelled in its current status",
            409,
            "Cancellation requests are only available for events in planning, "
            "awaiting clarification, awaiting a safety check, with a change "
            "request or confirmed.",
        ),
        ("Event request was not found", 404, "Event request was not found."),
        (
            "Only the signed-in organiser can request event cancellation",
            403,
            "Only the event Organiser can request cancellation.",
        ),
    ],
)
def test_service_maps_cancellation_submission_errors(
    monkeypatch, database_message, status_code, expected_message
):
    class Query:
        def execute(self):
            raise APIError(
                {
                    "code": "P0001",
                    "message": database_message,
                    "details": None,
                    "hint": None,
                }
            )

    class Client:
        def rpc(self, name, payload):
            return Query()

    monkeypatch.setattr(config, "get_user_client", lambda token: Client())

    with pytest.raises(AuthError) as caught:
        event_service.submit_event_cancellation_request(
            "organiser-token",
            ORGANISER_ID,
            EVENT_ID,
            EventCancellationRequestSubmit(reason="Plans have changed"),
        )

    assert caught.value.status_code == status_code
    assert caught.value.message == expected_message


def test_event_detail_includes_the_pending_request_and_reason():
    request_row = {
        "id": "44444444-4444-4444-4444-444444444444",
        "event_id": EVENT_ID,
        "organiser_id": ORGANISER_ID,
        "reason": "Plans have changed",
        "previous_event_status": "planning",
        "status": "pending",
    }

    class Query:
        def select(self, *columns):
            return self

        def in_(self, column, values):
            assert column == "event_id"
            assert values == [EVENT_ID]
            return self

        def order(self, column, desc=False):
            assert column == "created_at"
            assert desc is True
            return self

        def execute(self):
            return SimpleNamespace(data=[request_row])

    class Client:
        def table(self, name):
            assert name == "event_cancellation_requests"
            return Query()

    event = Event(
        id=EVENT_ID,
        organiser_id=ORGANISER_ID,
        status=EventStatus.PLANNING,
        name="Annual Client Summit",
    )
    enriched = event_service._with_cancellation_request(Client(), [event])[0]

    assert enriched.has_pending_cancellation_request is True
    assert enriched.cancellation_request is not None
    assert enriched.cancellation_request.reason == "Plans have changed"
    assert enriched.cancellation_request.previous_event_status == EventStatus.PLANNING


def test_organiser_can_submit_a_cancellation_request_and_coordinator_is_notified(
    client, monkeypatch
):
    authenticate_as(monkeypatch, ORGANISER)
    saved_request = EventCancellationRequest(
        id="44444444-4444-4444-4444-444444444444",
        event_id=EVENT_ID,
        organiser_id=ORGANISER_ID,
        reason="Plans have changed",
        previous_event_status=EventStatus.CONFIRMED,
    )
    event = Event(
        id=EVENT_ID,
        organiser_id=ORGANISER_ID,
        coordinator_id=COORDINATOR_ID,
        status=EventStatus.CONFIRMED,
        name="Annual Client Summit",
    )
    captured = {}
    monkeypatch.setattr(
        event_service, "submit_event_cancellation_request",
        lambda *args: saved_request,
    )
    monkeypatch.setattr(event_service, "get_my_event", lambda *args: event)
    monkeypatch.setattr(
        "routes.events.notification_service.notify",
        lambda *args: captured.setdefault("notification", args),
    )

    response = client.post(
        f"/events/{EVENT_ID}/cancellation-requests",
        json={"reason": "Plans have changed"},
        headers={"Authorization": "Bearer organiser-token"},
    )

    assert response.status_code == 201
    assert response.get_json()["cancellation_request"]["reason"] == "Plans have changed"
    assert response.get_json()["cancellation_request"]["previous_event_status"] == "confirmed"
    assert captured["notification"] == (
        COORDINATOR_ID,
        "event_cancellation_requested",
        "Event cancellation requested",
        "Ada Tan has requested cancellation of 'Annual Client Summit'. "
        "Reason: Plans have changed",
        EVENT_ID,
    )


def test_invalid_cancellation_reason_does_not_reach_service(client, monkeypatch):
    authenticate_as(monkeypatch, ORGANISER)

    def must_not_submit(*args, **kwargs):
        raise AssertionError("invalid input must not reach the service")

    monkeypatch.setattr(
        event_service, "submit_event_cancellation_request", must_not_submit
    )
    response = client.post(
        f"/events/{EVENT_ID}/cancellation-requests",
        json={"reason": "   "},
        headers={"Authorization": "Bearer organiser-token"},
    )

    assert response.status_code == 400
    assert "A cancellation reason must not be blank" in response.get_json()["errors"]


def test_non_organiser_cannot_submit_a_cancellation_request(client, monkeypatch):
    authenticate_as(monkeypatch, COORDINATOR)
    monkeypatch.setattr(
        event_service,
        "submit_event_cancellation_request",
        lambda *args: pytest.fail("a Coordinator must not submit this request"),
    )

    response = client.post(
        f"/events/{EVENT_ID}/cancellation-requests",
        json={"reason": "Plans have changed"},
        headers={"Authorization": "Bearer coordinator-token"},
    )

    assert response.status_code == 403


def test_cancellation_request_requires_authentication(client):
    response = client.post(
        f"/events/{EVENT_ID}/cancellation-requests",
        json={"reason": "Plans have changed"},
    )

    assert response.status_code == 401


def test_failed_cancellation_request_does_not_notify_the_coordinator(
    client, monkeypatch
):
    authenticate_as(monkeypatch, ORGANISER)

    def fail_submission(*args):
        raise AuthError("A cancellation request is already waiting for review.", 409)

    monkeypatch.setattr(
        event_service, "submit_event_cancellation_request", fail_submission
    )
    monkeypatch.setattr(
        "routes.events.notification_service.notify",
        lambda *args: pytest.fail("a failed request must not notify the Coordinator"),
    )

    response = client.post(
        f"/events/{EVENT_ID}/cancellation-requests",
        json={"reason": "Plans have changed"},
        headers={"Authorization": "Bearer organiser-token"},
    )

    assert response.status_code == 409
