"""Comprehensive unit tests targeting 100% coverage for services/safety_review_service.py."""

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
    "expected_attendance": 80,
    "accessibility_requirements": "Wheelchair access required",
}

APPROVED_VENUE_BOOKING = {
    "event_id": EVENT_ID,
    "status": "APPROVED",
    "venue": {
        "name": "Grand Hall",
        "capacity": 50,  # Lower than attendance (80) to trigger capacity flag
        "accessibility": ["Ramp Access"],
    },
}

APPROVED_EQUIPMENT_REQUEST = {
    "id": "req-1",
    "event_id": EVENT_ID,
    "status": "Approved",
}


class FakeQuery:
    def __init__(self, rows_by_table, table_name, raise_postgrest=False, raise_generic=False):
        self.rows_by_table = rows_by_table
        self.table_name = table_name
        self.raise_postgrest = raise_postgrest
        self.raise_generic = raise_generic

    def select(self, *args): return self
    def eq(self, *args): return self
    def in_(self, *args): return self
    def update(self, *args): return self
    def order(self, *args, **kwargs): return self

    def execute(self):
        if self.raise_postgrest:
            raise PostgrestAPIError({"message": "DB Error", "code": "PGRST100"})
        if self.raise_generic:
            raise RuntimeError("Unexpected DB failure")
        return SimpleNamespace(data=self.rows_by_table.get(self.table_name, []))


def mock_database_clients(monkeypatch, rows_by_table=None, raise_postgrest=False, raise_generic=False):
    if rows_by_table is None:
        rows_by_table = {}

    def get_table(table_name):
        return FakeQuery(rows_by_table, table_name, raise_postgrest, raise_generic)

    fake_client = SimpleNamespace(from_=get_table, table=get_table)

    monkeypatch.setattr(config, "get_admin_client", lambda: fake_client)
    monkeypatch.setattr(config, "get_user_client", lambda token: fake_client)
    monkeypatch.setattr(safety_review_service, "get_admin_client", lambda: fake_client)
    monkeypatch.setattr(safety_review_service, "get_user_client", lambda token: fake_client)
    return fake_client


# ============================================================================
# 1. CLIENT RESOLUTION (_get_client)
# ============================================================================

def test_get_client_admin_success(monkeypatch):
    """Admin client initialized successfully."""
    admin_client = SimpleNamespace(type="admin")
    monkeypatch.setattr(safety_review_service, "get_admin_client", lambda: admin_client)
    assert safety_review_service._get_client("token") == admin_client


def test_get_client_fallback_to_user_client(monkeypatch):
    """Fallback to user client when get_admin_client fails."""
    user_client = SimpleNamespace(type="user")

    def raise_err():
        raise RuntimeError("Admin unavailable")

    monkeypatch.setattr(safety_review_service, "get_admin_client", raise_err)
    monkeypatch.setattr(safety_review_service, "get_user_client", lambda token: user_client)

    assert safety_review_service._get_client("valid-token") == user_client


def test_get_client_fallback_raises_autherror(monkeypatch):
    """Raises AuthError 500 when admin client fails and no access token is provided."""
    def raise_err():
        raise RuntimeError("Admin unavailable")

    monkeypatch.setattr(safety_review_service, "get_admin_client", raise_err)

    with pytest.raises(AuthError) as exc_info:
        safety_review_service._get_client(None)

    assert exc_info.value.status_code == 500


# ============================================================================
# 2. GET SAFETY REVIEW QUEUE
# ============================================================================

def test_get_safety_review_queue_success(monkeypatch):
    mock_database_clients(monkeypatch, {"events": [PLANNING_EVENT]})
    queue = safety_review_service.get_safety_review_queue("token")
    assert len(queue) == 1


def test_get_safety_review_queue_postgrest_error(monkeypatch):
    mock_database_clients(monkeypatch, raise_postgrest=True)
    with pytest.raises(AuthError) as exc:
        safety_review_service.get_safety_review_queue("token")
    assert exc.value.status_code == 400


def test_get_safety_review_queue_generic_error(monkeypatch):
    mock_database_clients(monkeypatch, raise_generic=True)
    with pytest.raises(AuthError) as exc:
        safety_review_service.get_safety_review_queue("token")
    assert exc.value.status_code == 500


# ============================================================================
# 3. GET SAFETY EVENT DETAILS
# ============================================================================

def test_get_safety_event_details_all_flags_triggered(monkeypatch):
    """Triggers capacity, equipment hazard, accessibility gap, and large crowd protocol flags."""
    large_crowd_event = {
        **PLANNING_EVENT,
        "expected_attendance": 600,
        "accessibility_requirements": "Wheelchair access needed",
    }

    mock_database_clients(
        monkeypatch,
        {
            "events": [large_crowd_event],
            "venue_bookings": [APPROVED_VENUE_BOOKING],
            "equipment_requests": [APPROVED_EQUIPMENT_REQUEST],
            "equipment_request_items": [
                {
                    "request_id": "req-1",
                    "quantity": 2,
                    "equipment": {
                        "name": "Generator",
                        "type": "Power",
                        "maintenance_status": "Under Repair",
                    },
                }
            ],
        },
    )

    details = safety_review_service.get_safety_event_details(EVENT_ID, "token")
    flag_types = [f["type"] for f in details["safety_flags"]]

    assert "CAPACITY_EXCEEDED" in flag_types
    assert "EQUIPMENT_HAZARD" in flag_types
    assert "ACCESSIBILITY_GAP" in flag_types
    assert "LARGE_CROWD_PROTOCOL" in flag_types


def test_get_safety_event_details_inner_exceptions_logged(monkeypatch):
    """Triggers exception handlers in venue booking and equipment loading steps."""
    def get_table(table_name):
        if table_name in ("venue_bookings", "equipment_requests"):
            return FakeQuery({}, table_name, raise_generic=True)
        return FakeQuery({"events": [PLANNING_EVENT]}, table_name)

    fake_client = SimpleNamespace(from_=get_table, table=get_table)
    monkeypatch.setattr(safety_review_service, "get_admin_client", lambda: fake_client)

    details = safety_review_service.get_safety_event_details(EVENT_ID, "token")
    assert details["event"]["id"] == EVENT_ID
    assert details["venue_booking"] == {}
    assert details["equipment_items"] == []


def test_get_safety_event_details_not_found(monkeypatch):
    mock_database_clients(monkeypatch, {"events": []})
    with pytest.raises(AuthError) as exc:
        safety_review_service.get_safety_event_details(EVENT_ID, "token")
    assert exc.value.status_code == 404


def test_get_safety_event_details_postgrest_error(monkeypatch):
    mock_database_clients(monkeypatch, raise_postgrest=True)
    with pytest.raises(AuthError) as exc:
        safety_review_service.get_safety_event_details(EVENT_ID, "token")
    assert exc.value.status_code == 400


def test_get_safety_event_details_generic_error(monkeypatch):
    mock_database_clients(monkeypatch, raise_generic=True)
    with pytest.raises(AuthError) as exc:
        safety_review_service.get_safety_event_details(EVENT_ID, "token")
    assert exc.value.status_code == 500


# ============================================================================
# 4. REQUEST SAFETY CHECK
# ============================================================================

def test_request_safety_check_success(monkeypatch):
    mock_database_clients(
        monkeypatch,
        {
            "events": [PLANNING_EVENT],
            "venue_bookings": [APPROVED_VENUE_BOOKING],
            "equipment_requests": [APPROVED_EQUIPMENT_REQUEST],
        },
    )
    res = safety_review_service.request_safety_check(EVENT_ID, "token")
    assert res["message"] == "Safety review requested successfully"


def test_request_safety_check_already_requested(monkeypatch):
    already_pending_event = {**PLANNING_EVENT, "status": "awaiting_safety_check"}
    mock_database_clients(monkeypatch, {"events": [already_pending_event]})

    with pytest.raises(AuthError) as exc:
        safety_review_service.request_safety_check(EVENT_ID, "token")
    assert exc.value.status_code == 409


def test_request_safety_check_with_blockers(monkeypatch):
    """Triggers _safety_check_blockers for non-planning status and pending equipment."""
    non_planning_event = {**PLANNING_EVENT, "status": "under_review"}
    mock_database_clients(
        monkeypatch,
        {
            "events": [non_planning_event],
            "venue_bookings": [{"event_id": EVENT_ID, "status": "PENDING"}],
            "equipment_requests": [{"event_id": EVENT_ID, "status": "Pending Technical Approval"}],
        },
    )

    with pytest.raises(AuthError) as exc:
        safety_review_service.request_safety_check(EVENT_ID, "token")
    assert exc.value.status_code == 409


def test_request_safety_check_not_found(monkeypatch):
    mock_database_clients(monkeypatch, {"events": []})
    with pytest.raises(AuthError) as exc:
        safety_review_service.request_safety_check(EVENT_ID, "token")
    assert exc.value.status_code == 404


def test_request_safety_check_postgrest_error(monkeypatch):
    mock_database_clients(monkeypatch, raise_postgrest=True)
    with pytest.raises(AuthError) as exc:
        safety_review_service.request_safety_check(EVENT_ID, "token")
    assert exc.value.status_code == 400


def test_request_safety_check_generic_error(monkeypatch):
    """Triggers line 216 (except Exception) during DB update in request_safety_check."""
    fake_client = mock_database_clients(
        monkeypatch,
        {
            "events": [PLANNING_EVENT],
            "venue_bookings": [APPROVED_VENUE_BOOKING],
            "equipment_requests": [APPROVED_EQUIPMENT_REQUEST],
        },
    )

    def exploding_table(name):
        query = FakeQuery(
            {
                "events": [PLANNING_EVENT],
                "venue_bookings": [APPROVED_VENUE_BOOKING],
                "equipment_requests": [APPROVED_EQUIPMENT_REQUEST],
            },
            name,
        )
        original_update = query.update

        def bad_update(*args, **kwargs):
            q = original_update(*args, **kwargs)
            q.raise_generic = True
            return q

        query.update = bad_update
        return query

    fake_client.table = exploding_table
    fake_client.from_ = exploding_table

    with pytest.raises(AuthError) as exc:
        safety_review_service.request_safety_check(EVENT_ID, "token")
    assert exc.value.status_code == 500
    assert "Internal error requesting safety check" in exc.value.message


# ============================================================================
# 5. CHECK AND UPDATE SAFETY STATUS
# ============================================================================

def test_check_and_update_safety_status_success(monkeypatch):
    mock_database_clients(
        monkeypatch,
        {
            "venue_bookings": [{"event_id": EVENT_ID, "status": "APPROVED"}],
            "equipment_requests": [{"event_id": EVENT_ID, "status": "APPROVED"}],
        },
    )
    assert safety_review_service.check_and_update_safety_status(EVENT_ID) is True


def test_check_and_update_safety_status_unapproved_venue(monkeypatch):
    mock_database_clients(
        monkeypatch,
        {
            "venue_bookings": [],
            "equipment_requests": [],
        },
    )
    assert safety_review_service.check_and_update_safety_status(EVENT_ID) is False


def test_check_and_update_safety_status_unapproved_equipment(monkeypatch):
    mock_database_clients(
        monkeypatch,
        {
            "venue_bookings": [{"event_id": EVENT_ID, "status": "APPROVED"}],
            "equipment_requests": [{"event_id": EVENT_ID, "status": "PENDING"}],
        },
    )
    assert safety_review_service.check_and_update_safety_status(EVENT_ID) is False


def test_check_and_update_safety_status_admin_init_failure(monkeypatch):
    """Covers get_admin_client failure during check_and_update_safety_status."""
    def raise_err():
        raise RuntimeError("DB connection failed")

    monkeypatch.setattr(safety_review_service, "get_admin_client", raise_err)
    assert safety_review_service.check_and_update_safety_status(EVENT_ID) is False