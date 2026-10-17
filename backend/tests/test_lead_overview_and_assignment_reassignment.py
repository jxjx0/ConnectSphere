"""Comprehensive unit tests targeting 100% coverage for overview and assignment services/routes."""

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from postgrest import APIError as PostgrestAPIError

import config
from models.event import Event
from models.profile import Profile, Role
from services import (
    auth_service,
    event_assignment_service,
    event_service,
    notification_service,
    overview_coordinator_events_service,
)
from services.auth_service import AuthError


EVENT_ID = "55555555-5555-5555-5555-555555555555"
LEAD_ID = "11111111-1111-1111-1111-111111111111"
OLD_COORD_ID = "22222222-2222-2222-2222-222222222222"
NEW_COORD_ID = "33333333-3333-3333-3333-333333333333"

LEAD_COORDINATOR = Profile(
    id=LEAD_ID,
    full_name="Lead Alice",
    role=getattr(Role, "EVENT_COORDINATOR_LEAD", Role.COORDINATOR),
)

COORDINATOR = Profile(
    id=OLD_COORD_ID,
    full_name="Coordinator Ben",
    role=Role.COORDINATOR,
)

ORGANISER = Profile(
    id="44444444-4444-4444-4444-444444444444",
    full_name="Organiser Charlie",
    role=Role.ORGANISER,
)

LEAD_HEADERS = {"Authorization": "Bearer lead-token"}


def _in_days(days: int, hours: int = 0) -> str:
    moment = datetime.now(timezone.utc) + timedelta(days=days, hours=hours)
    return moment.isoformat()


EVENT_UNASSIGNED_ROW = {
    "id": EVENT_ID,
    "name": "Annual Tech Conference",
    "description": "A tech summit.",
    "purpose": "Sharing",
    "category": "conference",
    "start_time": _in_days(10),
    "end_time": _in_days(10, hours=5),
    "expected_attendance": 200,
    "status": "under_review",
    "organiser_id": ORGANISER.id,
    "coordinator_id": None,
    "created_at": _in_days(-2),
}

EVENT_ASSIGNED_ROW = {
    **EVENT_UNASSIGNED_ROW,
    "coordinator_id": OLD_COORD_ID,
}

EVENT_REJECTED_ROW = {
    **EVENT_UNASSIGNED_ROW,
    "status": "rejected",
}


def authenticate_as(monkeypatch, profile: Profile) -> None:
    monkeypatch.setattr(auth_service, "get_user_id", lambda access_token: profile.id)
    monkeypatch.setattr(auth_service, "get_profile", lambda access_token, user_id: profile)


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

    def eq(self, column, value):
        self._calls.append(("eq", column, value))
        return self

    def is_(self, column, value):
        self._calls.append(("is", column, value))
        return self

    def neq(self, column, value):
        self._calls.append(("neq", column, value))
        return self

    @property
    def not_(self):
        return self

    def in_(self, column, values):
        self._calls.append(("in", column, values))
        return self

    def order(self, column, desc=False):
        self._calls.append(("order", column, desc))
        return self

    def execute(self):
        if self._raise_error:
            raise PostgrestAPIError({"message": "DB Error", "code": "500"})
        return SimpleNamespace(data=self._rows)


def mock_admin_client(monkeypatch, rows, raise_error=False):
    calls = []
    builder = FakeQuery(rows, calls, raise_error=raise_error)
    fake_client = SimpleNamespace(
        from_=lambda table_name: builder,
        table=lambda table_name: builder,
    )
    monkeypatch.setattr(config, "get_admin_client", lambda: fake_client)
    monkeypatch.setattr(config, "get_user_client", lambda token: fake_client)
    return calls


def call_named(calls, name):
    return next(call for call in calls if call[0] == name)


# ============================================================================
# SERVICE UNIT TESTS
# ============================================================================


def test_get_unassigned_events_queue_success(monkeypatch):
    mock_admin_client(monkeypatch, [EVENT_UNASSIGNED_ROW])
    queue = event_assignment_service.get_unassigned_events_queue("lead-token")
    assert len(queue) == 1
    assert queue[0]["id"] == EVENT_ID


def test_get_unassigned_events_queue_error_raises_autherror(monkeypatch):
    mock_admin_client(monkeypatch, [], raise_error=True)
    with pytest.raises(AuthError) as exc_info:
        event_assignment_service.get_unassigned_events_queue("lead-token")
    assert exc_info.value.status_code == 400


def test_get_event_activity_logs_success(monkeypatch):
    log_row = {"id": "log1", "event_id": EVENT_ID, "action_type": "ASSIGNMENT"}
    mock_admin_client(monkeypatch, [log_row])
    logs = event_assignment_service.get_event_activity_logs(EVENT_ID)
    assert len(logs) == 1
    assert logs[0]["id"] == "log1"


def test_get_event_activity_logs_error_returns_empty_list(monkeypatch):
    mock_admin_client(monkeypatch, [], raise_error=True)
    logs = event_assignment_service.get_event_activity_logs(EVENT_ID)
    assert logs == []


def test_initial_assignment_updates_database_and_notifies(monkeypatch):
    calls = mock_admin_client(monkeypatch, [EVENT_UNASSIGNED_ROW])

    notified = []
    monkeypatch.setattr(
        event_assignment_service,
        "notify",
        lambda user_id, notification_type, title, body, event_id=None: notified.append(
            (user_id, notification_type)
        ),
    )

    event_assignment_service.assign_or_reassign_event(
        event_id=EVENT_ID,
        new_coordinator_id=NEW_COORD_ID,
        changed_by_id=LEAD_ID,
        reason="Initial assignment from queue",
    )

    update_call = call_named(calls, "update")[1]
    assert update_call["coordinator_id"] == NEW_COORD_ID
    assert len(notified) == 1
    assert notified[0] == (NEW_COORD_ID, "EVENT_ASSIGNMENT")


def test_reassignment_notifies_both_coordinators(monkeypatch):
    calls = mock_admin_client(monkeypatch, [EVENT_ASSIGNED_ROW])

    notified = []
    monkeypatch.setattr(
        event_assignment_service,
        "notify",
        lambda user_id, notification_type, title, body, event_id=None: notified.append(
            (user_id, notification_type)
        ),
    )

    event_assignment_service.assign_or_reassign_event(
        event_id=EVENT_ID,
        new_coordinator_id=NEW_COORD_ID,
        changed_by_id=LEAD_ID,
        reason="Schedule conflict",
    )

    assert call_named(calls, "update")[1]["coordinator_id"] == NEW_COORD_ID
    assert len(notified) == 2


def test_assign_nonexistent_event_raises_404(monkeypatch):
    mock_admin_client(monkeypatch, [])
    with pytest.raises(AuthError) as exc_info:
        event_assignment_service.assign_or_reassign_event(
            event_id=EVENT_ID,
            new_coordinator_id=NEW_COORD_ID,
            changed_by_id=LEAD_ID,
        )
    assert exc_info.value.status_code == 404


def test_assign_completed_or_rejected_event_raises_400(monkeypatch):
    mock_admin_client(monkeypatch, [EVENT_REJECTED_ROW])
    with pytest.raises(AuthError) as exc_info:
        event_assignment_service.assign_or_reassign_event(
            event_id=EVENT_ID,
            new_coordinator_id=NEW_COORD_ID,
            changed_by_id=LEAD_ID,
        )
    assert exc_info.value.status_code == 400


def test_assign_update_failure_raises_500(monkeypatch):
    class CustomClient:
        def __init__(self):
            self.step = 0
        def from_(self, table_name): return self
        def select(self, *args): return self
        def update(self, values): return self
        def eq(self, column, value): return self
        def execute(self):
            self.step += 1
            if self.step == 1:
                return SimpleNamespace(data=[EVENT_UNASSIGNED_ROW])
            return SimpleNamespace(data=[])  # Simulate update failure

    monkeypatch.setattr(config, "get_admin_client", lambda: CustomClient())
    with pytest.raises(AuthError) as exc_info:
        event_assignment_service.assign_or_reassign_event(
            event_id=EVENT_ID,
            new_coordinator_id=NEW_COORD_ID,
            changed_by_id=LEAD_ID,
        )
    assert exc_info.value.status_code == 500


def test_get_lead_coordinator_events_success(monkeypatch):
    mock_admin_client(monkeypatch, [EVENT_ASSIGNED_ROW])
    events = overview_coordinator_events_service.get_lead_coordinator_events("lead-token")
    assert len(events) == 1


def test_get_lead_coordinator_events_error_raises_autherror(monkeypatch):
    mock_admin_client(monkeypatch, [], raise_error=True)
    with pytest.raises(AuthError) as exc_info:
        overview_coordinator_events_service.get_lead_coordinator_events("lead-token")
    assert exc_info.value.status_code == 400


# ============================================================================
# ROUTE ENDPOINT TESTS
# ============================================================================


def test_route_get_coordinators_success(client, monkeypatch):
    authenticate_as(monkeypatch, LEAD_COORDINATOR)
    monkeypatch.setattr(auth_service, "get_coordinators", lambda access_token: [{"id": OLD_COORD_ID}])
    response = client.get("/events/coordinators", headers=LEAD_HEADERS)
    assert response.status_code == 200
    assert len(response.get_json()["coordinators"]) == 1


def test_route_get_coordinators_error(client, monkeypatch):
    authenticate_as(monkeypatch, LEAD_COORDINATOR)
    def _raise(*args, **kwargs): raise Exception("Auth failed")
    monkeypatch.setattr(auth_service, "get_coordinators", _raise)
    response = client.get("/events/coordinators", headers=LEAD_HEADERS)
    assert response.status_code == 400


def test_route_get_event_history_success(client, monkeypatch):
    authenticate_as(monkeypatch, LEAD_COORDINATOR)
    monkeypatch.setattr(
        event_service, "get_event_activity_logs", lambda eid, access_token: [{"id": "log1"}]
    )
    response = client.get(f"/events/review/{EVENT_ID}/history", headers=LEAD_HEADERS)
    assert response.status_code == 200
    assert len(response.get_json()["logs"]) == 1


def test_route_get_event_history_error(client, monkeypatch):
    authenticate_as(monkeypatch, LEAD_COORDINATOR)
    def _raise(*args, **kwargs): raise Exception("Log error")
    monkeypatch.setattr(event_service, "get_event_activity_logs", _raise)
    response = client.get(f"/events/review/{EVENT_ID}/history", headers=LEAD_HEADERS)
    assert response.status_code == 400


def test_route_reassign_event_success(client, monkeypatch):
    authenticate_as(monkeypatch, LEAD_COORDINATOR)
    monkeypatch.setattr(
        event_service,
        "reassign_event",
        lambda event_id, new_coordinator_id, changed_by_id, reason, access_token: EVENT_ASSIGNED_ROW,
    )
    response = client.post(
        f"/events/review/{EVENT_ID}/reassign",
        json={"new_coordinator_id": NEW_COORD_ID, "reason": "Workload rebalance"},
        headers=LEAD_HEADERS,
    )
    assert response.status_code == 200


def test_route_reassign_event_missing_coordinator(client, monkeypatch):
    authenticate_as(monkeypatch, LEAD_COORDINATOR)
    response = client.post(
        f"/events/review/{EVENT_ID}/reassign",
        json={"reason": "Missing target coordinator"},
        headers=LEAD_HEADERS,
    )
    assert response.status_code == 400


def test_route_reassign_event_service_error(client, monkeypatch):
    authenticate_as(monkeypatch, LEAD_COORDINATOR)
    def _raise(*args, **kwargs): raise Exception("Service failed")
    monkeypatch.setattr(event_service, "reassign_event", _raise)
    response = client.post(
        f"/events/review/{EVENT_ID}/reassign",
        json={"new_coordinator_id": NEW_COORD_ID},
        headers=LEAD_HEADERS,
    )
    assert response.status_code == 400


def test_route_get_lead_overview_success(client, monkeypatch):
    authenticate_as(monkeypatch, LEAD_COORDINATOR)
    monkeypatch.setattr(
        overview_coordinator_events_service,
        "get_lead_coordinator_events",
        lambda access_token: [EVENT_ASSIGNED_ROW],
    )
    monkeypatch.setattr(Event, "format_lead_overview", lambda raw: [{"id": EVENT_ID}])
    response = client.get("/events/lead-overview", headers=LEAD_HEADERS)
    assert response.status_code == 200


def test_route_get_lead_overview_error(client, monkeypatch):
    authenticate_as(monkeypatch, LEAD_COORDINATOR)
    def _raise(*args, **kwargs): raise Exception("Overview error")
    monkeypatch.setattr(overview_coordinator_events_service, "get_lead_coordinator_events", _raise)
    response = client.get("/events/lead-overview", headers=LEAD_HEADERS)
    assert response.status_code == 400


def test_route_get_unassigned_queue_success(client, monkeypatch):
    authenticate_as(monkeypatch, LEAD_COORDINATOR)
    monkeypatch.setattr(
        event_assignment_service,
        "get_unassigned_events_queue",
        lambda access_token: [EVENT_UNASSIGNED_ROW],
    )
    response = client.get("/events/unassigned-queue", headers=LEAD_HEADERS)
    assert response.status_code == 200


def test_route_get_unassigned_queue_error(client, monkeypatch):
    authenticate_as(monkeypatch, LEAD_COORDINATOR)
    def _raise(*args, **kwargs): raise Exception("Queue error")
    monkeypatch.setattr(event_assignment_service, "get_unassigned_events_queue", _raise)
    response = client.get("/events/unassigned-queue", headers=LEAD_HEADERS)
    assert response.status_code == 400


def test_route_organiser_cannot_access_unassigned_queue(client, monkeypatch):
    authenticate_as(monkeypatch, ORGANISER)
    response = client.get("/events/unassigned-queue", headers={"Authorization": "Bearer org-token"})
    assert response.status_code == 403