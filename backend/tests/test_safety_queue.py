"""Comprehensive unit tests targeting 100% coverage for services/safety_review_service.py."""

from types import SimpleNamespace
from datetime import datetime, timezone
from unittest.mock import Mock

from fake_supabase import FakeDatabase
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

    fake_client = SimpleNamespace(
        from_=get_table,
        table=get_table,
        rpc=lambda name, params: SimpleNamespace(execute=lambda: SimpleNamespace(data=False)),
    )

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
    waiting = {**PLANNING_EVENT, "status": "awaiting_safety_check", "updated_at": "2026-10-31T08:00:00Z"}
    database = FakeDatabase({("events", "select"): [waiting]})
    monkeypatch.setattr(safety_review_service, "_get_client", lambda token: database.client)
    queue = safety_review_service.get_safety_review_queue("token")
    assert len(queue) == 1
    assert queue == [waiting]
    assert database.calls[0].filters == [("eq", "status", "awaiting_safety_check"), ("order", "updated_at")]
    assert ("order", {"desc": False}) in database.calls[0].filter_kwargs


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
            "equipment_bookings": [
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


def test_get_safety_event_details_inner_exceptions_logged(monkeypatch, caplog):
    """Triggers exception handlers in venue booking and equipment loading steps."""
    def get_table(table_name):
        if table_name in ("venue_bookings", "equipment_requests"):
            return FakeQuery({}, table_name, raise_generic=True)
        return FakeQuery({"events": [PLANNING_EVENT]}, table_name)

    fake_client = SimpleNamespace(from_=get_table, table=get_table)
    monkeypatch.setattr(safety_review_service, "get_admin_client", lambda: fake_client)

    details = safety_review_service.get_safety_event_details(EVENT_ID, "token")
    assert details["event"]["id"] == EVENT_ID
    assert details["venue_bookings"] == []
    assert details["equipment_items"] == []
    assert f"Could not load venue bookings for event {EVENT_ID}" in caplog.text
    assert f"Could not load equipment items for event {EVENT_ID}" in caplog.text
    assert "Unexpected DB failure" in caplog.text


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
    database = FakeDatabase({
        ("events", "select"): [PLANNING_EVENT],
        ("venue_bookings", "select"): [APPROVED_VENUE_BOOKING],
        ("equipment_requests", "select"): [APPROVED_EQUIPMENT_REQUEST],
        ("rpc:event_has_open_requests", "rpc"): False,
        ("events", "update"): [{**PLANNING_EVENT, "status": "awaiting_safety_check"}],
    })
    resolve = Mock(return_value=database.client)
    monkeypatch.setattr(safety_review_service, "_get_client", resolve)
    before = datetime.now(timezone.utc)
    res = safety_review_service.request_safety_check(EVENT_ID, "token")
    assert res["message"] == "Safety review requested successfully"
    assert res["data"] == [{**PLANNING_EVENT, "status": "awaiting_safety_check"}]
    resolve.assert_called_once_with("token")
    saved = database.calls_to("events", "update")
    assert len(saved) == 1
    assert saved[0].filters == [("eq", "id", EVENT_ID)]
    assert saved[0].payload["status"] == "awaiting_safety_check"
    stamp = datetime.fromisoformat(saved[0].payload["updated_at"])
    assert before <= stamp <= datetime.now(timezone.utc)
    assert stamp.utcoffset().total_seconds() == 0


def test_request_safety_check_already_requested(monkeypatch):
    already_pending_event = {**PLANNING_EVENT, "status": "awaiting_safety_check"}
    mock_database_clients(monkeypatch, {"events": [already_pending_event]})

    with pytest.raises(AuthError) as exc:
        safety_review_service.request_safety_check(EVENT_ID, "token")
    assert exc.value.status_code == 409


@pytest.mark.parametrize("event_status,venue_status,equipment_status,expected", [
    ("under_review", "APPROVED", "Approved", "the event must be in Planning"),
    ("planning", "PENDING_VENUE_APPROVAL", "Approved", "it needs an approved venue booking"),
    ("planning", "APPROVED", "Pending Technical Approval", "pending equipment requests must be reviewed first"),
])
def test_request_safety_check_with_blockers(monkeypatch, event_status, venue_status, equipment_status, expected):
    database = FakeDatabase({
        ("events", "select"): [{**PLANNING_EVENT, "status": event_status}],
        ("venue_bookings", "select"): [{**APPROVED_VENUE_BOOKING, "status": venue_status}],
        ("equipment_requests", "select"): [{**APPROVED_EQUIPMENT_REQUEST, "status": equipment_status}],
        ("rpc:event_has_open_requests", "rpc"): False,
    })
    monkeypatch.setattr(safety_review_service, "_get_client", lambda token: database.client)
    with pytest.raises(AuthError) as exc:
        safety_review_service.request_safety_check(EVENT_ID, "token")
    assert exc.value.status_code == 409
    assert exc.value.message == f"This event is not ready for a safety check: {expected}."
    assert database.calls_to("events", "update") == []


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
