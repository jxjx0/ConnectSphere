"""Completion timestamp, expired-request serialization and review conflicts."""

from datetime import datetime, timezone

from postgrest import APIError
import pytest

import config
from fake_supabase import FakeDatabase
from models.event import Event, EventCancellationRequest, EventChangeRequest, EventChangeRequestDecision
from services import event_service
from services.auth_service import AuthError


def test_event_serializes_completion_timestamp_and_accepts_older_rows():
    row = {"id": "event-1", "organiser_id": "organiser-1", "name": "Workshop", "status": "completed"}
    assert Event(**row).completed_at is None

    completed = Event(**row, completed_at="2026-10-26T05:00:00Z")
    assert completed.completed_at == datetime(2026, 10, 26, 5, tzinfo=timezone.utc)
    assert completed.model_dump(mode="json")["completed_at"] == "2026-10-26T05:00:00Z"


def test_expired_requests_serialize_and_are_not_reported_as_pending():
    event = Event(
        id="event-1", organiser_id="organiser-1", name="Workshop", status="completed"
    )
    common = {
        "id": "request-1", "event_id": event.id,
        "organiser_id": event.organiser_id, "status": "expired",
    }
    change = EventChangeRequest(
        **common, name="Workshop",
        description="Description", reason_for_change="New title", purpose="Training",
        category="workshop", start_time="2026-10-26T04:00:00Z",
        end_time="2026-10-26T05:00:00Z", expected_attendance=20,
    )
    cancellation = EventCancellationRequest(
        **common, reason="Cancel"
    )
    database = FakeDatabase({
        ("event_change_requests", "select"): [change.model_dump(mode="json")],
        ("event_cancellation_requests", "select"): [cancellation.model_dump(mode="json")],
    })
    result = event_service._with_change_request(database.client, [event])
    result = event_service._with_cancellation_request(database.client, result)[0]
    assert result.change_request.status == "expired"
    assert result.cancellation_request.status == "expired"
    assert not result.has_pending_change_request
    assert not result.has_pending_cancellation_request

    # Exercise the actual badge builder, including resetting stale flags.
    pending = Event(id="event-2", organiser_id="organiser-2", name="Pending", status="planning")
    result = result.model_copy(update={"has_pending_change_request": True, "has_pending_cancellation_request": True})
    database.responses[("event_change_requests", "select")] = [{"event_id": pending.id}]
    database.responses[("event_cancellation_requests", "select")] = [{"event_id": pending.id}]
    expired_result, pending_result = event_service._with_open_requests(database.client, [result, pending])
    assert not expired_result.has_pending_change_request
    assert not expired_result.has_pending_cancellation_request
    assert pending_result.has_pending_change_request
    assert pending_result.has_pending_cancellation_request
    assert not expired_result.has_open_clarification
    assert not pending_result.has_open_clarification
    for table in ("event_clarifications", "event_change_requests", "event_cancellation_requests"):
        assert database.calls_to(table, "select")[-1].filters == [
            ("in_", "event_id", [result.id, pending.id]), ("eq", "status", "pending"),
        ]


@pytest.mark.parametrize("decision", ["approve", "reject"])
def test_review_of_expired_change_returns_conflict(monkeypatch, decision):
    function = (
        "approve_session_change_request" if decision == "approve"
        else "reject_event_change_request"
    )
    error = APIError({
        "message": "Change request is no longer pending", "code": "P0001",
        "details": None, "hint": None,
    })
    database = FakeDatabase({(f"rpc:{function}", "rpc"): error})
    monkeypatch.setattr(config, "get_user_client", lambda token: database.client)
    with pytest.raises(AuthError, match="expired") as caught:
        event_service.review_assigned_change_request(
            "token", "coordinator-1", "event-1", decision,
            rejection=EventChangeRequestDecision(reason="No longer needed") if decision == "reject" else None,
        )
    assert caught.value.status_code == 409
