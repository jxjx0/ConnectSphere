"""Tests for submitting an event request (T7-45)."""

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

import config
from models.event import (
    Event,
    EventCategory,
    EventOrganiser,
    EventStatus,
    EventSubmitRequest,
)
from models.profile import Profile, Role
from services import auth_service, event_service
from services.auth_service import AuthError


def _in_days(days: int, hours: int = 0) -> str:
    """An ISO timestamp relative to now, so tests never age out."""
    moment = datetime.now(timezone.utc) + timedelta(days=days, hours=hours)
    return moment.isoformat()


def valid_event() -> dict:
    return {
        "name": "Annual Client Summit",
        "description": "A full-day summit for our regional clients.",
        "purpose": "Client relationship building",
        "category": "conference",
        "start_time": _in_days(30),
        "end_time": _in_days(30, hours=8),
        "expected_attendance": 120,
        "location_preference": "Somewhere central, near an MRT station",
        "layout_preference": "Theatre",
        "accessibility_requirements": "Step-free access to the stage",
        "equipment_requirements": "Two projectors and four handheld mics",
    }


ORGANISER_PROFILE = Profile(
    id="11111111-1111-1111-1111-111111111111",
    full_name="Ada Tan",
    role=Role.ORGANISER,
    contact_number="+65 9123 4567",
    organization="Northwind Pte Ltd",
)

COORDINATOR_PROFILE = Profile(
    id="22222222-2222-2222-2222-222222222222",
    full_name="Ben Lim",
    role=Role.COORDINATOR,
)

EVENT_RESPONSE = Event(
    id="33333333-3333-3333-3333-333333333333",
    organiser_id=ORGANISER_PROFILE.id,
    status=EventStatus.UNDER_REVIEW,
    **valid_event(),
)


def authenticate_as(monkeypatch, profile: Profile) -> None:
    """Replace token verification and profile lookup for an isolated route test."""
    monkeypatch.setattr(
        auth_service, "get_user_id", lambda access_token: profile.id
    )
    monkeypatch.setattr(
        auth_service, "get_profile", lambda access_token, user_id: profile
    )


# --- Model validation ------------------------------------------------------


def test_a_valid_event_request_passes_validation():
    request = EventSubmitRequest(**valid_event())

    assert request.name == "Annual Client Summit"
    assert request.expected_attendance == 120


@pytest.mark.parametrize("field", ["name", "description", "purpose"])
def test_required_text_fields_must_not_be_blank(field):
    payload = valid_event()
    payload[field] = "   "

    with pytest.raises(ValidationError):
        EventSubmitRequest(**payload)


def test_expected_attendance_must_be_positive():
    payload = valid_event()
    payload["expected_attendance"] = 0

    with pytest.raises(ValidationError):
        EventSubmitRequest(**payload)


def test_end_time_must_be_after_start_time():
    payload = valid_event()
    payload["end_time"] = payload["start_time"]

    with pytest.raises(ValidationError) as caught:
        EventSubmitRequest(**payload)

    assert "End time must be after the start time" in str(caught.value)


def test_start_time_must_be_in_the_future():
    payload = valid_event()
    payload["start_time"] = _in_days(-2)
    payload["end_time"] = _in_days(-2, hours=3)

    with pytest.raises(ValidationError) as caught:
        EventSubmitRequest(**payload)

    assert "Start time must be in the future" in str(caught.value)


def test_blank_optional_preferences_become_none():
    payload = valid_event()
    payload["location_preference"] = "  "
    payload["equipment_requirements"] = ""

    request = EventSubmitRequest(**payload)

    assert request.location_preference is None
    assert request.equipment_requirements is None


def test_a_category_outside_the_fixed_set_is_rejected():
    payload = valid_event()
    payload["category"] = "birthday party"

    with pytest.raises(ValidationError):
        EventSubmitRequest(**payload)


def test_choosing_other_requires_a_description():
    payload = valid_event()
    payload["category"] = "other"

    with pytest.raises(ValidationError) as caught:
        EventSubmitRequest(**payload)

    assert "Describe the category when choosing Other" in str(caught.value)


def test_other_with_a_description_is_accepted():
    payload = valid_event()
    payload["category"] = "other"
    payload["category_other"] = "Charity fun run"

    request = EventSubmitRequest(**payload)

    assert request.category is EventCategory.OTHER
    assert request.category_other == "Charity fun run"


def test_a_description_without_choosing_other_is_rejected():
    payload = valid_event()
    payload["category_other"] = "Charity fun run"

    with pytest.raises(ValidationError) as caught:
        EventSubmitRequest(**payload)

    assert "when the category is Other" in str(caught.value)


# --- Service ---------------------------------------------------------------


def test_service_sets_the_organiser_and_status_itself(monkeypatch):
    """The caller cannot choose whose event this is, or skip ahead a status."""
    captured = {}

    class FakeTable:
        def insert(self, row):
            captured.update(row)
            return self

        def execute(self):
            return SimpleNamespace(
                data=[EVENT_RESPONSE.model_dump(mode="json")]
            )

    monkeypatch.setattr(
        config,
        "get_user_client",
        lambda access_token: SimpleNamespace(table=lambda name: FakeTable()),
    )

    request = EventSubmitRequest(**valid_event())

    event = event_service.submit_event(
        "organiser-token", ORGANISER_PROFILE.id, request
    )

    assert captured["organiser_id"] == ORGANISER_PROFILE.id
    assert captured["status"] == "under_review"
    assert event.status is EventStatus.UNDER_REVIEW


# --- Route -----------------------------------------------------------------


def test_organiser_can_submit_an_event_request(client, monkeypatch):
    authenticate_as(monkeypatch, ORGANISER_PROFILE)
    monkeypatch.setattr(
        event_service,
        "submit_event",
        lambda access_token, organiser_id, request: EVENT_RESPONSE,
    )

    response = client.post(
        "/events",
        json=valid_event(),
        headers={"Authorization": "Bearer organiser-token"},
    )

    assert response.status_code == 201
    assert response.get_json()["event"]["name"] == "Annual Client Summit"
    assert response.get_json()["event"]["status"] == "under_review"


def test_submitting_event_notifies_coordinator_lead(client, monkeypatch):
    authenticate_as(monkeypatch, ORGANISER_PROFILE)
    captured = {}
    monkeypatch.setattr(
        event_service, "submit_event", lambda *args: EVENT_RESPONSE
    )
    monkeypatch.setattr(
        "routes.events.notification_service.notify_role",
        lambda *args: captured.setdefault("notification", args),
    )

    response = client.post(
        "/events",
        json=valid_event(),
        headers={"Authorization": "Bearer organiser-token"},
    )

    assert response.status_code == 201
    assert captured["notification"] == (
        "event_coordinator_lead",
        "event_submitted",
        "New event request submitted",
        "A new event request 'Annual Client Summit' has been submitted for assignment.",
        EVENT_RESPONSE.id,
    )


def test_submit_passes_the_signed_in_organiser_to_the_service(
    client, monkeypatch
):
    authenticate_as(monkeypatch, ORGANISER_PROFILE)
    captured = {}

    def submit_event(access_token, organiser_id, request):
        captured["organiser_id"] = organiser_id
        captured["name"] = request.name
        return EVENT_RESPONSE

    monkeypatch.setattr(event_service, "submit_event", submit_event)

    client.post(
        "/events",
        json=valid_event(),
        headers={"Authorization": "Bearer organiser-token"},
    )

    assert captured["organiser_id"] == ORGANISER_PROFILE.id
    assert captured["name"] == "Annual Client Summit"


def test_non_organisers_cannot_submit_an_event_request(client, monkeypatch):
    authenticate_as(monkeypatch, COORDINATOR_PROFILE)

    def submit_event(access_token, organiser_id, request):
        raise AssertionError("the service must not be reached")

    monkeypatch.setattr(event_service, "submit_event", submit_event)

    response = client.post(
        "/events",
        json=valid_event(),
        headers={"Authorization": "Bearer coordinator-token"},
    )

    assert response.status_code == 403


def test_submit_without_a_token_is_rejected(client):
    response = client.post("/events", json=valid_event())

    assert response.status_code == 401


def test_invalid_event_returns_plain_error_sentences(client, monkeypatch):
    authenticate_as(monkeypatch, ORGANISER_PROFILE)
    payload = valid_event()
    payload["end_time"] = payload["start_time"]

    response = client.post(
        "/events",
        json=payload,
        headers={"Authorization": "Bearer organiser-token"},
    )

    assert response.status_code == 400
    assert response.get_json()["errors"] == [
        "End time must be after the start time"
    ]


# --- Viewing my submitted requests (T7-100) --------------------------------


class FakeQuery:
    """Records the filters a service applied, then returns canned rows."""

    def __init__(self, rows, calls):
        self._rows = rows
        self._calls = calls

    def select(self, *args):
        return self

    def update(self, values):
        self._calls.append(("update", values))
        return self

    def eq(self, column, value):
        self._calls.append(("eq", column, value))
        return self

    def neq(self, column, value):
        self._calls.append(("neq", column, value))
        return self

    def in_(self, column, values):
        self._calls.append(("in", column, tuple(values)))
        return self

    def order(self, column, desc=False):
        self._calls.append(("order", column))
        return self

    def execute(self):
        return SimpleNamespace(data=self._rows)


def fake_client(monkeypatch, rows_by_table, calls):
    monkeypatch.setattr(
        config,
        "get_user_client",
        lambda access_token: SimpleNamespace(
            table=lambda name: FakeQuery(rows_by_table.get(name, []), calls)
        ),
    )


def test_listing_my_events_filters_to_me_and_skips_drafts(monkeypatch):
    calls = []
    fake_client(
        monkeypatch,
        {"events": [EVENT_RESPONSE.model_dump(mode="json")]},
        calls,
    )

    events = event_service.list_my_events(
        "organiser-token", ORGANISER_PROFILE.id
    )

    assert ("eq", "organiser_id", ORGANISER_PROFILE.id) in calls
    assert ("neq", "status", "draft") in calls
    assert ("order", "start_time") in calls
    assert len(events) == 1


def test_an_assigned_coordinators_name_replaces_their_id(monkeypatch):
    assigned = EVENT_RESPONSE.model_dump(mode="json")
    assigned["coordinator_id"] = COORDINATOR_PROFILE.id
    fake_client(
        monkeypatch,
        {
            "events": [assigned],
            "profiles": [
                {
                    "id": COORDINATOR_PROFILE.id,
                    "full_name": COORDINATOR_PROFILE.full_name,
                }
            ],
        },
        [],
    )

    events = event_service.list_my_events(
        "organiser-token", ORGANISER_PROFILE.id
    )

    assert events[0].coordinator_name == "Ben Lim"


def test_an_unassigned_event_has_no_coordinator_name(monkeypatch):
    fake_client(
        monkeypatch,
        {"events": [EVENT_RESPONSE.model_dump(mode="json")]},
        [],
    )

    events = event_service.list_my_events(
        "organiser-token", ORGANISER_PROFILE.id
    )

    assert events[0].coordinator_name is None


def test_organiser_can_list_their_own_event_requests(client, monkeypatch):
    authenticate_as(monkeypatch, ORGANISER_PROFILE)
    monkeypatch.setattr(
        event_service,
        "list_my_events",
        lambda access_token, organiser_id: [EVENT_RESPONSE],
    )

    response = client.get(
        "/events", headers={"Authorization": "Bearer organiser-token"}
    )

    assert response.status_code == 200
    assert len(response.get_json()["events"]) == 1
    assert response.get_json()["events"][0]["name"] == "Annual Client Summit"


def test_list_asks_the_service_for_the_signed_in_organiser(
    client, monkeypatch
):
    authenticate_as(monkeypatch, ORGANISER_PROFILE)
    captured = {}

    def list_my_events(access_token, organiser_id):
        captured["organiser_id"] = organiser_id
        return []

    monkeypatch.setattr(event_service, "list_my_events", list_my_events)

    client.get("/events", headers={"Authorization": "Bearer organiser-token"})

    assert captured["organiser_id"] == ORGANISER_PROFILE.id


def test_non_organisers_cannot_list_event_requests(client, monkeypatch):
    authenticate_as(monkeypatch, COORDINATOR_PROFILE)

    def list_my_events(access_token, organiser_id):
        raise AssertionError("the service must not be reached")

    monkeypatch.setattr(event_service, "list_my_events", list_my_events)

    response = client.get(
        "/events", headers={"Authorization": "Bearer coordinator-token"}
    )

    assert response.status_code == 403


def test_listing_without_a_token_is_rejected(client):
    assert client.get("/events").status_code == 401


def test_opening_one_of_my_events_filters_by_id_and_owner(monkeypatch):
    calls = []
    fake_client(
        monkeypatch,
        {"events": [EVENT_RESPONSE.model_dump(mode="json")]},
        calls,
    )

    event = event_service.get_my_event(
        "organiser-token", ORGANISER_PROFILE.id, EVENT_RESPONSE.id
    )

    assert ("eq", "id", EVENT_RESPONSE.id) in calls
    assert ("eq", "organiser_id", ORGANISER_PROFILE.id) in calls
    assert event.id == EVENT_RESPONSE.id


def test_another_organisers_event_is_not_found(monkeypatch):
    """RLS returns no row, and the service must not leak that it exists."""
    fake_client(monkeypatch, {"events": []}, [])

    with pytest.raises(AuthError) as caught:
        event_service.get_my_event(
            "organiser-token", ORGANISER_PROFILE.id, "someone-elses-id"
        )

    assert caught.value.status_code == 404


def test_organiser_can_open_one_of_their_requests(client, monkeypatch):
    authenticate_as(monkeypatch, ORGANISER_PROFILE)
    monkeypatch.setattr(
        event_service,
        "get_my_event",
        lambda access_token, organiser_id, event_id: EVENT_RESPONSE,
    )

    response = client.get(
        f"/events/{EVENT_RESPONSE.id}",
        headers={"Authorization": "Bearer organiser-token"},
    )

    assert response.status_code == 200
    assert response.get_json()["event"]["name"] == "Annual Client Summit"


def test_non_organisers_cannot_open_an_event_request(client, monkeypatch):
    authenticate_as(monkeypatch, COORDINATOR_PROFILE)

    def get_my_event(access_token, organiser_id, event_id):
        raise AssertionError("the service must not be reached")

    monkeypatch.setattr(event_service, "get_my_event", get_my_event)

    response = client.get(
        f"/events/{EVENT_RESPONSE.id}",
        headers={"Authorization": "Bearer coordinator-token"},
    )

    assert response.status_code == 403


# --- Reviewing assigned event requests ------------------------------------


def test_coordinator_list_includes_assigned_events_of_every_status(monkeypatch):
    calls = []
    under_review = EVENT_RESPONSE.model_dump(mode="json")
    under_review["coordinator_id"] = COORDINATOR_PROFILE.id
    under_review["status"] = EventStatus.UNDER_REVIEW.value
    under_review["equipment_requests"] = [
        {"status": "Pending Technical Approval"}
    ]
    approved = dict(under_review, id="55555555-5555-5555-5555-555555555555")
    approved["status"] = EventStatus.PLANNING.value
    approved["equipment_requests"] = [{"status": "Approved"}]
    fake_client(monkeypatch, {"events": [under_review, approved]}, calls)

    events = event_service.list_assigned_events(
        "coordinator-token", COORDINATOR_PROFILE.id
    )

    assert ("eq", "coordinator_id", COORDINATOR_PROFILE.id) in calls
    assert ("neq", "status", EventStatus.DRAFT.value) in calls
    assert ("order", "start_time") in calls
    assert events[0].name == "Annual Client Summit"
    assert [event.status for event in events] == [
        EventStatus.UNDER_REVIEW,
        EventStatus.PLANNING,
    ]
    assert events[0].equipment_requests == [
        {"status": "Pending Technical Approval"}
    ]
    assert events[1].equipment_requests == [{"status": "Approved"}]


def test_coordinator_detail_filters_by_id_and_assignment(monkeypatch):
    calls = []
    assigned = EVENT_RESPONSE.model_dump(mode="json")
    assigned["coordinator_id"] = COORDINATOR_PROFILE.id
    fake_client(monkeypatch, {"events": [assigned]}, calls)

    event = event_service.get_assigned_event(
        "coordinator-token", COORDINATOR_PROFILE.id, EVENT_RESPONSE.id
    )

    assert ("eq", "id", EVENT_RESPONSE.id) in calls
    assert ("eq", "coordinator_id", COORDINATOR_PROFILE.id) in calls
    assert ("neq", "status", EventStatus.DRAFT.value) in calls
    assert event.purpose == "Client relationship building"
    assert event.start_time is not None and event.end_time is not None
    assert event.expected_attendance == 120
    assert event.layout_preference == "Theatre"
    assert event.equipment_requirements == "Two projectors and four handheld mics"
    assert event.accessibility_requirements == "Step-free access to the stage"


def test_unassigned_event_is_not_found_for_coordinator(monkeypatch):
    fake_client(monkeypatch, {"events": []}, [])

    with pytest.raises(AuthError) as caught:
        event_service.get_assigned_event(
            "coordinator-token", COORDINATOR_PROFILE.id, EVENT_RESPONSE.id
        )

    assert caught.value.status_code == 404


@pytest.mark.parametrize(
    ("decision", "expected_status"),
    [
        (EventStatus.PLANNING, EventStatus.PLANNING),
        (EventStatus.REJECTED, EventStatus.REJECTED),
    ],
)
def test_coordinator_decision_updates_only_assigned_event_under_review(
    monkeypatch, decision, expected_status
):
    calls = []
    updated = EVENT_RESPONSE.model_copy(
        update={
            "coordinator_id": COORDINATOR_PROFILE.id,
            "status": expected_status,
        }
    )
    fake_client(monkeypatch, {"events": [updated.model_dump(mode="json")]}, calls)

    event = event_service.decide_assigned_event(
        "coordinator-token",
        COORDINATOR_PROFILE.id,
        EVENT_RESPONSE.id,
        decision,
    )

    updates = [values for call, values, *_ in calls if call == "update"]
    assert len(updates) == 1
    assert updates[0]["status"] == expected_status.value
    assert "updated_at" in updates[0]
    assert ("eq", "id", EVENT_RESPONSE.id) in calls
    assert ("eq", "coordinator_id", COORDINATOR_PROFILE.id) in calls
    assert ("eq", "status", EventStatus.UNDER_REVIEW.value) in calls
    assert event.status is expected_status


@pytest.mark.parametrize(
    ("endpoint", "status", "notification_type", "title", "body"),
    [
        (
            "approve",
            EventStatus.PLANNING,
            "event_approved",
            "Event request approved",
            "The proposed event request 'Annual Client Summit' has been approved.",
        ),
        (
            "reject",
            EventStatus.REJECTED,
            "event_rejected",
            "Event request rejected",
            "The proposed event request 'Annual Client Summit' has been rejected.",
        ),
    ],
)
def test_coordinator_event_decision_notifies_organiser(
    client, monkeypatch, endpoint, status, notification_type, title, body
):
    authenticate_as(monkeypatch, COORDINATOR_PROFILE)
    reviewed_event = EVENT_RESPONSE.model_copy(update={"status": status})
    captured = {}
    monkeypatch.setattr(
        event_service, "decide_assigned_event", lambda *args: reviewed_event
    )
    monkeypatch.setattr(
        "routes.events.notification_service.notify",
        lambda *args: captured.setdefault("notification", args),
    )

    response = client.post(
        f"/events/review/{EVENT_RESPONSE.id}/{endpoint}",
        headers={"Authorization": "Bearer coordinator-token"},
    )

    assert response.status_code == 200
    assert captured["notification"] == (
        ORGANISER_PROFILE.id,
        notification_type,
        title,
        body,
        EVENT_RESPONSE.id,
    )


def test_coordinator_cannot_decide_missing_event(monkeypatch):
    fake_client(monkeypatch, {"events": []}, [])

    with pytest.raises(AuthError) as caught:
        event_service.decide_assigned_event(
            "coordinator-token",
            COORDINATOR_PROFILE.id,
            EVENT_RESPONSE.id,
            EventStatus.PLANNING,
        )

    assert caught.value.status_code == 404


def test_coordinator_cannot_decide_an_event_already_decided(monkeypatch):
    # The update matches nothing, but the event is still assigned to them.
    results = iter([[], [{"id": EVENT_RESPONSE.id}]])
    monkeypatch.setattr(
        config,
        "get_user_client",
        lambda access_token: SimpleNamespace(
            table=lambda name: FakeQuery(next(results), [])
        ),
    )

    with pytest.raises(AuthError) as caught:
        event_service.decide_assigned_event(
            "coordinator-token",
            COORDINATOR_PROFILE.id,
            EVENT_RESPONSE.id,
            EventStatus.REJECTED,
        )

    assert caught.value.status_code == 409


def test_review_read_errors_use_a_read_message():
    error = SimpleNamespace(code="PGRST205")

    translated = event_service._review_read_error(
        error, "the event request"
    )

    assert translated.status_code == 502
    assert translated.message == "Unable to load the event request."


def test_coordinator_can_list_assigned_requests(client, monkeypatch):
    authenticate_as(monkeypatch, COORDINATOR_PROFILE)
    monkeypatch.setattr(
        event_service,
        "list_assigned_events",
        lambda access_token, coordinator_id: [EVENT_RESPONSE],
    )

    response = client.get(
        "/events/review", headers={"Authorization": "Bearer coordinator-token"}
    )

    assert response.status_code == 200
    assert response.get_json()["events"][0]["name"] == "Annual Client Summit"


def test_non_coordinators_cannot_list_review_requests(client, monkeypatch):
    authenticate_as(monkeypatch, ORGANISER_PROFILE)

    def list_events(access_token, coordinator_id):
        raise AssertionError("the service must not be reached")

    monkeypatch.setattr(event_service, "list_assigned_events", list_events)

    response = client.get(
        "/events/review", headers={"Authorization": "Bearer organiser-token"}
    )

    assert response.status_code == 403


def test_coordinator_detail_route_passes_current_coordinator_id(
    client, monkeypatch
):
    authenticate_as(monkeypatch, COORDINATOR_PROFILE)
    captured = {}

    def get_event(access_token, coordinator_id, event_id):
        captured.update(coordinator_id=coordinator_id, event_id=event_id)
        return EVENT_RESPONSE

    monkeypatch.setattr(event_service, "get_assigned_event", get_event)
    monkeypatch.setattr(
        event_service,
        "get_event_organiser",
        lambda access_token, organiser_id: None,
    )

    response = client.get(
        f"/events/review/{EVENT_RESPONSE.id}",
        headers={"Authorization": "Bearer coordinator-token"},
    )

    assert response.status_code == 200
    assert captured == {
        "coordinator_id": COORDINATOR_PROFILE.id,
        "event_id": EVENT_RESPONSE.id,
    }


def test_non_coordinators_cannot_view_coordinator_review_detail(
    client, monkeypatch
):
    authenticate_as(monkeypatch, ORGANISER_PROFILE)

    def get_event(access_token, coordinator_id, event_id):
        raise AssertionError("the service must not be reached")

    monkeypatch.setattr(event_service, "get_assigned_event", get_event)

    response = client.get(
        f"/events/review/{EVENT_RESPONSE.id}",
        headers={"Authorization": "Bearer organiser-token"},
    )

    assert response.status_code == 403


def test_coordinator_detail_route_returns_requested_data(
    client, monkeypatch
):
    authenticate_as(monkeypatch, COORDINATOR_PROFILE)
    monkeypatch.setattr(
        event_service,
        "get_assigned_event",
        lambda access_token, coordinator_id, event_id: EVENT_RESPONSE,
    )
    captured = {}

    def get_organiser(access_token, organiser_id):
        captured["organiser_id"] = organiser_id
        return EventOrganiser(
            full_name=ORGANISER_PROFILE.full_name,
            contact_number=ORGANISER_PROFILE.contact_number,
            organization=ORGANISER_PROFILE.organization,
        )

    monkeypatch.setattr(event_service, "get_event_organiser", get_organiser)
    decision = {"decision": "CHANGES_REQUESTED", "reason": "Add an exit", "created_at": "2026-10-19T11:00:00+00:00"}
    monkeypatch.setattr(
        "services.safety_review_service.get_latest_safety_decision",
        lambda access_token, event_id: decision if event_id == EVENT_RESPONSE.id else None,
    )

    headers = {"Authorization": "Bearer coordinator-token"}
    detail = client.get(f"/events/review/{EVENT_RESPONSE.id}", headers=headers)

    assert detail.status_code == 200
    assert detail.get_json()["safety_decision"] == decision
    assert detail.get_json()["event"]["layout_preference"] == "Theatre"
    assert detail.get_json()["event"]["accessibility_requirements"]
    assert captured["organiser_id"] == ORGANISER_PROFILE.id
    assert detail.get_json()["organiser"] == {
        "full_name": "Ada Tan",
        "contact_number": "+65 9123 4567",
        "organization": "Northwind Pte Ltd",
    }


def test_coordinator_sees_the_organisers_contact_details(monkeypatch):
    calls = []
    fake_client(
        monkeypatch,
        {"profiles": [ORGANISER_PROFILE.model_dump(mode="json")]},
        calls,
    )

    organiser = event_service.get_event_organiser(
        "coordinator-token", ORGANISER_PROFILE.id
    )

    assert ("eq", "id", ORGANISER_PROFILE.id) in calls
    assert organiser.full_name == "Ada Tan"
    assert organiser.contact_number == "+65 9123 4567"
    assert organiser.organization == "Northwind Pte Ltd"


def test_unreadable_organiser_profile_returns_none(monkeypatch):
    fake_client(monkeypatch, {"profiles": []}, [])

    assert (
        event_service.get_event_organiser(
            "coordinator-token", ORGANISER_PROFILE.id
        )
        is None
    )


def test_coordinator_can_approve_an_assigned_request(client, monkeypatch):
    authenticate_as(monkeypatch, COORDINATOR_PROFILE)
    approved = EVENT_RESPONSE.model_copy(
        update={
            "coordinator_id": COORDINATOR_PROFILE.id,
            "status": EventStatus.PLANNING,
        }
    )
    captured = {}

    def decide(access_token, coordinator_id, event_id, status):
        captured.update(
            coordinator_id=coordinator_id, event_id=event_id, status=status
        )
        return approved

    monkeypatch.setattr(event_service, "decide_assigned_event", decide)

    response = client.post(
        f"/events/review/{EVENT_RESPONSE.id}/approve",
        headers={"Authorization": "Bearer coordinator-token"},
    )

    assert response.status_code == 200
    assert captured == {
        "coordinator_id": COORDINATOR_PROFILE.id,
        "event_id": EVENT_RESPONSE.id,
        "status": EventStatus.PLANNING,
    }
    assert response.get_json()["event"]["status"] == "planning"


def test_non_coordinators_cannot_reject_review_requests(client, monkeypatch):
    authenticate_as(monkeypatch, ORGANISER_PROFILE)

    def decide(access_token, coordinator_id, event_id, status):
        raise AssertionError("the service must not be reached")

    monkeypatch.setattr(event_service, "decide_assigned_event", decide)

    response = client.post(
        f"/events/review/{EVENT_RESPONSE.id}/reject",
        headers={"Authorization": "Bearer organiser-token"},
    )

    assert response.status_code == 403
