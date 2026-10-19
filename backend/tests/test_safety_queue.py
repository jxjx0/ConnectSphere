"""Unit tests for services/safety_review_service.py."""

from types import SimpleNamespace
import pytest
from postgrest import APIError as PostgrestAPIError

import config
from services import safety_review_service
from services.auth_service import AuthError


EVENT_ID = "55555555-5555-5555-5555-555555555555"

PLANNING_EVENT = {
    "id": EVENT_ID,
    "organiser_id": "11111111-1111-1111-1111-111111111111",
    "name": "Safety Summit",
    "status": "planning",
    "safety_status": "not_requested",
    "expected_attendance": 80,
    "accessibility_requirements": "Wheelchair access",
}

EVENT_AWAITING_ROW = {
    "id": EVENT_ID,
    "name": "Annual Tech Conference",
    "category": "conference",
    "start_time": "2026-10-21T05:08:00+00:00",
    "end_time": "2026-10-21T16:08:00+00:00",
    "status": "awaiting_safety_check",
    "updated_at": "2026-10-19T04:00:00+00:00",
}


class FakeQuery:
    def __init__(self, rows, calls, raise_error=False):
        self._rows = rows
        self._calls = calls
        self._raise_error = raise_error

    def select(self, *args):
        self._calls.append(("select", args))
        return self

    def update(self, values):
        self._calls.append(("update", values))
        return self

    def insert(self, values):
        self._calls.append(("insert", values))
        return self

    def in_(self, column, values):
        self._calls.append(("in", column, values))
        return self

    def eq(self, column, value):
        self._calls.append(("eq", column, value))
        filtered = []
        for row in self._rows:
            if column in row and str(row[column]) != str(value):
                continue
            filtered.append(row)
        self._rows = filtered
        return self

    def order(self, column, desc=False):
        self._calls.append(("order", column, desc))
        return self

    def execute(self):
        if self._raise_error:
            raise PostgrestAPIError({"message": "DB Error", "code": "PGRST100"})
        return SimpleNamespace(data=self._rows)


def mock_database_clients(monkeypatch, rows_by_table=None, raise_error=False):
    calls = []
    if rows_by_table is None:
        rows_by_table = {}

    def get_table(table_name):
        rows = list(rows_by_table.get(table_name, []))
        return FakeQuery(
            rows,
            calls,
            raise_error=raise_error,
        )

    fake_client = SimpleNamespace(
        from_=get_table,
        table=get_table,
    )

    monkeypatch.setattr(config, "get_admin_client", lambda: fake_client)
    monkeypatch.setattr(config, "get_user_client", lambda token: fake_client)
    monkeypatch.setattr(safety_review_service, "get_admin_client", lambda: fake_client)
    monkeypatch.setattr(safety_review_service, "get_user_client", lambda token: fake_client)
    monkeypatch.setattr(safety_review_service, "_get_client", lambda access_token=None: fake_client)
    return calls, fake_client


def call_named(calls, name):
    return next(call for call in calls if call[0] == name)


# ============================================================================
# 1. QUEUE & AUTOMATED TRANSITIONS
# ============================================================================

def test_get_safety_review_queue_success(monkeypatch):
    """get_safety_review_queue retrieves events in awaiting_safety_check status."""
    calls, _ = mock_database_clients(monkeypatch, {"events": [EVENT_AWAITING_ROW]})

    queue = safety_review_service.get_safety_review_queue("valid-token")

    assert len(queue) == 1
    assert queue[0]["id"] == EVENT_ID
    assert queue[0]["status"] == "awaiting_safety_check"
    assert ("eq", "status", "awaiting_safety_check") in calls


def test_get_safety_review_queue_postgrest_error(monkeypatch):
    """Postgrest API error during queue fetch raises 400 AuthError."""
    mock_database_clients(monkeypatch, {}, raise_error=True)

    with pytest.raises(AuthError) as exc_info:
        safety_review_service.get_safety_review_queue("valid-token")

    assert exc_info.value.status_code == 400


def test_get_safety_review_queue_generic_error(monkeypatch):
    """Generic unexpected error during queue fetch raises 500 AuthError."""
    def _raise_error(access_token=None):
        raise Exception("Client crash")

    monkeypatch.setattr(safety_review_service, "_get_client", _raise_error)

    with pytest.raises(AuthError) as exc_info:
        safety_review_service.get_safety_review_queue("valid-token")

    assert exc_info.value.status_code == 500


def test_check_and_update_safety_status_success(monkeypatch):
    """Event transitions to awaiting_safety_check when venue and equipment are approved."""
    calls, _ = mock_database_clients(monkeypatch, {
        "venue_bookings": [{"event_id": EVENT_ID, "status": "APPROVED"}],
        "equipment_requests": [{"event_id": EVENT_ID, "status": "APPROVED"}],
    })

    result = safety_review_service.check_and_update_safety_status(EVENT_ID)

    assert result is True
    update_call = call_named(calls, "update")[1]
    assert update_call == {"status": "awaiting_safety_check"}


def test_check_and_update_safety_status_no_equipment(monkeypatch):
    """Event transitions when venue is approved and no equipment requests exist."""
    calls, _ = mock_database_clients(monkeypatch, {
        "venue_bookings": [{"event_id": EVENT_ID, "status": "APPROVED"}],
        "equipment_requests": [],
    })

    result = safety_review_service.check_and_update_safety_status(EVENT_ID)

    assert result is True
    update_call = call_named(calls, "update")[1]
    assert update_call == {"status": "awaiting_safety_check"}


def test_check_and_update_safety_status_unapproved_venue(monkeypatch):
    """Event does not transition if venue booking is not approved."""
    mock_database_clients(monkeypatch, {
        "venue_bookings": [{"event_id": EVENT_ID, "status": "PENDING"}],
        "equipment_requests": [{"event_id": EVENT_ID, "status": "APPROVED"}],
    })

    result = safety_review_service.check_and_update_safety_status(EVENT_ID)

    assert result is False


def test_check_and_update_safety_status_unapproved_equipment(monkeypatch):
    """Event does not transition if any equipment request is pending."""
    mock_database_clients(monkeypatch, {
        "venue_bookings": [{"event_id": EVENT_ID, "status": "APPROVED"}],
        "equipment_requests": [{"event_id": EVENT_ID, "status": "PENDING"}],
    })

    result = safety_review_service.check_and_update_safety_status(EVENT_ID)

    assert result is False


# ============================================================================
# 2. EVENT DETAILS & SAFETY FLAGS
# ============================================================================

def test_get_safety_event_details_success(monkeypatch):
    """get_safety_event_details fetches event, venue, equipment items, and computes flags."""
    mock_database_clients(monkeypatch, {
        "events": [PLANNING_EVENT],
        "venue_bookings": [{
            "event_id": EVENT_ID,
            "status": "APPROVED",
            "venue": {"name": "Grand Hall", "capacity": 50, "accessibility": []}
        }],
        "equipment_requests": [{"id": "req-1", "event_id": EVENT_ID, "status": "Approved"}],
        "equipment_request_items": [{
            "request_id": "req-1",
            "quantity": 2,
            "equipment": {"name": "Mic", "type": "Audio", "maintenance_status": "Under Repair"}
        }],
    })

    details = safety_review_service.get_safety_event_details(EVENT_ID, "token")

    assert details["event"]["id"] == EVENT_ID
    assert len(details["equipment_items"]) == 1
    assert any(flag["type"] == "CAPACITY_EXCEEDED" for flag in details["safety_flags"])
    assert any(flag["type"] == "EQUIPMENT_HAZARD" for flag in details["safety_flags"])


def test_get_safety_event_details_not_found(monkeypatch):
    """Raises 404 AuthError when event is not found."""
    mock_database_clients(monkeypatch, {"events": []})

    with pytest.raises(AuthError) as exc_info:
        safety_review_service.get_safety_event_details(EVENT_ID, "token")

    assert exc_info.value.status_code == 404


def test_get_safety_event_details_postgrest_error(monkeypatch):
    """Postgrest API error during details fetch raises 400 AuthError."""
    mock_database_clients(monkeypatch, {}, raise_error=True)

    with pytest.raises(AuthError) as exc_info:
        safety_review_service.get_safety_event_details(EVENT_ID, "token")

    assert exc_info.value.status_code == 400


def test_get_safety_event_details_generic_error(monkeypatch):
    """Generic error during details fetch raises 500 AuthError."""
    def _raise_error(access_token=None):
        raise Exception("Network timeout")

    monkeypatch.setattr(safety_review_service, "_get_client", _raise_error)

    with pytest.raises(AuthError) as exc_info:
        safety_review_service.get_safety_event_details(EVENT_ID, "token")

    assert exc_info.value.status_code == 500


# ============================================================================
# 3. MANUAL SAFETY CHECK REQUESTS
# ============================================================================

def test_request_safety_check_success(monkeypatch):
    """Manually requesting a safety check updates safety_status to pending."""
    calls, _ = mock_database_clients(monkeypatch, {
        "events": [PLANNING_EVENT],
        "venue_bookings": [{"event_id": EVENT_ID, "status": "APPROVED"}],
        "equipment_requests": [{"event_id": EVENT_ID, "status": "Approved"}],
    })

    safety_review_service.request_safety_check(EVENT_ID, "token")

    update_call = call_named(calls, "update")[1]
    assert update_call == {"safety_status": "pending"}


def test_request_safety_check_not_found(monkeypatch):
    """Raises 404 AuthError when requesting safety check for non-existent event."""
    mock_database_clients(monkeypatch, {"events": []})

    with pytest.raises(AuthError) as exc_info:
        safety_review_service.request_safety_check(EVENT_ID, "token")

    assert exc_info.value.status_code == 404


def test_request_safety_check_unapproved_venue_conflict(monkeypatch):
    """Raises 409 AuthError when venue is not approved."""
    mock_database_clients(monkeypatch, {
        "events": [PLANNING_EVENT],
        "venue_bookings": [{"event_id": EVENT_ID, "status": "PENDING"}],
    })

    with pytest.raises(AuthError) as exc_info:
        safety_review_service.request_safety_check(EVENT_ID, "token")

    assert exc_info.value.status_code == 409


def test_request_safety_check_postgrest_error(monkeypatch):
    """Postgrest API error during safety check request raises 400 AuthError."""
    mock_database_clients(monkeypatch, {}, raise_error=True)

    with pytest.raises(AuthError) as exc_info:
        safety_review_service.request_safety_check(EVENT_ID, "token")

    assert exc_info.value.status_code == 400


# ============================================================================
# 4. HELPER CLIENT RESOLUTION
# ============================================================================

def test_get_client_admin_fallback(monkeypatch):
    """_get_client executes without raising errors."""
    admin_client = SimpleNamespace(type="admin")
    monkeypatch.setattr(safety_review_service, "get_admin_client", lambda: admin_client)

    assert safety_review_service._get_client(None) == admin_client


def test_get_client_user_token_execution(monkeypatch):
    """_get_client executes with user token without raising errors."""
    user_client = SimpleNamespace(type="user")
    monkeypatch.setattr(safety_review_service, "get_admin_client", lambda: user_client)

    assert safety_review_service._get_client("valid-token") is not None