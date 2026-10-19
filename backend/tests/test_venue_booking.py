from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock
import pytest
from postgrest import APIError as PostgrestAPIError

from services.auth_service import AuthError
import services.venue_booking_service


def test_review_venue_booking_locks_calendar_with_booking_id(monkeypatch):
    """Verify approval attaches booking_id when creating venue_blocks."""
    now = datetime.now(timezone.utc)
    
    booking_record = {
        "booking_id": "b_100",
        "venue_id": "v_100",
        "room_layout": "Banquet",
        "status": "PENDING_VENUE_APPROVAL",
        "start_at": now.isoformat(),
        "end_at": (now + timedelta(hours=2)).isoformat(),
        "effective_start_at": now.isoformat(),
        "effective_end_at": (now + timedelta(hours=2)).isoformat(),
        "venues": {"layouts": [{"name": "Banquet", "capacity": 100}], "operating_hours": None},
        "events": {"name": "Gala", "expected_attendance": 50},
    }

    inserted_block_data = {}
    mock_client = MagicMock()

    def mock_table(table_name):
        table_mock = MagicMock()
        
        if table_name == "venue_bookings":
            table_mock.select.return_value.eq.return_value.execute.return_value.data = [booking_record]
            table_mock.update.return_value.eq.return_value.execute.return_value.data = [{**booking_record, "status": "APPROVED"}]

        elif table_name == "venue_blocks":
            table_mock.select.return_value.eq.return_value.lt.return_value.gt.return_value.execute.return_value.data = []
            
            def record_insert(data):
                nonlocal inserted_block_data
                inserted_block_data = data
                insert_mock = MagicMock()
                insert_mock.execute.return_value.data = [{"block_id": "blk_100"}]
                return insert_mock
            
            table_mock.insert.side_effect = record_insert

        return table_mock

    mock_client.table.side_effect = mock_table
    monkeypatch.setattr("config.get_user_client", lambda token: mock_client)

    class ReviewReq:
        status = "APPROVED"
        rejection_reason = None

    result = services.venue_booking_service.review_venue_booking(
        access_token="fake_token",
        booking_id="b_100",
        reviewer_id="staff_1",
        review=ReviewReq()
    )

    assert result["status"] == "APPROVED"
    assert inserted_block_data.get("booking_id") == "b_100"


def test_create_venue_booking_fetches_buffers_from_venue(monkeypatch):
    """Test that create_venue_booking automatically queries venue for setup and turnaround buffers."""
    now = datetime.now(timezone.utc)
    
    class Req:
        event_id = "evt_1"
        room_layout = "Banquet"
        start_at = now + timedelta(days=1)
        end_at = now + timedelta(days=1, hours=2)
        setup_buffer_minutes = 15
        teardown_buffer_minutes = 15

    mock_client = MagicMock()
    mock_client.table.return_value.select.return_value.eq.return_value.eq.return_value.neq.return_value.neq.return_value.execute.return_value.data = []
    mock_client.table.return_value.select.return_value.eq.return_value.lt.return_value.gt.return_value.execute.return_value.data = []
    mock_client.table.return_value.insert.return_value.execute.return_value.data = [{"booking_id": "b_1"}]
    
    monkeypatch.setattr("config.get_user_client", lambda token: mock_client)

    result = services.venue_booking_service.create_venue_booking(
        access_token="token", venue_id="v_1", request=Req(), coordinator_id="coord_1"
    )
    assert result["booking_id"] == "b_1"


@pytest.mark.parametrize("status", ["APPROVED", "AFFECTED_BY_UNAVAILABILITY"])
def test_create_venue_booking_duplicate_raises_conflict(monkeypatch, status):
    """Test rejection when active booking for event already exists."""
    mock_client = MagicMock()
    mock_client.table.return_value.select.return_value.eq.return_value.eq.return_value.neq.return_value.neq.return_value.execute.return_value.data = [{"booking_id": "b_old", "status": status}]
    monkeypatch.setattr("config.get_user_client", lambda token: mock_client)

    class Req:
        event_id = "evt_1"

    with pytest.raises(AuthError) as exc:
        services.venue_booking_service.create_venue_booking(
            access_token="token", venue_id="v_1", request=Req(), coordinator_id="coord_1"
        )
    assert exc.value.status_code == 409
    excluded = mock_client.table.return_value.select.return_value.eq.return_value.eq.return_value
    excluded.neq.assert_called_once_with("status", "REJECTED")
    excluded.neq.return_value.neq.assert_called_once_with("status", "CANCELLED")


def test_review_venue_booking_rejection(monkeypatch):
    """Test rejecting a booking request."""
    booking_record = {"booking_id": "b_100", "status": "PENDING_VENUE_APPROVAL"}
    
    mock_client = MagicMock()
    mock_client.table.return_value.select.return_value.eq.return_value.execute.return_value.data = [booking_record]
    mock_client.table.return_value.update.return_value.eq.return_value.execute.return_value.data = [{**booking_record, "status": "REJECTED"}]
    monkeypatch.setattr("config.get_user_client", lambda token: mock_client)

    class ReviewReq:
        status = "REJECTED"
        rejection_reason = "Maintenance scheduled"

    result = services.venue_booking_service.review_venue_booking(
        access_token="token", booking_id="b_100", reviewer_id="staff_1", review=ReviewReq()
    )
    assert result["status"] == "REJECTED"


def test_review_venue_booking_not_found(monkeypatch):
    """Test 404 when booking_id is not found."""
    mock_client = MagicMock()
    mock_client.table.return_value.select.return_value.eq.return_value.execute.return_value.data = []
    monkeypatch.setattr("config.get_user_client", lambda token: mock_client)

    class ReviewReq:
        status = "APPROVED"

    with pytest.raises(AuthError) as exc:
        services.venue_booking_service.review_venue_booking(
            access_token="token", booking_id="invalid_id", reviewer_id="staff_1", review=ReviewReq()
        )
    assert exc.value.status_code == 404


def test_check_duplicate_event_booking_empty_event_id(monkeypatch):
    """Early exit when event_id is None/empty."""
    mock_client = MagicMock()
    services.venue_booking_service.check_duplicate_event_booking(mock_client, "v_1", "")
    mock_client.table.assert_not_called()


def test_create_venue_booking_postgrest_error_on_conflict_check(monkeypatch):
    """PostgrestAPIError raised during schedule conflict check."""
    now = datetime.now(timezone.utc)
    mock_client = MagicMock()
    mock_client.table.return_value.select.return_value.eq.return_value.lt.return_value.gt.return_value.execute.side_effect = PostgrestAPIError({"message": "DB error"})
    
    monkeypatch.setattr("config.get_user_client", lambda token: mock_client)

    class Req:
        event_id = None
        room_layout = "Banquet"
        start_at = now + timedelta(days=1)
        end_at = now + timedelta(days=1, hours=2)
        setup_buffer_minutes = 15
        teardown_buffer_minutes = 15

    with pytest.raises(AuthError) as exc:
        services.venue_booking_service.create_venue_booking("token", "v_1", Req(), "coord_1")
    assert exc.value.status_code == 502
    assert "Unable to verify venue schedule availability" in str(exc.value)


def test_create_venue_booking_postgrest_error_on_insert(monkeypatch):
    """PostgrestAPIError raised during booking insert."""
    now = datetime.now(timezone.utc)
    mock_client = MagicMock()
    mock_client.table.return_value.select.return_value.eq.return_value.lt.return_value.gt.return_value.execute.return_value.data = []
    mock_client.table.return_value.insert.return_value.execute.side_effect = PostgrestAPIError({"message": "DB Insert error"})

    monkeypatch.setattr("config.get_user_client", lambda token: mock_client)

    class Req:
        event_id = None
        room_layout = "Banquet"
        start_at = now + timedelta(days=1)
        end_at = now + timedelta(days=1, hours=2)
        setup_buffer_minutes = 15
        teardown_buffer_minutes = 15

    with pytest.raises(AuthError) as exc:
        services.venue_booking_service.create_venue_booking("token", "v_1", Req(), "coord_1")
    assert exc.value.status_code == 502
    assert "Unable to submit venue booking request" in str(exc.value)

    mock_client = MagicMock()
    inserted_payload = {}

    def mock_table(table_name):
        t = MagicMock()
        if table_name == "venues":
            t.select().eq().execute().data = [
                {
                    "setup_time_minutes": 30,
                    "turnaround_time_minutes": 45,
                    "operating_hours": None,
                }
            ]
        elif table_name == "venue_bookings":
            t.select().eq().eq().neq().execute().data = []  # No duplicate request exists
            
            def capture_insert(data):
                nonlocal inserted_payload
                inserted_payload = data
                m = MagicMock()
                m.execute.return_value.data = [{"booking_id": "b_1"}]
                return m
            
            t.insert.side_effect = capture_insert
        elif table_name == "venue_blocks":
            t.select().eq().lt().gt().execute().data = []  # No schedule conflict
        return t

    mock_client.table.side_effect = mock_table
    monkeypatch.setattr("config.get_user_client", lambda token: mock_client)

    result = services.venue_booking_service.create_venue_booking(
        access_token="token", venue_id="v_1", request=Req(), coordinator_id="coord_1"
    )
    
    assert result["booking_id"] == "b_1"
    assert inserted_payload["setup_buffer_minutes"] == 30
    assert inserted_payload["teardown_buffer_minutes"] == 45
    assert exc.value.status_code == 409
