"""Venue Staff reviewing booking requests: validation, calendar locking and notifications."""

from types import SimpleNamespace

import pytest
from postgrest import APIError as PostgrestAPIError

import config
from fake_supabase import FakeDatabase
from models.venue_booking import VenueBookingReviewRequest
from services import venue_booking_service
from services.auth_service import AuthError


def pending_booking(**overrides):
    # 10:00-12:00 Singapore time, occupied 09:30-12:45 with venue buffers.
    return {
        "booking_id": "bk-1",
        "venue_id": "v-1",
        "coordinator_id": "coord-1",
        "status": "PENDING_VENUE_APPROVAL",
        "room_layout": "Banquet",
        "start_at": "2026-10-22T02:00:00+00:00",
        "end_at": "2026-10-22T04:00:00+00:00",
        "effective_start_at": "2026-10-22T01:30:00+00:00",
        "effective_end_at": "2026-10-22T04:45:00+00:00",
        "venues": {
            "name": "Hall",
            "setup_time_minutes": 30, "turnaround_time_minutes": 45,
            "layouts": [{"name": "Banquet", "capacity": 100}],
            "operating_hours": {"open": "08:00", "close": "22:00"},
        },
        "events": {"name": "Party", "expected_attendance": 50},
        **overrides,
    }


@pytest.fixture
def notifications(monkeypatch):
    sent = []
    monkeypatch.setattr(venue_booking_service, "notify", lambda *args, **kwargs: sent.append((args, kwargs)))
    return sent


@pytest.fixture
def database(monkeypatch, notifications):
    booking = pending_booking()
    database = FakeDatabase({
        ("venue_bookings", "select"): [booking],
        ("venue_bookings", "update"): lambda query: [{**booking, **query.payload}],
        ("venue_blocks", "select"): [],
        ("venue_blocks", "insert"): lambda query: [{"block_id": "blk-1", **query.payload}],
    })
    database.rpc_calls = []

    def rpc(name, params):
        database.rpc_calls.append((name, params))
        return SimpleNamespace(execute=lambda: SimpleNamespace(data=[]))

    database.client.rpc = rpc
    monkeypatch.setattr(config, "get_user_client", lambda token: database.client)
    return database


def review(status="APPROVED", reason=None):
    return venue_booking_service.review_venue_booking(
        "token", "bk-1", "staff-1", VenueBookingReviewRequest(status=status, rejection_reason=reason),
    )


def test_pending_requests_are_listed(database):
    venue_booking_service.get_pending_venue_bookings("token")

    (query,) = database.calls_to("venue_bookings", "select")
    assert ("eq", "status", "PENDING_VENUE_APPROVAL") in query.filters


def test_pending_requests_can_be_filtered_by_venue(database):
    venue_booking_service.get_pending_venue_bookings("token", venue_id="v-9")

    (query,) = database.calls_to("venue_bookings", "select")
    assert ("eq", "venue_id", "v-9") in query.filters


def test_unknown_booking_is_not_found(database):
    database.responses[("venue_bookings", "select")] = []

    with pytest.raises(AuthError) as caught:
        review()

    assert caught.value.status_code == 404


@pytest.mark.parametrize("status", ["APPROVED", "REJECTED", "AFFECTED_BY_UNAVAILABILITY", "REJECTED_BY_SAFETY"])
def test_processed_requests_cannot_be_reviewed_again(database, status):
    database.responses[("venue_bookings", "select")] = [pending_booking(status=status)]

    with pytest.raises(AuthError) as caught:
        review()

    assert caught.value.status_code == 400


def test_approval_needs_a_supported_layout(database):
    database.responses[("venue_bookings", "select")] = [pending_booking(room_layout="Theatre")]

    with pytest.raises(AuthError) as caught:
        review()

    assert caught.value.status_code == 400
    assert "does not support requested layout" in caught.value.message
    assert database.calls_to("venue_blocks", "insert") == []


def test_approval_needs_layout_capacity_for_the_attendance(database):
    database.responses[("venue_bookings", "select")] = [
        pending_booking(events={"name": "Party", "expected_attendance": 150}),
    ]

    with pytest.raises(AuthError) as caught:
        review()

    assert caught.value.status_code == 400
    assert "exceeds capacity" in caught.value.message
    assert database.calls_to("venue_blocks", "insert") == []


def test_approval_refuses_buffers_outside_operating_hours(database):
    # 08:00-10:00 Singapore with 30 minutes of setup starts at 07:30, before opening.
    database.responses[("venue_bookings", "select")] = [pending_booking(
        effective_start_at="2026-10-21T23:30:00+00:00",
        effective_end_at="2026-10-22T02:45:00+00:00",
    )]

    with pytest.raises(AuthError) as caught:
        review()

    assert caught.value.status_code == 400
    assert "operating hours (08:00 - 22:00)" in caught.value.message
    assert database.calls_to("venue_blocks", "insert") == []


def test_approval_rechecks_the_calendar(database):
    database.responses[("venue_blocks", "select")] = [
        {"block_reason": "Maintenance", "start_at": "a", "end_at": "b"},
    ]

    with pytest.raises(AuthError) as caught:
        review()

    assert caught.value.status_code == 409
    assert "Maintenance" in caught.value.message
    assert database.calls_to("venue_blocks", "insert") == []
    assert database.calls_to("venue_bookings", "update") == []


def test_empty_block_insert_fails_the_approval(database):
    database.responses[("venue_blocks", "insert")] = []

    with pytest.raises(AuthError) as caught:
        review()

    assert caught.value.status_code == 502
    assert database.calls_to("venue_bookings", "update") == []


def test_block_insert_error_fails_the_approval(database):
    database.responses[("venue_blocks", "insert")] = PostgrestAPIError({"message": "down"})

    with pytest.raises(AuthError) as caught:
        review()

    assert caught.value.status_code == 502
    assert database.calls_to("venue_bookings", "update") == []


def test_approval_locks_the_effective_period_linked_to_the_booking(database, notifications):
    approved = review()

    (block_insert,) = database.calls_to("venue_blocks", "insert")
    assert block_insert.payload["booking_id"] == "bk-1"
    assert block_insert.payload["source_booking_id"] == "bk-1"
    assert block_insert.payload["venue_id"] == "v-1"
    assert block_insert.payload["start_at"] == "2026-10-22T01:30:00+00:00"
    assert block_insert.payload["end_at"] == "2026-10-22T04:45:00+00:00"
    assert block_insert.payload["block_reason"].startswith("Approved Booking: Party")
    assert approved["status"] == "APPROVED"
    assert approved["reviewed_by"] == "staff-1"
    assert database.calls.index(block_insert) < database.calls.index(database.calls_to("venue_bookings", "update")[0])
    ((args, kwargs),) = notifications
    assert args[:2] == ("coord-1", "venue_booking_approved")


def test_rejection_records_the_reason_and_notifies(database, notifications):
    rejected = review("REJECTED", "Under renovation")

    assert rejected["status"] == "REJECTED"
    assert rejected["rejection_reason"] == "Under renovation"
    assert database.calls_to("venue_blocks", "insert") == []
    ((args, kwargs),) = notifications
    assert args[:2] == ("coord-1", "venue_booking_rejected")
    assert "Under renovation" in kwargs["body"]


def test_approval_recalculates_current_buffers_before_checking_hours(database):
    booking = pending_booking()
    booking["venues"] = {**booking["venues"], "setup_time_minutes": 150}
    database.responses[("venue_bookings", "select")] = [booking]
    with pytest.raises(AuthError) as caught:
        review()
    assert caught.value.status_code == 400
    assert "operating hours" in caught.value.message
    assert database.calls_to("venue_blocks", "insert") == []
    assert database.calls_to("venue_bookings", "update") == []


def test_approval_expands_and_persists_occupancy_without_changing_event_times(database):
    booking = pending_booking()
    booking["event_id"] = "evt-1"
    booking["venues"] = {**booking["venues"], "setup_time_minutes": 60, "turnaround_time_minutes": 90}
    database.responses[("venue_bookings", "select")] = [booking]
    review()
    block, = database.calls_to("venue_blocks", "insert")
    update, = database.calls_to("venue_bookings", "update")
    assert block.payload["start_at"] == update.payload["effective_start_at"] == "2026-10-22T01:00:00+00:00"
    assert block.payload["end_at"] == update.payload["effective_end_at"] == "2026-10-22T05:30:00+00:00"
    assert update.payload["setup_buffer_minutes"] == 60
    assert update.payload["teardown_buffer_minutes"] == 90
    assert "start_at" not in update.payload and "end_at" not in update.payload
    assert database.rpc_calls[0][1]["p_exclude_event_id"] == "evt-1"
