"""Comprehensive unit tests targeting 100% coverage for overview and assignment services/routes."""

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import Mock

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
        self._calls.append(("not",))
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
    calls = mock_admin_client(monkeypatch, [EVENT_UNASSIGNED_ROW])
    queue = event_assignment_service.get_unassigned_events_queue("lead-token")
    assert len(queue) == 1
    assert queue[0]["id"] == EVENT_ID
    assert queue == [EVENT_UNASSIGNED_ROW]
    assert ("is", "coordinator_id", "null") in calls
    assert ("neq", "status", "draft") in calls
    assert calls[calls.index(("not",)) + 1] == ("in", "status", ["completed", "rejected"])
    assert ("order", "created_at", False) in calls


def test_get_unassigned_events_queue_error_raises_autherror(monkeypatch):
    mock_admin_client(monkeypatch, [], raise_error=True)
    with pytest.raises(AuthError) as exc_info:
        event_assignment_service.get_unassigned_events_queue("lead-token")
    assert exc_info.value.status_code == 400


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
    assert update_call == {"coordinator_id": NEW_COORD_ID}
    audit_entry = call_named(calls, "insert")[1]
    assert audit_entry["action_type"] == "ASSIGNMENT"
    assert audit_entry["previous_coordinator_id"] is None
    assert audit_entry["reason"] == "Initial assignment from queue"
    assert notified == [(NEW_COORD_ID, "event_assigned")]


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

    assert call_named(calls, "update")[1] == {"coordinator_id": NEW_COORD_ID}
    audit_entry = call_named(calls, "insert")[1]
    assert audit_entry["action_type"] == "REASSIGNMENT"
    assert audit_entry["previous_coordinator_id"] == OLD_COORD_ID
    assert notified == [
        (NEW_COORD_ID, "event_reassigned"),
        (OLD_COORD_ID, "event_reassigned"),
    ]


def test_assign_nonexistent_event_raises_404(monkeypatch):
    mock_admin_client(monkeypatch, [])
    with pytest.raises(AuthError) as exc_info:
        event_assignment_service.assign_or_reassign_event(
            event_id=EVENT_ID,
            new_coordinator_id=NEW_COORD_ID,
            changed_by_id=LEAD_ID,
        )
    assert exc_info.value.status_code == 404


@pytest.mark.parametrize("status", ["completed", "rejected"])
def test_assign_completed_or_rejected_event_raises_400(monkeypatch, status):
    calls = mock_admin_client(monkeypatch, [{**EVENT_REJECTED_ROW, "status": status}])
    notify = Mock()
    monkeypatch.setattr(event_assignment_service, "notify", notify)
    with pytest.raises(AuthError) as exc_info:
        event_assignment_service.assign_or_reassign_event(
            event_id=EVENT_ID,
            new_coordinator_id=NEW_COORD_ID,
            changed_by_id=LEAD_ID,
        )
    assert exc_info.value.status_code == 400
    assert exc_info.value.message == "Cannot assign or reassign an event that is completed or rejected."
    assert not [c for c in calls if c[0] in {"update", "insert"}]
    notify.assert_not_called()


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
    calls = mock_admin_client(monkeypatch, [EVENT_ASSIGNED_ROW])
    events = overview_coordinator_events_service.get_lead_coordinator_events("lead-token")
    assert len(events) == 1
    assert events == [EVENT_ASSIGNED_ROW]
    assert calls[calls.index(("not",)) + 1] == ("in", "status", ["completed", "rejected", "draft"])
    assert ("order", "start_time", False) in calls


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
    get_coordinators = Mock(return_value=[{"id": OLD_COORD_ID, "full_name": "Coordinator Ben"}])
    monkeypatch.setattr(auth_service, "get_coordinators", get_coordinators)
    response = client.get("/events/coordinators", headers=LEAD_HEADERS)
    assert response.status_code == 200
    assert len(response.get_json()["coordinators"]) == 1
    assert response.get_json() == {"coordinators": [{"id": OLD_COORD_ID, "full_name": "Coordinator Ben"}]}
    get_coordinators.assert_called_once_with(access_token="lead-token")


def test_route_get_coordinators_error(client, monkeypatch):
    authenticate_as(monkeypatch, LEAD_COORDINATOR)
    monkeypatch.setattr(auth_service, "get_coordinators", Mock(side_effect=AuthError("Unable to load coordinators. Please try again.", status_code=502)))
    response = client.get("/events/coordinators", headers=LEAD_HEADERS)
    assert response.status_code == 502
    assert response.get_json() == {"error": "Unable to load coordinators. Please try again."}


def test_route_get_event_history_success(client, monkeypatch):
    authenticate_as(monkeypatch, LEAD_COORDINATOR)
    logs = [{"id": "log1", "event_id": EVENT_ID, "action_type": "ASSIGNMENT", "changed_by_id": LEAD_ID}]
    get_history = Mock(return_value=logs)
    monkeypatch.setattr(event_service, "get_event_activity_logs", get_history)
    response = client.get(f"/events/review/{EVENT_ID}/history", headers=LEAD_HEADERS)
    assert response.status_code == 200
    assert len(response.get_json()["logs"]) == 1
    assert response.get_json() == {"logs": logs}
    get_history.assert_called_once_with(EVENT_ID, access_token="lead-token")


def test_route_get_event_history_error(client, monkeypatch):
    authenticate_as(monkeypatch, LEAD_COORDINATOR)
    monkeypatch.setattr(event_service, "get_event_activity_logs", Mock(side_effect=AuthError("Unable to load this event's history.", status_code=502)))
    response = client.get(f"/events/review/{EVENT_ID}/history", headers=LEAD_HEADERS)
    assert response.status_code == 502
    assert response.get_json() == {"error": "Unable to load this event's history."}


def test_route_reassign_event_success(client, monkeypatch):
    authenticate_as(monkeypatch, LEAD_COORDINATOR)
    received = {}

    def _assign(**kwargs):
        received.update(kwargs)
        return EVENT_ASSIGNED_ROW

    monkeypatch.setattr(event_assignment_service, "assign_or_reassign_event", _assign)
    response = client.post(
        f"/events/review/{EVENT_ID}/reassign",
        json={"new_coordinator_id": NEW_COORD_ID, "reason": "Workload rebalance"},
        headers=LEAD_HEADERS,
    )
    assert response.status_code == 200
    assert received == {
        "event_id": EVENT_ID,
        "new_coordinator_id": NEW_COORD_ID,
        "changed_by_id": LEAD_ID,
        "reason": "Workload rebalance",
    }


def test_route_assignment_from_queue_is_logged_as_assignment(client, monkeypatch):
    """The queue and the overview share this route; an unassigned event is an ASSIGNMENT."""
    authenticate_as(monkeypatch, LEAD_COORDINATOR)
    calls = mock_admin_client(monkeypatch, [EVENT_UNASSIGNED_ROW])
    monkeypatch.setattr(event_assignment_service, "notify", lambda **kwargs: None)

    response = client.post(
        f"/events/review/{EVENT_ID}/reassign",
        json={"new_coordinator_id": NEW_COORD_ID, "reason": ""},
        headers=LEAD_HEADERS,
    )

    assert response.status_code == 200
    audit_entry = call_named(calls, "insert")[1]
    assert audit_entry["action_type"] == "ASSIGNMENT"
    assert audit_entry["reason"] == "Initial queue assignment"


def test_route_reassign_event_keeps_service_status_codes(client, monkeypatch):
    authenticate_as(monkeypatch, LEAD_COORDINATOR)

    def _raise(**kwargs):
        raise AuthError("Event not found.", status_code=404)

    monkeypatch.setattr(event_assignment_service, "assign_or_reassign_event", _raise)
    response = client.post(
        f"/events/review/{EVENT_ID}/reassign",
        json={"new_coordinator_id": NEW_COORD_ID},
        headers=LEAD_HEADERS,
    )
    assert response.status_code == 404


def test_route_reassign_event_missing_coordinator(client, monkeypatch):
    authenticate_as(monkeypatch, LEAD_COORDINATOR)
    assign = Mock()
    monkeypatch.setattr(event_assignment_service, "assign_or_reassign_event", assign)
    response = client.post(
        f"/events/review/{EVENT_ID}/reassign",
        json={"reason": "Missing target coordinator"},
        headers=LEAD_HEADERS,
    )
    assert response.status_code == 400
    assert response.get_json() == {"error": "Please select a coordinator to reassign to."}
    assign.assert_not_called()


def test_route_reassign_event_service_error(client, monkeypatch):
    authenticate_as(monkeypatch, LEAD_COORDINATOR)
    def _raise(*args, **kwargs): raise Exception("Service failed")
    monkeypatch.setattr(event_assignment_service, "assign_or_reassign_event", _raise)
    response = client.post(
        f"/events/review/{EVENT_ID}/reassign",
        json={"new_coordinator_id": NEW_COORD_ID},
        headers=LEAD_HEADERS,
    )
    assert response.status_code == 400


def test_route_get_lead_overview_success(client, monkeypatch):
    authenticate_as(monkeypatch, LEAD_COORDINATOR)
    get_overview = Mock(return_value=[EVENT_ASSIGNED_ROW])
    format_overview = Mock(return_value=[{"id": EVENT_ID, "name": EVENT_ASSIGNED_ROW["name"]}])
    monkeypatch.setattr(overview_coordinator_events_service, "get_lead_coordinator_events", get_overview)
    monkeypatch.setattr(Event, "format_lead_overview", format_overview)
    response = client.get("/events/lead-overview", headers=LEAD_HEADERS)
    assert response.status_code == 200
    assert response.get_json() == format_overview.return_value
    get_overview.assert_called_once_with(access_token="lead-token")
    format_overview.assert_called_once_with([EVENT_ASSIGNED_ROW])


def test_route_get_lead_overview_error(client, monkeypatch):
    authenticate_as(monkeypatch, LEAD_COORDINATOR)
    def _raise(*args, **kwargs): raise Exception("Overview error")
    monkeypatch.setattr(overview_coordinator_events_service, "get_lead_coordinator_events", _raise)
    response = client.get("/events/lead-overview", headers=LEAD_HEADERS)
    assert response.status_code == 400


def test_route_get_unassigned_queue_success(client, monkeypatch):
    authenticate_as(monkeypatch, LEAD_COORDINATOR)
    get_queue = Mock(return_value=[EVENT_UNASSIGNED_ROW])
    monkeypatch.setattr(event_assignment_service, "get_unassigned_events_queue", get_queue)
    response = client.get("/events/unassigned-queue", headers=LEAD_HEADERS)
    assert response.status_code == 200
    assert response.get_json() == [EVENT_UNASSIGNED_ROW]
    get_queue.assert_called_once_with(access_token="lead-token")


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

LEAD_ENDPOINTS = [
    ("POST", f"/events/review/{EVENT_ID}/reassign"),
    ("GET", "/events/lead-overview"),
    ("GET", "/events/unassigned-queue"),
    ("GET", "/events/coordinators"),
    ("GET", f"/events/review/{EVENT_ID}/history"),
]


@pytest.mark.parametrize("method,path", LEAD_ENDPOINTS)
@pytest.mark.parametrize("role", [r for r in Role if r != Role.EVENT_COORDINATOR_LEAD])
def test_lead_endpoints_deny_other_roles_without_reading_or_writing(client, monkeypatch, method, path, role):
    authenticate_as(monkeypatch, Profile(id=OLD_COORD_ID, full_name="Other user", role=role))
    services = [
        (event_assignment_service, "assign_or_reassign_event"),
        (overview_coordinator_events_service, "get_lead_coordinator_events"),
        (event_assignment_service, "get_unassigned_events_queue"),
        (auth_service, "get_coordinators"),
        (event_service, "get_event_activity_logs"),
    ]
    mocks = []
    for module, name in services:
        stub = Mock()
        monkeypatch.setattr(module, name, stub)
        mocks.append(stub)
    response = client.open(path, method=method, headers=LEAD_HEADERS, json={"new_coordinator_id": NEW_COORD_ID})
    assert response.status_code == 403
    assert response.get_json() == {"error": "Only Lead Coordinators can manage event assignments."}
    for stub in mocks:
        stub.assert_not_called()


@pytest.mark.parametrize("method,path", LEAD_ENDPOINTS)
@pytest.mark.parametrize("token", [None, "expired-token"])
def test_lead_endpoints_require_a_verified_identity(client, monkeypatch, method, path, token):
    verify = Mock(side_effect=AuthError("Invalid or expired token.", status_code=401))
    profile = Mock()
    admin = Mock()
    monkeypatch.setattr(auth_service, "get_user_id", verify)
    monkeypatch.setattr(auth_service, "get_profile", profile)
    monkeypatch.setattr(config, "get_admin_client", admin)
    response = client.open(path, method=method, headers={} if token is None else {"Authorization": f"Bearer {token}"})
    assert response.status_code == 401
    assert "error" in response.get_json()
    profile.assert_not_called()
    admin.assert_not_called()
    if token is None:
        verify.assert_not_called()
    else:
        verify.assert_called_once_with(token)
