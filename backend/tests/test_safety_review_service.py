"""Safety Officer decisions: status transitions, audit log, releases and notifications."""

import pytest
from postgrest import APIError as PostgrestAPIError

from fake_supabase import FakeDatabase
from services import safety_review_service
from services.auth_service import AuthError

EVENT_ID = "evt-1"
AWAITING_EVENT = {
    "id": EVENT_ID,
    "name": "Safety Summit",
    "status": "awaiting_safety_check",
    "coordinator_id": "coord-1",
}
BOOKINGS = [
    {"booking_id": "bk-approved", "venue_id": "v-1", "status": "APPROVED",
     "effective_start_at": "2026-10-22T01:30:00+00:00", "effective_end_at": "2026-10-22T04:45:00+00:00"},
    {"booking_id": "bk-affected", "venue_id": "v-2", "status": "AFFECTED_BY_UNAVAILABILITY",
     "effective_start_at": "2026-10-22T01:30:00+00:00", "effective_end_at": "2026-10-22T04:45:00+00:00"},
    {"booking_id": "bk-pending", "venue_id": "v-3", "status": "PENDING_VENUE_APPROVAL",
     "effective_start_at": "2026-10-22T01:30:00+00:00", "effective_end_at": "2026-10-22T04:45:00+00:00"},
]


@pytest.fixture
def notifications(monkeypatch):
    sent = []
    monkeypatch.setattr(safety_review_service, "notify", lambda **kwargs: sent.append(kwargs))
    return sent


@pytest.fixture
def database(monkeypatch, notifications):
    database = FakeDatabase({
        ("events", "select"): [AWAITING_EVENT],
        ("events", "update"): lambda query: [{**AWAITING_EVENT, **query.payload}],
        ("event_safety_reviews", "insert"): lambda query: [query.payload],
        ("venue_bookings", "select"): BOOKINGS,
        ("venue_blocks", "delete"): lambda query: [{"block_id": "blk"}],
        ("equipment_requests", "select"): [{"id": "req-1"}, {"id": "req-2"}],
    })
    monkeypatch.setattr(safety_review_service, "_get_client", lambda access_token=None: database.client)
    return database


def decide(decision, reason=None):
    return safety_review_service.submit_safety_decision(
        event_id=EVENT_ID,
        safety_officer_id="officer-1",
        decision=decision,
        notes="Checked exits",
        rejection_or_change_reason=reason,
        access_token="token",
    )


def test_unknown_decisions_are_refused(database):
    with pytest.raises(AuthError) as caught:
        decide("maybe")

    assert caught.value.status_code == 400
    assert database.calls == []


@pytest.mark.parametrize("decision", ["rejected", "changes_requested"])
@pytest.mark.parametrize("reason", [None, "   "])
def test_rejections_and_change_requests_need_a_reason(database, decision, reason):
    with pytest.raises(AuthError) as caught:
        decide(decision, reason)

    assert caught.value.status_code == 400
    assert database.calls == []


def test_missing_event_is_not_found(database):
    database.responses[("events", "select")] = []

    with pytest.raises(AuthError) as caught:
        decide("approved")

    assert caught.value.status_code == 404


@pytest.mark.parametrize("status", ["planning", "confirmed", "under_review"])
def test_only_events_awaiting_safety_check_can_be_decided(database, status):
    database.responses[("events", "select")] = [{**AWAITING_EVENT, "status": status}]

    with pytest.raises(AuthError) as caught:
        decide("approved")

    assert caught.value.status_code == 409
    assert database.calls_to("event_safety_reviews", "insert") == []
    assert database.calls_to("events", "update") == []


@pytest.mark.parametrize("decision,reason,next_status", [
    ("approved", None, "confirmed"),
    ("changes_requested", "Add a second exit", "planning"),
    ("rejected", "Unsafe crowd flow", "planning"),
])
def test_decision_moves_the_event_by_status_only(database, decision, reason, next_status):
    updated = decide(decision, reason)

    (event_update,) = database.calls_to("events", "update")
    assert event_update.payload["status"] == next_status
    assert "updated_at" in event_update.payload
    assert not any(key.startswith("safety_") for key in event_update.payload)
    assert updated["status"] == next_status
    (audit,) = database.calls_to("event_safety_reviews", "insert")
    assert audit.payload == {
        "event_id": EVENT_ID,
        "safety_officer_id": "officer-1",
        "decision": decision.upper(),
        "notes": "Checked exits",
        "reason": reason,
    }


@pytest.mark.parametrize("decision,reason", [("approved", None), ("changes_requested", "Add a second exit")])
def test_only_rejection_releases_arrangements(database, decision, reason):
    decide(decision, reason)

    assert database.calls_to("venue_bookings", "update") == []
    assert database.calls_to("venue_blocks", "delete") == []
    assert database.calls_to("equipment_bookings", "delete") == []
    assert database.calls_to("equipment_requests", "update") == []


def test_rejection_releases_only_live_venue_bookings(database):
    decide("rejected", "Unsafe crowd flow")

    (booking_query,) = database.calls_to("venue_bookings", "select")
    assert ("in_", "status", ["PENDING_VENUE_APPROVAL", "APPROVED", "AFFECTED_BY_UNAVAILABILITY"]) in booking_query.filters
    updates = database.calls_to("venue_bookings", "update")
    assert [update.filters for update in updates] == [
        [("eq", "booking_id", "bk-approved")],
        [("eq", "booking_id", "bk-affected")],
        [("eq", "booking_id", "bk-pending")],
    ]
    assert all(u.payload == {
        "status": "REJECTED_BY_SAFETY",
        "rejection_reason": "Safety Officer Rejection: Unsafe crowd flow",
    } for u in updates)


def test_rejection_clears_calendar_blocks_of_bookings_that_hold_them(database):
    decide("rejected", "Unsafe crowd flow")

    deleted = [call.filters for call in database.calls_to("venue_blocks", "delete")]
    assert deleted == [
        [("eq", "booking_id", "bk-approved")],
        [("eq", "booking_id", "bk-affected")],
    ]


def test_rejection_clears_old_blocks_created_before_booking_links(database):
    database.responses[("venue_bookings", "select")] = [BOOKINGS[0]]
    database.responses[("venue_blocks", "delete")] = lambda query: (
        [] if ("eq", "booking_id", "bk-approved") in query.filters else [{"block_id": "old"}]
    )

    decide("rejected", "Unsafe crowd flow")

    linked, fallback = database.calls_to("venue_blocks", "delete")
    assert linked.filters == [("eq", "booking_id", "bk-approved")]
    assert fallback.filters == [
        ("eq", "venue_id", "v-1"),
        ("eq", "start_at", "2026-10-22T01:30:00+00:00"),
        ("eq", "end_at", "2026-10-22T04:45:00+00:00"),
        ("is_", "booking_id", "null"),
        ("like", "block_reason", "Approved Booking:%"),
    ]


def test_rejection_releases_equipment_bookings_and_requests(database):
    decide("rejected", "Unsafe crowd flow")

    (request_query,) = database.calls_to("equipment_requests", "select")
    # Rejected and cancelled requests are left as they are (T7-282).
    assert ("in_", "status", ["Pending Technical Approval", "Approved"]) in request_query.filters
    (equipment_delete,) = database.calls_to("equipment_bookings", "delete")
    assert equipment_delete.filters == [("in_", "request_id", ["req-1", "req-2"])]
    (request_update,) = database.calls_to("equipment_requests", "update")
    assert request_update.payload == {"status": "Rejected"}
    assert request_update.filters == [("in_", "id", ["req-1", "req-2"])]


def test_rejection_without_equipment_touches_no_equipment(database):
    database.responses[("equipment_requests", "select")] = []

    decide("rejected", "Unsafe crowd flow")

    assert database.calls_to("equipment_bookings", "delete") == []
    assert database.calls_to("equipment_requests", "update") == []


@pytest.mark.parametrize("decision,reason,notification_type,phrase", [
    ("approved", None, "safety_review_approved", "now confirmed"),
    ("changes_requested", "Add a second exit", "safety_review_changes_requested", "back in Planning"),
    ("rejected", "Unsafe crowd flow", "safety_review_rejected", "have been released"),
])
def test_coordinator_is_told_the_outcome(database, notifications, decision, reason, notification_type, phrase):
    decide(decision, reason)

    (notification,) = notifications
    assert notification["user_id"] == "coord-1"
    assert notification["notification_type"] == notification_type
    assert notification["event_id"] == EVENT_ID
    assert phrase in notification["body"]
    if reason:
        assert reason in notification["body"]


def test_events_without_a_coordinator_are_still_decided(database, notifications):
    database.responses[("events", "select")] = [{**AWAITING_EVENT, "coordinator_id": None}]

    decide("approved")

    assert notifications == []
    assert len(database.calls_to("events", "update")) == 1


def test_latest_safety_decision_is_the_newest_review(monkeypatch):
    latest = {"decision": "REJECTED", "reason": "Unsafe crowd flow", "created_at": "2026-10-19T11:00:00+00:00"}
    reviews = FakeDatabase({("event_safety_reviews", "select"): [latest]})
    monkeypatch.setattr(safety_review_service, "get_user_client", lambda token: reviews.client)

    assert safety_review_service.get_latest_safety_decision("token", EVENT_ID) == latest
    (query,) = reviews.calls_to("event_safety_reviews", "select")
    assert query.filters == [("eq", "event_id", EVENT_ID), ("order", "created_at"), ("limit", 1)]


def test_events_without_a_safety_decision_have_none(monkeypatch):
    reviews = FakeDatabase({("event_safety_reviews", "select"): []})
    monkeypatch.setattr(safety_review_service, "get_user_client", lambda token: reviews.client)

    assert safety_review_service.get_latest_safety_decision("token", EVENT_ID) is None


def test_unreadable_safety_history_does_not_break_the_event_page(monkeypatch):
    reviews = FakeDatabase({("event_safety_reviews", "select"): PostgrestAPIError({"message": "down"})})
    monkeypatch.setattr(safety_review_service, "get_user_client", lambda token: reviews.client)

    assert safety_review_service.get_latest_safety_decision("token", EVENT_ID) is None


def test_database_errors_are_reported(database):
    database.responses[("event_safety_reviews", "insert")] = PostgrestAPIError({"message": "down"})

    with pytest.raises(AuthError) as caught:
        decide("approved")

    assert caught.value.status_code == 400
    assert database.calls_to("events", "update") == []
