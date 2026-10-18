from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest
from postgrest import APIError as PostgrestAPIError

from models.venue_booking import VenueBookingCreateRequest, VenueBookingReviewRequest
from services.auth_service import AuthError
from services.venue_booking_service import (
    check_duplicate_event_booking,
    check_schedule_conflict_details,
    create_venue_booking,
    get_pending_venue_bookings,
    is_within_operating_hours,
    review_venue_booking,
)


@pytest.fixture
def mock_client():
    client = MagicMock()
    return client


@pytest.fixture
def valid_create_request():
    return VenueBookingCreateRequest(
        event_id="evt-123",
        room_layout="Banquet",
        start_at=datetime(2026, 11, 1, 10, 0, tzinfo=timezone.utc),
        end_at=datetime(2026, 11, 1, 12, 0, tzinfo=timezone.utc),
    )


# --- is_within_operating_hours ---

def test_is_within_operating_hours_valid():
    start = datetime(2026, 11, 1, 10, 0, tzinfo=timezone.utc)
    end = datetime(2026, 11, 1, 12, 0, tzinfo=timezone.utc)
    operating_hours = {"open": "08:00", "close": "22:00"}
    assert is_within_operating_hours(start, end, operating_hours) is True


def test_is_within_operating_hours_out_of_bounds():
    start = datetime(2026, 11, 1, 1, 0)
    end = datetime(2026, 11, 1, 3, 0)
    op_hours = {"open": "08:00", "close": "22:00"}
    assert is_within_operating_hours(start, end, op_hours) is False


# --- get_pending_venue_bookings ---

@patch("config.get_user_client")
def test_get_pending_venue_bookings_all(mock_get_client, mock_client):
    mock_get_client.return_value = mock_client
    mock_client.table().select().eq().order().execute().data = [{"booking_id": "b1"}]

    res = get_pending_venue_bookings("token")
    assert res == [{"booking_id": "b1"}]


@patch("config.get_user_client")
def test_get_pending_venue_bookings_filtered(mock_get_client, mock_client):
    mock_get_client.return_value = mock_client
    mock_client.table().select().eq().eq().order().execute().data = [{"booking_id": "b2"}]

    res = get_pending_venue_bookings("token", venue_id="v-1")
    assert res == [{"booking_id": "b2"}]


# --- check_duplicate_event_booking ---

def test_check_duplicate_event_booking_no_event_id(mock_client):
    check_duplicate_event_booking(mock_client, "v-1", None)
    mock_client.table.assert_not_called()


def test_check_duplicate_event_booking_duplicate_exists(mock_client):
    mock_client.table().select().eq().eq().neq().execute().data = [{"booking_id": "b1", "status": "PENDING_VENUE_APPROVAL"}]
    with pytest.raises(AuthError) as exc:
        check_duplicate_event_booking(mock_client, "v-1", "evt-1")
    assert exc.value.status_code == 409


# --- check_schedule_conflict_details ---

def test_check_schedule_conflict_details(mock_client):
    mock_data = [{"block_id": "blk-1"}]
    mock_client.table().select().eq().lt().gt().execute().data = mock_data
    res = check_schedule_conflict_details(mock_client, "v-1", "2026-11-01T09:30:00Z", "2026-11-01T12:30:00Z")
    assert res == mock_data


# --- create_venue_booking ---

@patch("config.get_user_client")
def test_create_venue_booking_success(mock_get_client, mock_client, valid_create_request):
    mock_get_client.return_value = mock_client
    inserted_booking = {"booking_id": "bk-100", "status": "PENDING_VENUE_APPROVAL"}

    def mock_table(table_name):
        t = MagicMock()
        if table_name == "venues":
            t.select().eq().execute().data = [
                {"setup_time_minutes": 30, "turnaround_time_minutes": 30, "operating_hours": {"open": "08:00", "close": "22:00"}}
            ]
        elif table_name == "venue_bookings":
            t.select().eq().eq().neq().execute().data = []
            t.insert().execute().data = [inserted_booking]
        elif table_name == "venue_blocks":
            t.select().eq().lt().gt().execute().data = []
        return t

    mock_client.table.side_effect = mock_table

    result = create_venue_booking("token", "venue-1", valid_create_request, "coord-1")
    assert result == inserted_booking


@patch("config.get_user_client")
def test_create_venue_booking_outside_operating_hours(mock_get_client, mock_client):
    mock_get_client.return_value = mock_client

    def mock_table(table_name):
        t = MagicMock()
        if table_name == "venues":
            t.select().eq().execute().data = [
                {"setup_time_minutes": 0, "turnaround_time_minutes": 0, "operating_hours": {"open": "08:00", "close": "22:00"}}
            ]
        return t

    mock_client.table.side_effect = mock_table

    late_request = VenueBookingCreateRequest(
        event_id="evt-123",
        room_layout="Banquet",
        start_at=datetime(2026, 11, 1, 23, 0, tzinfo=timezone.utc),
        end_at=datetime(2026, 11, 2, 1, 0, tzinfo=timezone.utc),
    )

    with pytest.raises(AuthError) as exc:
        create_venue_booking("token", "venue-1", late_request, "coord-1")

    assert exc.value.status_code == 400


# --- review_venue_booking ---

@patch("config.get_user_client")
def test_review_venue_booking_approved_success_full(mock_get_client, mock_client):
    mock_get_client.return_value = mock_client
    booking = {
        "booking_id": "bk-1",
        "venue_id": "v-1",
        "coordinator_id": "c-1",
        "status": "PENDING_VENUE_APPROVAL",
        "room_layout": "Banquet",
        "start_at": "2026-11-01T10:00:00Z",
        "end_at": "2026-11-01T12:00:00Z",
        "effective_start_at": "2026-11-01T09:30:00Z",
        "effective_end_at": "2026-11-01T12:30:00Z",
        "venues": {"name": "Hall", "layouts": [{"name": "Banquet", "capacity": 100}], "operating_hours": {"open": "08:00", "close": "22:00"}},
        "events": {"name": "Party", "expected_attendance": 50},
    }

    def mock_table(table_name):
        t = MagicMock()
        if table_name == "venue_bookings":
            t.select().eq().execute().data = [booking]
            t.update().eq().execute().data = [{**booking, "status": "APPROVED"}]
        elif table_name == "venue_blocks":
            t.select().eq().lt().gt().execute().data = []
            t.insert().execute().data = [{"block_id": "blk-1"}]
        return t

    mock_client.table.side_effect = mock_table

    review = VenueBookingReviewRequest(status="APPROVED")
    res = review_venue_booking("token", "bk-1", "staff-1", review)

    assert res["status"] == "APPROVED"