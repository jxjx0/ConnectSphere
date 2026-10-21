"""Venue booking requests: venue-defined buffers, operating hours, duplicates and clashes."""

from datetime import datetime, timedelta, timezone

from types import SimpleNamespace

import pytest
from postgrest import APIError as PostgrestAPIError

import config
from fake_supabase import FakeDatabase
from models.venue_booking import VenueBookingCreateRequest
from services import venue_booking_service
from services.auth_service import AuthError

SGT = timezone(timedelta(hours=8))
VENUE = {
    "setup_time_minutes": 30,
    "turnaround_time_minutes": 45,
    "operating_hours": {"open": "08:00", "close": "22:00"},
}


def booking_request(start_hour=10, end_hour=12, event_id="evt-1", day=22):
    return VenueBookingCreateRequest(
        event_id=event_id,
        room_layout="Banquet",
        start_at=datetime(2026, 10, day, start_hour, 0, tzinfo=SGT),
        end_at=datetime(2026, 10, day, end_hour, 0, tzinfo=SGT),
    )


@pytest.fixture
def database(monkeypatch):
    database = FakeDatabase({
        ("venues", "select"): [VENUE],
        ("venue_bookings", "select"): [],
        ("venue_blocks", "select"): [],
        ("venue_bookings", "insert"): lambda query: [{"booking_id": "bk-new", **query.payload}],
    })
    database.rpc_calls = []

    def rpc(name, params):
        database.rpc_calls.append((name, params))
        return SimpleNamespace(execute=lambda: SimpleNamespace(data=[]))

    database.client.rpc = rpc
    monkeypatch.setattr(config, "get_user_client", lambda token: database.client)
    return database


def test_effective_period_uses_the_venue_buffers_not_the_request(database):
    booking = venue_booking_service.create_venue_booking("token", "v-1", booking_request(), "coord-1")

    assert booking["status"] == "PENDING_VENUE_APPROVAL"
    assert booking["setup_buffer_minutes"] == 30
    assert booking["teardown_buffer_minutes"] == 45
    assert datetime.fromisoformat(booking["effective_start_at"]) == datetime(2026, 10, 22, 9, 30, tzinfo=SGT)
    assert datetime.fromisoformat(booking["effective_end_at"]) == datetime(2026, 10, 22, 12, 45, tzinfo=SGT)
    assert booking["coordinator_id"] == "coord-1"


def test_clash_check_covers_the_effective_period(database):
    venue_booking_service.create_venue_booking("token", "v-1", booking_request(), "coord-1")

    (clash_query,) = database.calls_to("venue_blocks", "select")
    filters = {name: value for name, _, value in clash_query.filters}
    assert datetime.fromisoformat(filters["lt"]) == datetime(2026, 10, 22, 12, 45, tzinfo=SGT)
    assert datetime.fromisoformat(filters["gt"]) == datetime(2026, 10, 22, 9, 30, tzinfo=SGT)


@pytest.mark.parametrize("start,end", [
    # Setup would start at 07:30, before opening.
    (datetime(2026, 10, 22, 8, 0, tzinfo=SGT), datetime(2026, 10, 22, 10, 0, tzinfo=SGT)),
    # Turnaround would run to 22:45, after closing.
    (datetime(2026, 10, 22, 20, 0, tzinfo=SGT), datetime(2026, 10, 22, 22, 0, tzinfo=SGT)),
    # Overnight requests cannot fit same-day hours.
    (datetime(2026, 10, 22, 21, 0, tzinfo=SGT), datetime(2026, 10, 23, 1, 0, tzinfo=SGT)),
])
def test_requests_outside_operating_hours_are_refused(database, start, end):
    request = VenueBookingCreateRequest(event_id="evt-1", room_layout="Banquet", start_at=start, end_at=end)

    with pytest.raises(AuthError) as caught:
        venue_booking_service.create_venue_booking("token", "v-1", request, "coord-1")

    assert caught.value.status_code == 400
    assert "08:00 - 22:00" in caught.value.message
    assert database.calls_to("venue_bookings", "insert") == []


def test_operating_hours_are_singapore_time_not_utc(database):
    # 10:00-12:00 Singapore is 02:00-04:00 UTC, which a UTC comparison would wrongly refuse.
    request = VenueBookingCreateRequest(
        event_id="evt-1", room_layout="Banquet",
        start_at=datetime(2026, 10, 22, 2, 0, tzinfo=timezone.utc),
        end_at=datetime(2026, 10, 22, 4, 0, tzinfo=timezone.utc),
    )

    venue_booking_service.create_venue_booking("token", "v-1", request, "coord-1")

    assert len(database.calls_to("venue_bookings", "insert")) == 1


def test_unreadable_stored_hours_do_not_block_a_request(database):
    database.responses[("venues", "select")] = [{**VENUE, "operating_hours": None}]

    venue_booking_service.create_venue_booking("token", "v-1", booking_request(22, 23), "coord-1")

    assert len(database.calls_to("venue_bookings", "insert")) == 1


def test_unknown_venue_is_not_found(database):
    database.responses[("venues", "select")] = []

    with pytest.raises(AuthError) as caught:
        venue_booking_service.create_venue_booking("token", "v-1", booking_request(), "coord-1")

    assert caught.value.status_code == 404


@pytest.mark.parametrize("status", ["PENDING_VENUE_APPROVAL", "APPROVED"])
def test_a_live_request_for_the_same_venue_and_event_is_a_duplicate(database, status):
    database.responses[("venue_bookings", "select")] = [{"booking_id": "bk-old", "status": status}]

    with pytest.raises(AuthError) as caught:
        venue_booking_service.create_venue_booking("token", "v-1", booking_request(), "coord-1")

    assert caught.value.status_code == 409
    assert "already been submitted" in caught.value.message
    assert database.calls_to("venue_bookings", "insert") == []


def test_only_live_requests_count_as_duplicates(database):
    venue_booking_service.create_venue_booking("token", "v-1", booking_request(), "coord-1")

    (duplicate_query,) = database.calls_to("venue_bookings", "select")
    assert ("eq", "venue_id", "v-1") in duplicate_query.filters
    assert ("eq", "event_id", "evt-1") in duplicate_query.filters
    assert ("in_", "status", ["PENDING_VENUE_APPROVAL", "APPROVED"]) in duplicate_query.filters


@pytest.mark.parametrize("settled_status", [
    "REJECTED", "REJECTED_BY_SAFETY", "AFFECTED_BY_UNAVAILABILITY", "CANCELLED",
])
def test_settled_requests_may_be_retried(database, settled_status):
    existing = [{"booking_id": "bk-old", "status": settled_status}]

    def matching_rows(query):
        allowed = next(values for name, column, values in query.filters if name == "in_")
        return [row for row in existing if row["status"] in allowed]

    database.responses[("venue_bookings", "select")] = matching_rows

    venue_booking_service.create_venue_booking("token", "v-1", booking_request(), "coord-1")

    assert len(database.calls_to("venue_bookings", "insert")) == 1


def test_requests_without_an_event_skip_the_duplicate_check(database):
    venue_booking_service.create_venue_booking("token", "v-1", booking_request(event_id=None), "coord-1")

    assert database.calls_to("venue_bookings", "select") == []


def test_a_clashing_block_refuses_the_request(database):
    database.responses[("venue_blocks", "select")] = [{"block_id": "blk-1"}]

    with pytest.raises(AuthError) as caught:
        venue_booking_service.create_venue_booking("token", "v-1", booking_request(), "coord-1")

    assert caught.value.status_code == 409
    assert database.calls_to("venue_bookings", "insert") == []


def test_clash_check_failure_is_reported(database):
    database.responses[("venue_blocks", "select")] = PostgrestAPIError({"message": "down"})

    with pytest.raises(AuthError) as caught:
        venue_booking_service.create_venue_booking("token", "v-1", booking_request(), "coord-1")

    assert caught.value.status_code == 502
    assert "Unable to verify venue schedule availability" in caught.value.message


def test_insert_failure_is_reported(database):
    database.responses[("venue_bookings", "insert")] = PostgrestAPIError({"message": "down"})

    with pytest.raises(AuthError) as caught:
        venue_booking_service.create_venue_booking("token", "v-1", booking_request(), "coord-1")

    assert caught.value.status_code == 502
    assert "Unable to submit venue booking request" in caught.value.message


def test_empty_insert_result_is_reported(database):
    database.responses[("venue_bookings", "insert")] = []

    with pytest.raises(AuthError) as caught:
        venue_booking_service.create_venue_booking("token", "v-1", booking_request(), "coord-1")

    assert caught.value.status_code == 502
    assert "was not created" in caught.value.message


def test_schedule_conflict_query_uses_half_open_overlap(database):
    database.responses[("venue_blocks", "select")] = [{"block_id": "blk-1"}]

    result = venue_booking_service.check_schedule_conflict_details(
        database.client, "v-1", "2026-10-22T01:30:00+00:00", "2026-10-22T04:45:00+00:00",
    )

    assert result == [{"block_id": "blk-1"}]
    (query,) = database.calls_to("venue_blocks", "select")
    assert query.filters == [
        ("eq", "venue_id", "v-1"),
        ("lt", "start_at", "2026-10-22T04:45:00+00:00"),
        ("gt", "end_at", "2026-10-22T01:30:00+00:00"),
    ]


@pytest.mark.parametrize("own_hold", [True, False])
def test_creation_excludes_only_the_linked_events_hold(database, own_hold):
    request = VenueBookingCreateRequest(
        event_id="evt-1", room_layout="Banquet",
        start_at="2099-11-07T10:00:00+08:00", end_at="2099-11-07T12:00:00+08:00",
    )
    calls = []

    def rpc(name, params):
        calls.append((name, params))
        assert name == "get_venue_reservations"
        assert params["p_exclude_event_id"] == request.event_id
        assert params["p_holds_only"] is True
        rows = [] if own_hold else [{
            "id": "00000000-0000-0000-0000-000000000041", "venue_id": "v-1",
            "type": "tentative_hold", "reason": "Tentative hold",
            "start_at": "2099-11-07T09:30:00+08:00", "end_at": "2099-11-07T12:45:00+08:00",
            "expires_at": "2099-11-06T12:00:00+08:00",
        }]
        return SimpleNamespace(execute=lambda: SimpleNamespace(data=rows))

    database.client.rpc = rpc
    if own_hold:
        result = venue_booking_service.create_venue_booking("token", "v-1", request, "coord-1")
        assert result["status"] == "PENDING_VENUE_APPROVAL"
    else:
        with pytest.raises(AuthError) as caught:
            venue_booking_service.create_venue_booking("token", "v-1", request, "coord-1")
        assert caught.value.status_code == 409
        assert database.calls_to("venue_bookings", "insert") == []
    assert len(calls) == 1
    assert not any(call.table == "venue_tentative_holds" for call in database.calls)
