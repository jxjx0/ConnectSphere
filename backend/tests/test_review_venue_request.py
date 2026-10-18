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
        setup_buffer_minutes=30,
        teardown_buffer_minutes=30,
    )


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
    mock_client.table().select().eq().eq().neq().neq().execute().data = [{"booking_id": "b1"}]
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

    table_mock = MagicMock()
    mock_client.table.return_value = table_mock
    table_mock.select.return_value.eq.return_value.eq.return_value.neq.return_value.neq.return_value.execute.return_value.data = []
    table_mock.select.return_value.eq.return_value.lt.return_value.gt.return_value.execute.return_value.data = []
    table_mock.insert.return_value.execute.return_value.data = [inserted_booking]

    result = create_venue_booking("token", "venue-1", valid_create_request, "coord-1")

    assert result == inserted_booking
    table_mock.insert.assert_called_once_with({
        "venue_id": "venue-1",
        "coordinator_id": "coord-1",
        "event_id": "evt-123",
        "room_layout": "Banquet",
        "start_at": "2026-11-01T10:00:00+00:00",
        "end_at": "2026-11-01T12:00:00+00:00",
        "setup_buffer_minutes": 30,
        "teardown_buffer_minutes": 30,
        "effective_start_at": "2026-11-01T09:30:00+00:00",
        "effective_end_at": "2026-11-01T12:30:00+00:00",
        "status": "PENDING_VENUE_APPROVAL",
    })


@patch("config.get_user_client")
def test_create_venue_booking_schedule_conflict_raises_auth_error(mock_get_client, mock_client, valid_create_request):
    mock_get_client.return_value = mock_client

    table_mock = MagicMock()
    mock_client.table.return_value = table_mock
    table_mock.select.return_value.eq.return_value.eq.return_value.neq.return_value.neq.return_value.execute.return_value.data = []
    table_mock.select.return_value.eq.return_value.lt.return_value.gt.return_value.execute.return_value.data = [
        {"block_id": "blk-1", "block_reason": "Maintenance"}
    ]

    with pytest.raises(AuthError) as exc:
        create_venue_booking("token", "venue-1", valid_create_request, "coord-1")

    assert exc.value.status_code == 409


@patch("config.get_user_client")
def test_create_venue_booking_postgrest_error_on_conflict_check(mock_get_client, mock_client, valid_create_request):
    mock_get_client.return_value = mock_client
    mock_client.table().select().eq().eq().neq().neq().execute().data = []
    mock_client.table().select().eq().lt().gt().execute.side_effect = PostgrestAPIError({"message": "DB Error"})

    with pytest.raises(AuthError) as exc:
        create_venue_booking("token", "v-1", valid_create_request, "c-1")
    assert exc.value.status_code == 502


@patch("config.get_user_client")
def test_create_venue_booking_insert_postgrest_error(mock_get_client, mock_client, valid_create_request):
    mock_get_client.return_value = mock_client
    table_mock = MagicMock()
    mock_client.table.return_value = table_mock
    table_mock.select.return_value.eq.return_value.eq.return_value.neq.return_value.neq.return_value.execute.return_value.data = []
    table_mock.select.return_value.eq.return_value.lt.return_value.gt.return_value.execute.return_value.data = []
    table_mock.insert.return_value.execute.side_effect = PostgrestAPIError({"message": "Insert Error"})

    with pytest.raises(AuthError) as exc:
        create_venue_booking("token", "v-1", valid_create_request, "c-1")
    assert exc.value.status_code == 502


@patch("config.get_user_client")
def test_create_venue_booking_insert_empty_data(mock_get_client, mock_client, valid_create_request):
    mock_get_client.return_value = mock_client
    table_mock = MagicMock()
    mock_client.table.return_value = table_mock
    table_mock.select.return_value.eq.return_value.eq.return_value.neq.return_value.neq.return_value.execute.return_value.data = []
    table_mock.select.return_value.eq.return_value.lt.return_value.gt.return_value.execute.return_value.data = []
    table_mock.insert.return_value.execute.return_value.data = []

    with pytest.raises(AuthError) as exc:
        create_venue_booking("token", "v-1", valid_create_request, "c-1")
    assert exc.value.status_code == 502


# --- review_venue_booking ---

@patch("config.get_user_client")
def test_review_venue_booking_not_found(mock_get_client, mock_client):
    mock_get_client.return_value = mock_client
    mock_client.table().select().eq().execute().data = []

    review = VenueBookingReviewRequest(status="APPROVED")
    with pytest.raises(AuthError) as exc:
        review_venue_booking("token", "bk-404", "staff-1", review)
    assert exc.value.status_code == 404


@patch("config.get_user_client")
def test_review_venue_booking_already_processed(mock_get_client, mock_client):
    mock_get_client.return_value = mock_client
    mock_client.table().select().eq().execute().data = [{"status": "APPROVED"}]

    review = VenueBookingReviewRequest(status="APPROVED")
    with pytest.raises(AuthError) as exc:
        review_venue_booking("token", "bk-1", "staff-1", review)
    assert exc.value.status_code == 400


@patch("config.get_user_client")
def test_review_venue_booking_unsupported_layout(mock_get_client, mock_client):
    mock_get_client.return_value = mock_client
    booking = {
        "booking_id": "bk-1",
        "venue_id": "v-1",
        "status": "PENDING_VENUE_APPROVAL",
        "room_layout": "Theater",
        "venues": {"layouts": [{"name": "Banquet", "capacity": 100}]},
        "events": {"expected_attendance": 50},
    }
    mock_client.table().select().eq().execute().data = [booking]

    review = VenueBookingReviewRequest(status="APPROVED")
    with pytest.raises(AuthError) as exc:
        review_venue_booking("token", "bk-1", "staff-1", review)
    assert exc.value.status_code == 400


@patch("config.get_user_client")
def test_review_venue_booking_exceeds_capacity(mock_get_client, mock_client):
    mock_get_client.return_value = mock_client
    booking = {
        "booking_id": "bk-1",
        "venue_id": "v-1",
        "status": "PENDING_VENUE_APPROVAL",
        "room_layout": "Banquet",
        "venues": {"layouts": [{"name": "Banquet", "capacity": 100}]},
        "events": {"expected_attendance": 150},
    }
    mock_client.table().select().eq().execute().data = [booking]

    review = VenueBookingReviewRequest(status="APPROVED")
    with pytest.raises(AuthError) as exc:
        review_venue_booking("token", "bk-1", "staff-1", review)
    assert exc.value.status_code == 400


@patch("config.get_user_client")
def test_review_venue_booking_approval_conflict_exists(mock_get_client, mock_client):
    mock_get_client.return_value = mock_client
    booking = {
        "booking_id": "bk-1",
        "venue_id": "v-1",
        "status": "PENDING_VENUE_APPROVAL",
        "room_layout": "Banquet",
        "effective_start_at": "2026-11-01T09:30:00Z",
        "effective_end_at": "2026-11-01T12:30:00Z",
        "venues": {"layouts": [{"name": "Banquet", "capacity": 100}]},
        "events": {"expected_attendance": 50},
    }
    table_mock = MagicMock()
    mock_client.table.return_value = table_mock
    table_mock.select.return_value.eq.return_value.execute.return_value.data = [booking]
    table_mock.select.return_value.eq.return_value.lt.return_value.gt.return_value.execute.return_value.data = [
        {"block_reason": "Maintenance", "start_at": "2026-11-01T10:00:00Z", "end_at": "2026-11-01T11:00:00Z"}
    ]

    review = VenueBookingReviewRequest(status="APPROVED")
    with pytest.raises(AuthError) as exc:
        review_venue_booking("token", "bk-1", "staff-1", review)
    assert exc.value.status_code == 409


@patch("config.get_user_client")
def test_review_venue_booking_block_insert_failed(mock_get_client, mock_client):
    mock_get_client.return_value = mock_client
    booking = {
        "booking_id": "bk-1",
        "venue_id": "v-1",
        "status": "PENDING_VENUE_APPROVAL",
        "room_layout": "Banquet",
        "effective_start_at": "2026-11-01T09:30:00Z",
        "effective_end_at": "2026-11-01T12:30:00Z",
        "venues": {"layouts": [{"name": "Banquet", "capacity": 100}]},
        "events": {"expected_attendance": 50},
    }
    table_mock = MagicMock()
    mock_client.table.return_value = table_mock
    table_mock.select.return_value.eq.return_value.execute.return_value.data = [booking]
    table_mock.select.return_value.eq.return_value.lt.return_value.gt.return_value.execute.return_value.data = []
    table_mock.insert.return_value.execute.return_value.data = []

    review = VenueBookingReviewRequest(status="APPROVED")
    with pytest.raises(AuthError) as exc:
        review_venue_booking("token", "bk-1", "staff-1", review)
    assert exc.value.status_code == 502


@patch("config.get_user_client")
def test_review_venue_booking_block_insert_api_error(mock_get_client, mock_client):
    mock_get_client.return_value = mock_client
    booking = {
        "booking_id": "bk-1",
        "venue_id": "v-1",
        "status": "PENDING_VENUE_APPROVAL",
        "room_layout": "Banquet",
        "effective_start_at": "2026-11-01T09:30:00Z",
        "effective_end_at": "2026-11-01T12:30:00Z",
        "venues": {"layouts": [{"name": "Banquet", "capacity": 100}]},
        "events": {"expected_attendance": 50},
    }
    table_mock = MagicMock()
    mock_client.table.return_value = table_mock
    table_mock.select.return_value.eq.return_value.execute.return_value.data = [booking]
    table_mock.select.return_value.eq.return_value.lt.return_value.gt.return_value.execute.return_value.data = []
    table_mock.insert.return_value.execute.side_effect = PostgrestAPIError({"message": "Error"})

    review = VenueBookingReviewRequest(status="APPROVED")
    with pytest.raises(AuthError) as exc:
        review_venue_booking("token", "bk-1", "staff-1", review)
    assert exc.value.status_code == 502


@patch("config.get_user_client")
def test_review_venue_booking_approved_success_full(mock_get_client, mock_client):
    mock_get_client.return_value = mock_client
    booking = {
        "booking_id": "bk-1",
        "venue_id": "v-1",
        "coordinator_id": "c-1",
        "status": "PENDING_VENUE_APPROVAL",
        "room_layout": "Banquet",
        "effective_start_at": "2026-11-01T09:30:00Z",
        "effective_end_at": "2026-11-01T12:30:00Z",
        "venues": {"name": "Hall", "layouts": [{"name": "Banquet", "capacity": 100}]},
        "events": {"name": "Party", "expected_attendance": 50},
    }

    table_mock = MagicMock()
    mock_client.table.return_value = table_mock

    # 1st query: fetch venue booking
    table_mock.select.return_value.eq.return_value.execute.return_value.data = [booking]
    # 2nd query: check schedule conflicts
    table_mock.select.return_value.eq.return_value.lt.return_value.gt.return_value.execute.return_value.data = []
    # 3rd query: insert block
    table_mock.insert.return_value.execute.return_value.data = [{"block_id": "blk-1"}]
    # 4th query: update status
    approved_res = {**booking, "status": "APPROVED"}
    table_mock.update.return_value.eq.return_value.execute.return_value.data = [approved_res]

    review = VenueBookingReviewRequest(status="APPROVED")
    res = review_venue_booking("token", "bk-1", "staff-1", review)

    assert res["status"] == "APPROVED"


@patch("config.get_user_client")
def test_review_venue_booking_rejected_success(mock_get_client, mock_client):
    mock_get_client.return_value = mock_client
    booking = {
        "booking_id": "bk-1",
        "venue_id": "v-1",
        "coordinator_id": "c-1",
        "status": "PENDING_VENUE_APPROVAL",
        "venues": {"name": "Hall"},
    }

    table_mock = MagicMock()
    mock_client.table.return_value = table_mock
    table_mock.select.return_value.eq.return_value.execute.return_value.data = [booking]
    rejected_res = {**booking, "status": "REJECTED", "rejection_reason": "Not available"}
    table_mock.update.return_value.eq.return_value.execute.return_value.data = [rejected_res]

    review = VenueBookingReviewRequest(status="REJECTED", rejection_reason="Not available")
    res = review_venue_booking("token", "bk-1", "staff-1", review)

    assert res["status"] == "REJECTED"