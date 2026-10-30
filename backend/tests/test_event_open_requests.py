"""Open requests are badges on top of the status, not statuses themselves.

A clarification, change request or cancellation request is open while its
status is 'pending'. Opening one never changes the event's status, and an
event cannot move forward while one is open (database/event_status_badges.sql).
"""

import pytest
from postgrest import APIError

import config
from models.event import (
    Event,
    EventChangeRequestSubmit,
    EventClarificationRequest,
    EventReviewSummary,
    EventStatus,
)
from services import event_service, safety_review_service
from services.auth_service import AuthError
from tests.fake_supabase import FakeDatabase
from tests.test_event_change_requests import valid_change_request

EVENT_ID = "event-1"
OTHER_EVENT_ID = "event-2"


def _event(event_id, status=EventStatus.PLANNING):
    return Event(id=event_id, organiser_id="organiser-1", name="Workshop", status=status)


def _pending(table, *event_ids):
    """Only pending rows are asked for, so the fake returns just those."""
    return {(table, "select"): [{"event_id": event_id} for event_id in event_ids]}


def test_each_event_gets_its_own_open_request_badges():
    database = FakeDatabase({
        **_pending("event_clarifications", EVENT_ID),
        **_pending("event_change_requests", EVENT_ID, OTHER_EVENT_ID),
        **_pending("event_cancellation_requests"),
    })

    first, second = event_service._with_open_requests(
        database.client, [_event(EVENT_ID), _event(OTHER_EVENT_ID)]
    )

    assert (first.has_open_clarification, first.has_pending_change_request) == (True, True)
    assert (second.has_open_clarification, second.has_pending_change_request) == (False, True)
    assert not first.has_pending_cancellation_request
    # Only pending rows count as open.
    for table in ("event_clarifications", "event_change_requests", "event_cancellation_requests"):
        (query,) = database.calls_to(table, "select")
        assert ("eq", "status", "pending") in query.filters


def test_coordinator_list_rows_get_badges_too():
    database = FakeDatabase(_pending("event_cancellation_requests", EVENT_ID))
    row = EventReviewSummary(
        id=EVENT_ID, name="Workshop", status="confirmed",
        start_time="2026-12-01T01:00:00Z", end_time="2026-12-01T03:00:00Z",
    )

    (badged,) = event_service._with_open_requests(database.client, [row])

    assert badged.has_pending_cancellation_request is True
    assert badged.status == EventStatus.CONFIRMED


def test_no_events_means_no_queries():
    database = FakeDatabase()

    assert event_service._with_open_requests(database.client, []) == []
    assert database.calls == []


def test_moving_forward_while_a_request_is_open_is_a_conflict(monkeypatch):
    error = APIError({
        "message": "Close the open clarification, change or cancellation request "
                   "before moving this event forward",
        "code": "P0001", "details": None, "hint": None,
    })
    database = FakeDatabase({("events", "update"): error})
    monkeypatch.setattr(config, "get_user_client", lambda token: database.client)

    with pytest.raises(AuthError) as caught:
        event_service.decide_assigned_event(
            "token", "coordinator-1", EVENT_ID, EventStatus.PLANNING
        )

    assert caught.value.status_code == 409
    assert caught.value.message == event_service.OPEN_REQUEST_BLOCKS_MOVE


@pytest.mark.parametrize(
    ("database_message", "expected"),
    [
        ("A clarification is already waiting for a response", "already waiting for the Organiser's reply"),
        ("Review the pending cancellation request first", "pending cancellation request first"),
    ],
)
def test_clarification_conflicts_are_explained(monkeypatch, database_message, expected):
    error = APIError({"message": database_message, "code": "P0001", "details": None, "hint": None})
    database = FakeDatabase({("rpc:request_event_clarification", "rpc"): error})
    monkeypatch.setattr(config, "get_user_client", lambda token: database.client)

    with pytest.raises(AuthError) as caught:
        event_service.request_event_clarification(
            "token", "coordinator-1", EVENT_ID, EventClarificationRequest(notes="Which room?")
        )

    assert caught.value.status_code == 409
    assert expected in caught.value.message


def test_change_request_is_refused_while_cancellation_is_pending(monkeypatch):
    error = APIError({
        "message": "Event cannot be changed while a cancellation request is pending",
        "code": "P0001", "details": None, "hint": None,
    })
    database = FakeDatabase({("rpc:submit_session_change_request", "rpc"): error})
    monkeypatch.setattr(config, "get_user_client", lambda token: database.client)

    with pytest.raises(AuthError) as caught:
        event_service.submit_event_change_request(
            "token", "organiser-1", EVENT_ID,
            EventChangeRequestSubmit(**valid_change_request()),
        )

    assert caught.value.status_code == 409
    assert "cancellation request is waiting for review" in caught.value.message


def _safety_database(monkeypatch, event_status, open_requests):
    database = FakeDatabase({
        ("events", "select"): [{
            "id": EVENT_ID, "name": "Workshop", "status": event_status,
            "coordinator_id": "coordinator-1",
        }],
        ("venue_bookings", "select"): [{"status": "APPROVED"}],
        ("rpc:event_has_open_requests", "rpc"): open_requests,
    })
    for name in ("get_admin_client", "get_user_client", "_get_client"):
        monkeypatch.setattr(safety_review_service, name, lambda *args, **kwargs: database.client)
    monkeypatch.setattr(config, "get_user_client", lambda token: database.client)
    return database


def test_safety_check_waits_for_open_requests(monkeypatch):
    database = _safety_database(monkeypatch, "planning", open_requests=True)

    with pytest.raises(AuthError) as caught:
        safety_review_service.request_safety_check(EVENT_ID, "token")

    assert caught.value.status_code == 409
    assert "close the open clarification, change or cancellation request first" in caught.value.message
    assert database.calls_to("events", "update") == []


def test_event_pages_get_every_request_for_the_history():
    newer = {"id": "c-2", "event_id": EVENT_ID, "organiser_id": "organiser-1",
             "reason": "Plans changed again", "status": "pending"}
    older = {"id": "c-1", "event_id": EVENT_ID, "organiser_id": "organiser-1",
             "reason": "Plans changed", "status": "rejected", "decision_reason": "Still needed"}
    # Rows arrive newest first (ordered by created_at descending).
    database = FakeDatabase({("event_cancellation_requests", "select"): [newer, older]})

    (event,) = event_service._with_cancellation_request(database.client, [_event(EVENT_ID)])

    assert event.cancellation_request.id == "c-2"
    assert [item.id for item in event.cancellation_requests] == ["c-2", "c-1"]
