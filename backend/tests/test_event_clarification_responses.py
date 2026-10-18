"""Organiser response validation, authorization and clarification history."""

from datetime import datetime, timezone
from pathlib import Path
import re
from types import SimpleNamespace

import pytest
from postgrest import APIError
from pydantic import ValidationError

import config
from models.event import (
    EventClarification,
    EventClarificationResponse,
)
from models.profile import Profile, Role
from services import auth_service, event_service

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


def clarification_row(**overrides):
    row = {
        "id": "44444444-4444-4444-4444-444444444444",
        "event_id": EVENT_ID,
        "organiser_id": ORGANISER_ID,
        "coordinator_id": COORDINATOR_ID,
        "coordinator_notes": "Confirm the room layout and attendance.",
        "previous_status": "planning",
        "organiser_response": "Theatre layout for 80 attendees.",
        "requested_at": datetime(2026, 10, 1, tzinfo=timezone.utc).isoformat(),
        "responded_at": datetime(2026, 10, 2, tzinfo=timezone.utc).isoformat(),
    }
    row.update(overrides)
    return row


def authenticate_as(monkeypatch, profile):
    monkeypatch.setattr(auth_service, "get_user_id", lambda token: profile.id)
    monkeypatch.setattr(
        auth_service, "get_profile", lambda token, user_id: profile
    )


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
    def __init__(self, result=None, error=None):
        self.result = result or []
        self.error = error

    def execute(self):
        if self.error:
            raise self.error
        return SimpleNamespace(data=self.result)


def test_response_model_trims_text_and_rejects_blank_or_oversized_input():
    response = EventClarificationResponse(
        response="  Theatre layout for 80 attendees.  "
    )

    assert response.response == "Theatre layout for 80 attendees."
    with pytest.raises(ValidationError):
        EventClarificationResponse(response="   ")
    with pytest.raises(ValidationError):
        EventClarificationResponse(response="x" * 5001)


def test_service_saves_reply_for_the_event_and_returns_updated_history(monkeypatch):
    calls = []
    rpc_calls = []
    saved_row = clarification_row()
    rows_by_table = {
        "events": [{"id": EVENT_ID}],
        "event_clarifications": [saved_row],
    }

    def rpc(name, args):
        rpc_calls.append((name, args))
        return FakeRpc()

    monkeypatch.setattr(
        config,
        "get_user_client",
        lambda token: SimpleNamespace(
            rpc=rpc,
            table=lambda name: FakeQuery(rows_by_table[name], calls),
        ),
    )

    clarification = event_service.respond_to_event_clarification(
        "organiser-token",
        ORGANISER_ID,
        EVENT_ID,
        EventClarificationResponse(response="Theatre layout for 80 attendees."),
    )

    assert rpc_calls == [
        (
            "respond_to_event_clarification",
            {
                "p_event_id": EVENT_ID,
                "p_organiser_id": ORGANISER_ID,
                "p_response": "Theatre layout for 80 attendees.",
            },
        )
    ]
    assert ("eq", "organiser_id", ORGANISER_ID) in calls
    assert ("eq", "event_id", EVENT_ID) in calls
    assert clarification.event_id == EVENT_ID
    assert clarification.previous_status.value == "planning"
    assert clarification.organiser_response == "Theatre layout for 80 attendees."


def test_response_route_returns_saved_exchange_and_uses_signed_in_organiser(
    client, monkeypatch
):
    authenticate_as(monkeypatch, ORGANISER)
    saved = EventClarification(**clarification_row())
    captured = {}

    def respond(access_token, organiser_id, event_id, response):
        captured.update(
            organiser_id=organiser_id,
            event_id=event_id,
            response=response.response,
        )
        return saved

    monkeypatch.setattr(event_service, "respond_to_event_clarification", respond)
    monkeypatch.setattr(
        event_service,
        "get_my_event",
        lambda *args: SimpleNamespace(
            name="Annual Client Summit", coordinator_id="current-coordinator-id"
        ),
    )
    monkeypatch.setattr(
        "routes.events.notification_service.notify",
        lambda *args: captured.setdefault("notification", args),
    )

    result = client.post(
        f"/events/{EVENT_ID}/clarification-response",
        headers={"Authorization": "Bearer organiser-token"},
        json={"response": "  Theatre layout for 80 attendees.  "},
    )

    assert result.status_code == 200
    assert {key: value for key, value in captured.items() if key != "notification"} == {
        "organiser_id": ORGANISER_ID,
        "event_id": EVENT_ID,
        "response": "Theatre layout for 80 attendees.",
    }
    assert result.get_json()["clarification"]["event_id"] == EVENT_ID
    assert result.get_json()["clarification"]["organiser_response"]
    assert result.get_json()["clarification"]["coordinator_notes"]
    assert captured["notification"] == (
        "current-coordinator-id",
        "event_clarification_responded",
        "Clarification response received",
        "The Organiser responded to the clarification for event request "
        "'Annual Client Summit': Theatre layout for 80 attendees.",
        EVENT_ID,
    )


def test_response_route_succeeds_when_event_lookup_fails(client, monkeypatch):
    authenticate_as(monkeypatch, ORGANISER)
    saved = EventClarification(**clarification_row())
    notified = []

    monkeypatch.setattr(
        event_service,
        "respond_to_event_clarification",
        lambda *args: saved,
    )

    def fail_to_load_event(*args):
        raise RuntimeError("event lookup failed")

    monkeypatch.setattr(event_service, "get_my_event", fail_to_load_event)
    monkeypatch.setattr(
        "routes.events.notification_service.notify",
        lambda *args: notified.append(args),
    )

    result = client.post(
        f"/events/{EVENT_ID}/clarification-response",
        headers={"Authorization": "Bearer organiser-token"},
        json={"response": "Details provided."},
    )

    assert result.status_code == 200
    assert result.get_json()["clarification"]["event_id"] == EVENT_ID
    assert notified == []


def test_organiser_can_view_clarification_history(client, monkeypatch):
    authenticate_as(monkeypatch, ORGANISER)
    history = [EventClarification(**clarification_row())]
    captured = {}

    def list_clarifications(access_token, event_id, *, organiser_id):
        captured.update(event_id=event_id, organiser_id=organiser_id)
        return history

    monkeypatch.setattr(
        event_service, "list_event_clarifications", list_clarifications
    )

    result = client.get(
        f"/events/{EVENT_ID}/clarifications",
        headers={"Authorization": "Bearer organiser-token"},
    )

    assert result.status_code == 200
    assert captured == {"event_id": EVENT_ID, "organiser_id": ORGANISER_ID}
    assert result.get_json()["clarifications"][0]["coordinator_notes"]


def test_non_organiser_cannot_submit_a_clarification_response(client, monkeypatch):
    authenticate_as(monkeypatch, COORDINATOR)

    def respond(*args):
        raise AssertionError("the service must not be reached")

    monkeypatch.setattr(event_service, "respond_to_event_clarification", respond)

    result = client.post(
        f"/events/{EVENT_ID}/clarification-response",
        headers={"Authorization": "Bearer coordinator-token"},
        json={"response": "Theatre layout for 80 attendees."},
    )

    assert result.status_code == 403


def test_blank_clarification_response_is_rejected_before_service_call(
    client, monkeypatch
):
    authenticate_as(monkeypatch, ORGANISER)

    def respond(*args):
        raise AssertionError("the service must not be reached")

    monkeypatch.setattr(event_service, "respond_to_event_clarification", respond)

    result = client.post(
        f"/events/{EVENT_ID}/clarification-response",
        headers={"Authorization": "Bearer organiser-token"},
        json={"response": "   "},
    )

    assert result.status_code == 400
    assert "Your response must not be blank" in result.get_json()["errors"]


def test_response_is_rejected_when_event_is_not_awaiting_clarification(
    monkeypatch,
):
    error = APIError(
        {"code": "P0001", "message": "Event is not awaiting clarification"}
    )
    monkeypatch.setattr(
        config,
        "get_user_client",
        lambda token: SimpleNamespace(
            rpc=lambda name, args: FakeRpc(error=error)
        ),
    )

    with pytest.raises(event_service.AuthError) as caught:
        event_service.respond_to_event_clarification(
            "organiser-token",
            ORGANISER_ID,
            EVENT_ID,
            EventClarificationResponse(response="Details provided."),
        )

    assert caught.value.status_code == 409


def test_clarification_sql_saves_and_restores_the_previous_event_status():
    migration_path = (
        Path(__file__).resolve().parents[2]
        / "database"
        / "event_clarifications.sql"
    )
    sql = re.sub(r"\s+", " ", migration_path.read_text(encoding="utf-8")).lower()

    assert (
        "event_id, organiser_id, coordinator_id, coordinator_notes, previous_status ) "
        "values ( p_event_id, current_event.organiser_id, p_coordinator_id, "
        "btrim(p_notes), current_event.status )"
    ) in sql
    assert (
        "set status = coalesce(current_clarification.previous_status, 'under_review')"
    ) in sql
