"""Booking data verification and legacy layout compatibility."""

from datetime import datetime
from unittest.mock import Mock

import pytest
from httpx import ReadTimeout
from postgrest import APIError

from models.venue import OperatingHours
from models.venue_booking import VenueBookingCancelRequest, VenueBookingReviewRequest
from services import venue_availability_service as availability, venue_booking_service as bookings
from services.auth_service import AuthError
from test_review_venue_request import pending_booking
from test_venue_booking import database, booking_request


@pytest.mark.parametrize("table", ["venue_bookings", "venue_tentative_holds"])
@pytest.mark.parametrize("response", [None, {}])
def test_event_booking_context_refuses_incomplete_reads(database, table, response):
    database.responses[("venue_bookings", "select")] = []
    database.responses[("venue_tentative_holds", "select")] = []
    database.responses[(table, "select")] = response
    with pytest.raises(AuthError, match="Unable to load this event's venue arrangements") as caught:
        bookings.get_event_booking_context("token", "event")
    assert caught.value.status_code == 502


@pytest.mark.parametrize("failure", [APIError({"code": "42501", "message": "private details"}), ReadTimeout("timeout")])
def test_event_booking_context_does_not_turn_failed_read_into_empty_arrangements(database, failure):
    database.responses[("venue_bookings", "select")] = failure
    with pytest.raises(AuthError) as caught:
        bookings.get_event_booking_context("token", "event")
    assert caught.value.status_code == 502
    assert caught.value.__cause__ is failure
    assert database.calls_to("venue_tentative_holds", "select") == []


@pytest.mark.parametrize("table,status,message", [
    ("venues", 502, "Unable to verify venue buffers"),
    ("event_sessions", 502, "Unable to verify the event session"),
    ("events", 502, "Unable to verify the event request"),
])
def test_failed_booking_prerequisite_check_never_creates_request(database, table, status, message):
    database.responses[(table, "select")] = APIError({"code": "42501", "message": "private details"})
    with pytest.raises(AuthError, match=message) as caught:
        bookings.create_venue_booking("token", "v-1", booking_request(), "coordinator")
    assert caught.value.status_code == status
    assert database.calls_to("venue_bookings", "insert") == []


def test_booking_insert_without_returned_row_is_unconfirmed(database):
    database.responses[("venue_bookings", "insert")] = []
    with pytest.raises(AuthError, match="Venue booking request was not created") as caught:
        bookings.create_venue_booking("token", "v-1", booking_request(), "coordinator")
    assert caught.value.status_code == 502


@pytest.mark.parametrize("missing", ["start_time", "end_time"])
def test_booking_cannot_target_an_unscheduled_session(database, missing):
    session = {**database.responses[("event_sessions", "select")][0], missing: None}
    database.responses[("event_sessions", "select")] = [session]
    with pytest.raises(AuthError, match="That session has no scheduled time yet") as caught:
        bookings.create_venue_booking("token", "v-1", booking_request(), "coordinator")
    assert caught.value.status_code == 400
    assert database.calls_to("venue_bookings", "insert") == []


@pytest.mark.parametrize("missing", [[], None])
def test_booking_requires_an_existing_visible_venue(database, missing):
    database.responses[("venues", "select")] = missing
    with pytest.raises(AuthError, match="Venue was not found") as caught:
        bookings.create_venue_booking("token", "v-1", booking_request(), "coordinator")
    assert caught.value.status_code == 404
    assert database.calls_to("venue_bookings", "insert") == []


def test_occupancy_rejects_legacy_timestamp_without_timezone():
    booking = pending_booking(start_at="2026-10-22T10:00:00")
    with pytest.raises(AuthError, match="Unable to verify venue buffers") as caught:
        bookings._booking_occupancy(booking)
    assert caught.value.status_code == 502
    assert isinstance(caught.value.__cause__, ValueError)


@pytest.mark.parametrize("hours", [None, {}, {"open": "08:00"}, "invalid"])
def test_unknown_operating_hours_have_a_readable_error_label(hours):
    assert bookings._hours_label(hours) == "unknown"


def test_review_accepts_legacy_dictionary_layouts_without_skipping_capacity(database, monkeypatch):
    booking = pending_booking()
    booking["venues"]["layouts"] = {"Banquet": 100}
    database.responses[("venue_bookings", "select")] = [booking]
    database.responses[("venue_blocks", "insert")] = [{"block_id": "block"}]
    database.responses[("venue_bookings", "update")] = lambda query: [{**booking, **query.payload}]
    sender = Mock()
    monkeypatch.setattr(bookings, "notify", sender)
    result = bookings.review_venue_booking("token", "bk-1", "staff", VenueBookingReviewRequest(status="APPROVED"))
    assert result["status"] == "APPROVED"
    assert result["reviewed_by"] == "staff"
    assert len(database.calls_to("venue_blocks", "insert")) == 1
    assert sender.call_args.args[:2] == ("coord-1", "venue_booking_approved")

    booking["events"]["expected_attendance"] = 101
    with pytest.raises(AuthError, match="exceeds capacity") as caught:
        bookings.review_venue_booking("token", "bk-1", "staff", VenueBookingReviewRequest(status="APPROVED"))
    assert caught.value.status_code == 400
    assert len(database.calls_to("venue_blocks", "insert")) == 1


@pytest.mark.parametrize("result", [None, [], {}, {"status": "APPROVED"}])
def test_venue_cancellation_requires_verified_cancelled_result(database, monkeypatch, result):
    database.responses[("rpc:cancel_venue_booking", "rpc")] = result
    # This test uses the recording fake's RPC, rather than the fixture's occupancy stub.
    database.client.rpc = database._rpc
    sender = Mock()
    monkeypatch.setattr(bookings, "notify_role", sender)
    with pytest.raises(AuthError, match="Unable to cancel the venue booking") as caught:
        bookings.cancel_venue_booking("token", "booking", VenueBookingCancelRequest(reason="Changed session"))
    assert caught.value.status_code == 502
    sender.assert_not_called()


@pytest.mark.parametrize("start,end", [
    (datetime(2099, 1, 1, 9), datetime.fromisoformat("2099-01-01T10:00+08:00")),
    (datetime.fromisoformat("2099-01-01T09:00+08:00"), datetime(2099, 1, 1, 10)),
])
def test_operating_hours_refuse_ambiguous_naive_bounds(start, end):
    with pytest.raises(ValueError, match="explicit timezones"):
        availability.within_operating_hours(start, end, OperatingHours(open="08:00", close="22:00"))
