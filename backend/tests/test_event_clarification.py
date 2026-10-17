"""Coordinator clarification request validation, authorization and persistence."""

from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from postgrest import APIError
from pydantic import ValidationError

import config
from models.event import (
    Event,
    EventClarification,
    EventClarificationRequest,
    EventStatus,
)
from models.profile import Profile, Role
from services import auth_service, event_service
from services.auth_service import AuthError

COORDINATOR_ID = "22222222-2222-2222-2222-222222222222"
ORGANISER_ID = "11111111-1111-1111-1111-111111111111"
EVENT_ID = "33333333-3333-3333-3333-333333333333"


class FakeQuery:
    def __init__(self, rows, calls):
        self.rows = rows
        self.calls = calls

    def select(self, *columns):
        self.calls.append(("select", columns))
        return self

    def eq(self, column, value):
        self.calls.append(("eq", column, value))
        return self

    def neq(self, column, value):
        self.calls.append(("neq", column, value))
        return self

    def order(self, column):
        self.calls.append(("order", column))
        return self

    def execute(self):
        return SimpleNamespace(data=self.rows)


class FakeRpc:
    def __init__(self, error=None):
        self.error = error

    def execute(self):
        if self.error:
            raise self.error
        return SimpleNamespace(data=[])


def fake_client(monkeypatch, rows_by_table, calls, rpc_calls, rpc_error=None):
    def rpc(name, args):
        rpc_calls.append((name, args))
        return FakeRpc(rpc_error)

    monkeypatch.setattr(
        config,
        "get_user_client",
        lambda token: SimpleNamespace(
            rpc=rpc,
            table=lambda table_name: FakeQuery(rows_by_table[table_name], calls),
        ),
    )


def authenticate_as(monkeypatch, profile):
    monkeypatch.setattr(auth_service, "get_user_id", lambda token: profile.id)
    monkeypatch.setattr(auth_service, "get_profile", lambda token, user_id: profile)


COORDINATOR = Profile(id=COORDINATOR_ID, full_name="Ben Lim", role=Role.COORDINATOR)

ASSIGNED_EVENT = Event(
    id=EVENT_ID,
    organiser_id=ORGANISER_ID,
    coordinator_id=COORDINATOR_ID,
    name="Annual Client Summit",
    status=EventStatus.AWAITING_CLARIFICATION,
)

SAVED_CLARIFICATION = EventClarification(
    id="44444444-4444-4444-4444-444444444444",
    event_id=EVENT_ID,
    organiser_id=ORGANISER_ID,
    coordinator_id=COORDINATOR_ID,
    coordinator_notes="Confirm the room layout.",
    previous_status=EventStatus.PLANNING,
    requested_at=datetime(2026, 10, 1, tzinfo=timezone.utc),
)


def stub_notification_lookups(monkeypatch, captured=None):
    """Stub the event lookup and notify() used after a clarification is saved."""
    monkeypatch.setattr(
        event_service,
        "get_assigned_event",
        lambda token, coordinator_id, event_id: ASSIGNED_EVENT,
    )
    monkeypatch.setattr(
        "routes.events.notification_service.notify",
        lambda *args: (captured if captured is not None else {}).setdefault(
            "notification", args
        ),
    )


def test_clarification_notes_are_trimmed_and_required():
    request = EventClarificationRequest(notes="  Confirm the room layout.  ")

    assert request.notes == "Confirm the room layout."
    with pytest.raises(ValidationError):
        EventClarificationRequest(notes="   ")


def test_assigned_event_in_supported_status_can_request_clarification(monkeypatch):
    calls = []
    rpc_calls = []
    older_row = {
        "id": "55555555-5555-5555-5555-555555555555",
        "event_id": EVENT_ID,
        "organiser_id": ORGANISER_ID,
        "coordinator_id": COORDINATOR_ID,
        "coordinator_notes": "Confirm the date.",
        "previous_status": "under_review",
        "organiser_response": "The date is confirmed.",
        "requested_at": datetime(2026, 9, 1, tzinfo=timezone.utc).isoformat(),
        "responded_at": datetime(2026, 9, 2, tzinfo=timezone.utc).isoformat(),
    }
    new_row = {
        "id": "44444444-4444-4444-4444-444444444444",
        "event_id": EVENT_ID,
        "organiser_id": ORGANISER_ID,
        "coordinator_id": COORDINATOR_ID,
        "coordinator_notes": "Confirm the room layout.",
        "previous_status": "planning",
        "requested_at": datetime(2026, 10, 1, tzinfo=timezone.utc).isoformat(),
    }
    fake_client(
        monkeypatch,
        {
            "events": [{"id": EVENT_ID}],
            "event_clarifications": [older_row, new_row],
        },
        calls,
        rpc_calls,
    )

    clarification = event_service.request_event_clarification(
        "coordinator-token",
        COORDINATOR_ID,
        EVENT_ID,
        EventClarificationRequest(notes="Confirm the room layout."),
    )

    assert rpc_calls == [
        (
            "request_event_clarification",
            {
                "p_event_id": EVENT_ID,
                "p_coordinator_id": COORDINATOR_ID,
                "p_notes": "Confirm the room layout.",
            },
        )
    ]
    assert ("eq", "coordinator_id", COORDINATOR_ID) in calls
    assert isinstance(clarification, EventClarification)
    assert clarification.id == new_row["id"]
    assert clarification.coordinator_notes == "Confirm the room layout."
    assert clarification.previous_status is EventStatus.PLANNING


def test_event_in_unsupported_status_cannot_request_clarification(monkeypatch):
    error = APIError({
        "message": "Event cannot be clarified in its current status",
        "code": "P0001",
    })
    fake_client(monkeypatch, {}, [], [], rpc_error=error)

    with pytest.raises(AuthError) as caught:
        event_service.request_event_clarification(
            "coordinator-token",
            COORDINATOR_ID,
            EVENT_ID,
            EventClarificationRequest(notes="Confirm the room layout."),
        )

    assert caught.value.status_code == 409


def test_coordinator_route_saves_and_returns_clarification(client, monkeypatch):
    coordinator = Profile(
        id=COORDINATOR_ID,
        full_name="Ben Lim",
        role=Role.COORDINATOR,
    )
    authenticate_as(monkeypatch, coordinator)
    saved_clarification = EventClarification(
        id="44444444-4444-4444-4444-444444444444",
        event_id=EVENT_ID,
        organiser_id=ORGANISER_ID,
        coordinator_id=COORDINATOR_ID,
        coordinator_notes="Confirm the room layout.",
        previous_status=EventStatus.PLANNING,
        requested_at=datetime(2026, 10, 1, tzinfo=timezone.utc),
    )
    captured = {}

    def request_clarification(token, coordinator_id, event_id, request):
        captured.update(
            coordinator_id=coordinator_id,
            event_id=event_id,
            notes=request.notes,
        )
        return saved_clarification

    monkeypatch.setattr(
        event_service, "request_event_clarification", request_clarification
    )
    stub_notification_lookups(monkeypatch)

    response = client.post(
        f"/events/review/{EVENT_ID}/clarification",
        headers={"Authorization": "Bearer coordinator-token"},
        json={"notes": "  Confirm the room layout.  "},
    )

    assert response.status_code == 201
    assert captured == {
        "coordinator_id": COORDINATOR_ID,
        "event_id": EVENT_ID,
        "notes": "Confirm the room layout.",
    }
    assert response.get_json()["clarification"]["event_id"] == EVENT_ID
    assert response.get_json()["clarification"]["coordinator_notes"] == (
        "Confirm the room layout."
    )
    assert response.get_json()["clarification"]["previous_status"] == "planning"


def test_non_coordinator_cannot_request_clarification(client, monkeypatch):
    organiser = Profile(
        id=ORGANISER_ID,
        full_name="Ada Tan",
        role=Role.ORGANISER,
    )
    authenticate_as(monkeypatch, organiser)

    def request_clarification(*args):
        raise AssertionError("the service must not be reached")

    monkeypatch.setattr(
        event_service, "request_event_clarification", request_clarification
    )

    response = client.post(
        f"/events/review/{EVENT_ID}/clarification",
        headers={"Authorization": "Bearer organiser-token"},
        json={"notes": "Please confirm the room layout."},
    )

    assert response.status_code == 403


def test_clarification_route_rejects_blank_notes(client, monkeypatch):
    coordinator = Profile(
        id=COORDINATOR_ID,
        full_name="Ben Lim",
        role=Role.COORDINATOR,
    )
    authenticate_as(monkeypatch, coordinator)

    response = client.post(
        f"/events/review/{EVENT_ID}/clarification",
        headers={"Authorization": "Bearer coordinator-token"},
        json={"notes": "  "},
    )

    assert response.status_code == 400
    assert "Clarification notes must not be blank" in response.get_json()["errors"]


# --- T7-160: notifying the Organiser -------------------------------------


def post_clarification(client):
    return client.post(
        f"/events/review/{EVENT_ID}/clarification",
        headers={"Authorization": "Bearer coordinator-token"},
        json={"notes": "Confirm the room layout."},
    )


def test_clarification_request_notifies_the_organiser(client, monkeypatch):
    authenticate_as(monkeypatch, COORDINATOR)
    monkeypatch.setattr(
        event_service,
        "request_event_clarification",
        lambda token, coordinator_id, event_id, request: SAVED_CLARIFICATION,
    )
    captured = {}
    stub_notification_lookups(monkeypatch, captured)

    response = post_clarification(client)

    assert response.status_code == 201
    user_id, notification_type, title, body, event_id = captured["notification"]
    assert user_id == ORGANISER_ID
    assert notification_type == "clarification_requested"
    assert title == "Clarification requested"
    assert "Ben Lim" in body
    assert "Annual Client Summit" in body
    assert "Awaiting Clarification" in body
    assert "Confirm the room layout." in body
    assert event_id == EVENT_ID


def test_failed_clarification_request_sends_no_notification(client, monkeypatch):
    authenticate_as(monkeypatch, COORDINATOR)

    def failing_request(*args):
        raise AuthError("Only events under review can be clarified.", 409)

    monkeypatch.setattr(
        event_service, "request_event_clarification", failing_request
    )
    monkeypatch.setattr(
        "routes.events.notification_service.notify",
        lambda *args: pytest.fail("a failed request must not notify anyone"),
    )

    response = post_clarification(client)

    assert response.status_code == 409


def test_clarification_is_still_saved_when_notification_fails(client, monkeypatch):
    authenticate_as(monkeypatch, COORDINATOR)
    monkeypatch.setattr(
        event_service,
        "request_event_clarification",
        lambda token, coordinator_id, event_id, request: SAVED_CLARIFICATION,
    )
    stub_notification_lookups(monkeypatch)
    # notify() returns None, rather than raising, when it cannot save.
    monkeypatch.setattr(
        "routes.events.notification_service.notify", lambda *args: None
    )

    response = post_clarification(client)

    assert response.status_code == 201


def test_clarification_is_still_saved_when_event_lookup_fails(client, monkeypatch):
    authenticate_as(monkeypatch, COORDINATOR)
    monkeypatch.setattr(
        event_service,
        "request_event_clarification",
        lambda token, coordinator_id, event_id, request: SAVED_CLARIFICATION,
    )

    def failing_lookup(*args):
        raise AuthError("Unable to load the event request.", 502)

    monkeypatch.setattr(event_service, "get_assigned_event", failing_lookup)
    monkeypatch.setattr(
        "routes.events.notification_service.notify",
        lambda *args: pytest.fail("no notification without the event name"),
    )

    response = post_clarification(client)

    assert response.status_code == 201
