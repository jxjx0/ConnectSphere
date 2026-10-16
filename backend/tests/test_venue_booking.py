import pytest
from datetime import datetime, timezone, timedelta
from unittest.mock import MagicMock
from postgrest import APIError as PostgrestAPIError

from services.auth_service import AuthError
import services.venue_booking_service

# ==========================================
# Automated Pytest Suite using MagicMock
# ==========================================

def test_check_schedule_conflict_detects_overlap(monkeypatch):
    """Test that check_schedule_conflict accurately identifies overlapping blocks."""
    now = datetime.now(timezone.utc)
    
    # 1. Create a chainable MagicMock client
    mock_client = MagicMock()
    mock_query = mock_client.table.return_value.select.return_value.eq.return_value.lt.return_value.gt.return_value
    mock_query.execute.return_value.data = [{"block_id": "blk_1"}]

    # 2. Invoke service call
    has_conflict = services.venue_booking_service.check_schedule_conflict(
        client=mock_client,
        venue_id="venue_123",
        effective_start=(now + timedelta(hours=1)).isoformat(),
        effective_end=(now + timedelta(hours=3)).isoformat()
    )

    # 3. Assertions
    assert has_conflict is True
    mock_client.table.assert_called_once_with("venue_blocks")


def test_review_venue_booking_locks_calendar_first(monkeypatch):
    """Verify approval creates venue_blocks before updating status to APPROVED."""
    now = datetime.now(timezone.utc)
    
    booking_record = {
        "booking_id": "b_100",
        "venue_id": "v_100",
        "room_layout": "Banquet",
        "status": "PENDING_VENUE_APPROVAL",
        "effective_start_at": now.isoformat(),
        "effective_end_at": (now + timedelta(hours=2)).isoformat(),
    }

    # Track execution sequence
    call_order = []

    mock_client = MagicMock()

    def mock_table(table_name):
        table_mock = MagicMock()
        
        if table_name == "venue_bookings":
            # Mock select returning pending booking record
            table_mock.select.return_value.eq.return_value.execute.return_value.data = [booking_record]
            
            # Record update call
            def record_update(*args, **kwargs):
                call_order.append("update_venue_bookings")
                update_mock = MagicMock()
                update_mock.eq.return_value.execute.return_value.data = [{**booking_record, "status": "APPROVED"}]
                return update_mock
            
            table_mock.update.side_effect = record_update

        elif table_name == "venue_blocks":
            # Mock conflict check returning empty list
            table_mock.select.return_value.eq.return_value.lt.return_value.gt.return_value.execute.return_value.data = []
            
            # Record insert call
            def record_insert(*args, **kwargs):
                call_order.append("insert_venue_blocks")
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

    # Asserts that insert_venue_blocks happens BEFORE update_venue_bookings
    assert call_order == ["insert_venue_blocks", "update_venue_bookings"]
    assert result["status"] == "APPROVED"

def test_create_venue_booking_success(monkeypatch):
    """Test successful booking submission."""
    now = datetime.now(timezone.utc)
    
    class Req:
        event_id = "evt_1"
        room_layout = "Banquet"
        start_at = now + timedelta(days=1)
        end_at = now + timedelta(days=1, hours=2)
        setup_buffer_minutes = 15
        teardown_buffer_minutes = 15

    mock_client = MagicMock()
    # Mock duplicate check -> empty list
    # Mock conflict check -> empty list
    # Mock insert -> returns created record
    mock_client.table.return_value.select.return_value.eq.return_value.eq.return_value.neq.return_value.neq.return_value.execute.return_value.data = []
    mock_client.table.return_value.select.return_value.eq.return_value.lt.return_value.gt.return_value.execute.return_value.data = []
    mock_client.table.return_value.insert.return_value.execute.return_value.data = [{"booking_id": "b_1"}]
    
    monkeypatch.setattr("config.get_user_client", lambda token: mock_client)

    result = services.venue_booking_service.create_venue_booking(
        access_token="token", venue_id="v_1", request=Req(), coordinator_id="coord_1"
    )
    assert result["booking_id"] == "b_1"


def test_create_venue_booking_duplicate_raises_conflict(monkeypatch):
    """Test rejection when active booking for event already exists."""
    mock_client = MagicMock()
    mock_client.table.return_value.select.return_value.eq.return_value.eq.return_value.neq.return_value.neq.return_value.execute.return_value.data = [{"booking_id": "b_old"}]
    monkeypatch.setattr("config.get_user_client", lambda token: mock_client)

    class Req:
        event_id = "evt_1"

    with pytest.raises(AuthError) as exc:
        services.venue_booking_service.create_venue_booking(
            access_token="token", venue_id="v_1", request=Req(), coordinator_id="coord_1"
        )
    assert exc.value.status_code == 409


# ---------------------------------------------------------------------------
# review_venue_booking Rejection & Error Tests
# ---------------------------------------------------------------------------

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
    """Line 28: Early exit when event_id is None/empty."""
    mock_client = MagicMock()
    services.venue_booking_service.check_duplicate_event_booking(mock_client, "v_1", "")
    mock_client.table.assert_not_called()


def test_create_venue_booking_postgrest_error_on_conflict_check(monkeypatch):
    """Lines 71-76: PostgrestAPIError raised during schedule conflict check."""
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
    """Lines 95-96: PostgrestAPIError raised during booking insert."""
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


def test_create_venue_booking_empty_insert_result(monkeypatch):
    """Line 99: result.data returns empty array on creation."""
    now = datetime.now(timezone.utc)
    mock_client = MagicMock()
    mock_client.table.return_value.select.return_value.eq.return_value.lt.return_value.gt.return_value.execute.return_value.data = []
    mock_client.table.return_value.insert.return_value.execute.return_value.data = []

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
    assert "Venue booking request was not created" in str(exc.value)


def test_review_venue_booking_approval_conflict_recheck_fails(monkeypatch):
    """Line 126: Approval re-check detects schedule conflict."""
    now = datetime.now(timezone.utc)
    booking_record = {
        "booking_id": "b_100",
        "venue_id": "v_100",
        "room_layout": "Banquet",
        "status": "PENDING_VENUE_APPROVAL",
        "effective_start_at": now.isoformat(),
        "effective_end_at": (now + timedelta(hours=2)).isoformat(),
    }

    mock_client = MagicMock()
    mock_client.table.return_value.select.return_value.eq.return_value.execute.return_value.data = [booking_record]
    monkeypatch.setattr("config.get_user_client", lambda token: mock_client)
    monkeypatch.setattr(services.venue_booking_service, "check_schedule_conflict", lambda *args: True)

    class ReviewReq:
        status = "APPROVED"
        rejection_reason = None

    with pytest.raises(AuthError) as exc:
        services.venue_booking_service.review_venue_booking("token", "b_100", "staff_1", ReviewReq())
    assert exc.value.status_code == 409
    assert "conflicting schedule block" in str(exc.value)


def test_review_venue_booking_empty_block_insert_data(monkeypatch):
    """Line 132: venue_blocks insert returns empty data."""
    now = datetime.now(timezone.utc)
    booking_record = {
        "booking_id": "b_100",
        "venue_id": "v_100",
        "room_layout": "Banquet",
        "status": "PENDING_VENUE_APPROVAL",
        "effective_start_at": now.isoformat(),
        "effective_end_at": (now + timedelta(hours=2)).isoformat(),
    }

    mock_client = MagicMock()
    # Fetch booking
    mock_client.table.return_value.select.return_value.eq.return_value.execute.return_value.data = [booking_record]
    # Check conflict -> False
    mock_client.table.return_value.select.return_value.eq.return_value.lt.return_value.gt.return_value.execute.return_value.data = []
    # Insert block -> returns empty data []
    mock_client.table.return_value.insert.return_value.execute.return_value.data = []

    monkeypatch.setattr("config.get_user_client", lambda token: mock_client)

    class ReviewReq:
        status = "APPROVED"
        rejection_reason = None

    with pytest.raises(AuthError) as exc:
        services.venue_booking_service.review_venue_booking("token", "b_100", "staff_1", ReviewReq())
    assert exc.value.status_code == 502
    assert "Failed to lock calendar operational block" in str(exc.value)


def test_review_venue_booking_postgrest_error_on_block_insert(monkeypatch):
    """Lines 146-148: PostgrestAPIError raised during venue_blocks insertion."""
    now = datetime.now(timezone.utc)
    booking_record = {
        "booking_id": "b_100",
        "venue_id": "v_100",
        "room_layout": "Banquet",
        "status": "PENDING_VENUE_APPROVAL",
        "effective_start_at": now.isoformat(),
        "effective_end_at": (now + timedelta(hours=2)).isoformat(),
    }

    mock_client = MagicMock()
    mock_client.table.return_value.select.return_value.eq.return_value.execute.return_value.data = [booking_record]
    mock_client.table.return_value.select.return_value.eq.return_value.lt.return_value.gt.return_value.execute.return_value.data = []
    mock_client.table.return_value.insert.return_value.execute.side_effect = PostgrestAPIError({"message": "Block DB Error"})

    monkeypatch.setattr("config.get_user_client", lambda token: mock_client)

    class ReviewReq:
        status = "APPROVED"
        rejection_reason = None

    with pytest.raises(AuthError) as exc:
        services.venue_booking_service.review_venue_booking("token", "b_100", "staff_1", ReviewReq())
    assert exc.value.status_code == 502
    assert "Unable to create calendar reservation block" in str(exc.value)

def test_create_venue_booking_schedule_conflict_raises_409(monkeypatch):
    """Line 71: Test 409 AuthError when create_venue_booking finds a schedule conflict."""
    now = datetime.now(timezone.utc)
    mock_client = MagicMock()
    
    # Mock no duplicate event
    mock_client.table.return_value.select.return_value.eq.return_value.eq.return_value.neq.return_value.neq.return_value.execute.return_value.data = []
    
    # Mock schedule conflict found -> returns non-empty block array
    monkeypatch.setattr(
        services.venue_booking_service,
        "check_schedule_conflict",
        lambda client, venue_id, start, end: True
    )
    
    monkeypatch.setattr("config.get_user_client", lambda token: mock_client)

    class Req:
        event_id = "evt_1"
        room_layout = "Banquet"
        start_at = now + timedelta(days=1)
        end_at = now + timedelta(days=1, hours=2)
        setup_buffer_minutes = 15
        teardown_buffer_minutes = 15

    with pytest.raises(AuthError) as exc:
        services.venue_booking_service.create_venue_booking(
            access_token="token", venue_id="v_1", request=Req(), coordinator_id="coord_1"
        )
    
    assert exc.value.status_code == 409
    assert "unavailable during the selected time slot" in str(exc.value)


def test_review_venue_booking_conflict_recheck_raises_409(monkeypatch):
    """Line 126: Test 409 AuthError when review_venue_booking detects a conflict during approval."""
    now = datetime.now(timezone.utc)
    booking_record = {
        "booking_id": "b_100",
        "venue_id": "v_100",
        "room_layout": "Banquet",
        "status": "PENDING_VENUE_APPROVAL",
        "effective_start_at": now.isoformat(),
        "effective_end_at": (now + timedelta(hours=2)).isoformat(),
    }

    mock_client = MagicMock()
    mock_client.table.return_value.select.return_value.eq.return_value.execute.return_value.data = [booking_record]
    monkeypatch.setattr("config.get_user_client", lambda token: mock_client)
    
    # Force check_schedule_conflict to return True on final approval
    monkeypatch.setattr(
        services.venue_booking_service,
        "check_schedule_conflict",
        lambda client, venue_id, start, end: True
    )

    class ReviewReq:
        status = "APPROVED"
        rejection_reason = None

    with pytest.raises(AuthError) as exc:
        services.venue_booking_service.review_venue_booking(
            access_token="token", booking_id="b_100", reviewer_id="staff_1", review=ReviewReq()
        )
    
    assert exc.value.status_code == 409
    assert "Cannot approve booking due to a conflicting schedule block" in str(exc.value)

def test_review_venue_booking_conflict_recheck_raises_409(monkeypatch):
    """Line 126: Test 409 AuthError when review_venue_booking detects a conflict during approval."""
    now = datetime.now(timezone.utc)
    booking_record = {
        "booking_id": "b_100",
        "venue_id": "v_100",
        "room_layout": "Banquet",
        "status": "PENDING_VENUE_APPROVAL",
        "effective_start_at": now.isoformat(),
        "effective_end_at": (now + timedelta(hours=2)).isoformat(),
    }

    mock_client = MagicMock()

    def mock_table(table_name):
        table_mock = MagicMock()
        if table_name == "venue_bookings":
            # Mock initial fetch of pending booking
            table_mock.select.return_value.eq.return_value.execute.return_value.data = [booking_record]
        elif table_name == "venue_blocks":
            # Mock conflict check finding an overlapping block
            table_mock.select.return_value.eq.return_value.lt.return_value.gt.return_value.execute.return_value.data = [{"block_id": "blk_conflict"}]
        return table_mock

    mock_client.table.side_effect = mock_table
    monkeypatch.setattr("config.get_user_client", lambda token: mock_client)

    class ReviewReq:
        status = "APPROVED"
        rejection_reason = None

    with pytest.raises(AuthError) as exc:
        services.venue_booking_service.review_venue_booking(
            access_token="fake_token",
            booking_id="b_100",
            reviewer_id="staff_1",
            review=ReviewReq()
        )

    assert exc.value.status_code == 409
    assert "Cannot approve booking due to a conflicting schedule block" in str(exc.value)