"""Tests for submitting an event request (T7-45)."""

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

import config
from models.event import Event, EventCategory, EventStatus, EventSubmitRequest
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
    status=EventStatus.SUBMITTED,
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
    assert captured["status"] == "submitted"
    assert event.status is EventStatus.SUBMITTED


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
    assert response.get_json()["event"]["status"] == "submitted"


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

    def order(self, column):
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


# --- Reviewing assigned submitted requests --------------------------------


def test_coordinator_list_includes_assigned_under_review_requests(monkeypatch):
    calls = []
    assigned = EVENT_RESPONSE.model_dump(mode="json")
    assigned["coordinator_id"] = COORDINATOR_PROFILE.id
    assigned["status"] = EventStatus.UNDER_REVIEW.value
    fake_client(monkeypatch, {"events": [assigned]}, calls)

    events = event_service.list_assigned_submitted_events(
        "coordinator-token", COORDINATOR_PROFILE.id
    )

    assert ("eq", "coordinator_id", COORDINATOR_PROFILE.id) in calls
    assert (
        "in",
        "status",
        (EventStatus.SUBMITTED.value, EventStatus.UNDER_REVIEW.value),
    ) in calls
    assert ("order", "start_time") in calls
    assert events[0].name == "Annual Client Summit"
    assert events[0].status is EventStatus.UNDER_REVIEW


def test_coordinator_detail_filters_by_id_assignment_and_review_status(monkeypatch):
    calls = []
    assigned = EVENT_RESPONSE.model_dump(mode="json")
    assigned["coordinator_id"] = COORDINATOR_PROFILE.id
    fake_client(monkeypatch, {"events": [assigned]}, calls)

    event = event_service.get_assigned_submitted_event(
        "coordinator-token", COORDINATOR_PROFILE.id, EVENT_RESPONSE.id
    )

    assert ("eq", "id", EVENT_RESPONSE.id) in calls
    assert ("eq", "coordinator_id", COORDINATOR_PROFILE.id) in calls
    assert (
        "in",
        "status",
        (EventStatus.SUBMITTED.value, EventStatus.UNDER_REVIEW.value),
    ) in calls
    assert event.purpose == "Client relationship building"
    assert event.start_time is not None and event.end_time is not None
    assert event.expected_attendance == 120
    assert event.layout_preference == "Theatre"
    assert event.equipment_requirements == "Two projectors and four handheld mics"
    assert event.accessibility_requirements == "Step-free access to the stage"


def test_unassigned_or_non_reviewable_event_is_not_found_for_coordinator(
    monkeypatch,
):
    fake_client(monkeypatch, {"events": []}, [])

    with pytest.raises(AuthError) as caught:
        event_service.get_assigned_submitted_event(
            "coordinator-token", COORDINATOR_PROFILE.id, EVENT_RESPONSE.id
        )

    assert caught.value.status_code == 404


@pytest.mark.parametrize(
    ("decision", "expected_status"),
    [
        (EventStatus.APPROVED, EventStatus.APPROVED),
        (EventStatus.REJECTED, EventStatus.REJECTED),
    ],
)
def test_coordinator_decision_updates_only_assigned_submitted_event(
    monkeypatch, decision, expected_status
):
    calls = []
    updated = EVENT_RESPONSE.model_copy(
        update={
            "coordinator_id": COORDINATOR_PROFILE.id,
            "status": expected_status,
        }
    )

    class UpdateQuery(FakeQuery):
        def update(self, values):
            calls.append(("update", values))
            return self

        def select(self, *args):
            return self

    class Client:
        def table(self, name):
            assert name == "events"
            return UpdateQuery([updated.model_dump(mode="json")], calls)

    monkeypatch.setattr(config, "get_user_client", lambda token: Client())

    event = event_service.decide_assigned_event(
        "coordinator-token",
        COORDINATOR_PROFILE.id,
        EVENT_RESPONSE.id,
        decision,
    )

    assert ("update", {"status": expected_status.value}) in calls
    assert ("eq", "id", EVENT_RESPONSE.id) in calls
    assert ("eq", "coordinator_id", COORDINATOR_PROFILE.id) in calls
    assert (
        "in",
        "status",
        (EventStatus.SUBMITTED.value, EventStatus.UNDER_REVIEW.value),
    ) in calls
    assert event.status is expected_status


def test_coordinator_cannot_decide_missing_event(monkeypatch):
    fake_client(monkeypatch, {"events": []}, [])

    with pytest.raises(AuthError) as caught:
        event_service.decide_assigned_event(
            "coordinator-token",
            COORDINATOR_PROFILE.id,
            EVENT_RESPONSE.id,
            EventStatus.APPROVED,
        )

    assert caught.value.status_code == 404


def test_coordinator_documents_are_returned_as_signed_links(monkeypatch):
    calls = []
    event_row = {"id": EVENT_RESPONSE.id}
    document_row = {
        "id": "44444444-4444-4444-4444-444444444444",
        "file_name": "event-brief.pdf",
        "storage_path": f"{EVENT_RESPONSE.id}/event-brief.pdf",
        "created_at": "2026-01-01T00:00:00+00:00",
    }

    class StorageBucket:
        def create_signed_url(self, path, expires_in):
            calls.append(("sign", path, expires_in))
            return {"signedURL": "https://storage.example/signed/event-brief.pdf"}

    class Storage:
        def from_(self, bucket):
            calls.append(("bucket", bucket))
            return StorageBucket()

    class Client:
        storage = Storage()

        def table(self, name):
            rows = {
                "events": [event_row],
                "event_documents": [document_row],
            }.get(name, [])
            return FakeQuery(rows, calls)

    monkeypatch.setattr(config, "get_user_client", lambda token: Client())

    documents = event_service.list_assigned_event_documents(
        "coordinator-token", COORDINATOR_PROFILE.id, EVENT_RESPONSE.id
    )

    assert ("eq", "coordinator_id", COORDINATOR_PROFILE.id) in calls
    assert (
        "in",
        "status",
        (EventStatus.SUBMITTED.value, EventStatus.UNDER_REVIEW.value),
    ) in calls
    assert calls[-1] == (
        "sign",
        f"{EVENT_RESPONSE.id}/event-brief.pdf",
        3600,
    )
    assert documents == [
        {
            "id": document_row["id"],
            "file_name": "event-brief.pdf",
            "url": "https://storage.example/signed/event-brief.pdf",
            "created_at": document_row["created_at"],
        }
    ]


def test_document_read_errors_use_a_read_message():
    error = SimpleNamespace(code="PGRST205")

    translated = event_service._review_read_error(
        error, "supporting documents"
    )

    assert translated.status_code == 502
    assert translated.message == "Unable to load supporting documents."


def test_user_client_authenticates_storage_as_the_signed_in_user(monkeypatch):
    captured = {}

    class Options:
        headers = {"Authorization": "Bearer anonymous-key"}

    class Postgrest:
        def auth(self, token):
            captured["postgrest_token"] = token

    class Client:
        options = Options()
        postgrest = Postgrest()

    monkeypatch.setattr(config, "SUPABASE_URL", "https://supabase.example")
    monkeypatch.setattr(config, "SUPABASE_ANON_KEY", "anonymous-key")
    monkeypatch.setattr(config, "create_client", lambda url, key: Client())

    config.get_user_client("coordinator-token")

    assert Client.options.headers["Authorization"] == (
        "Bearer coordinator-token"
    )
    assert captured["postgrest_token"] == "coordinator-token"


def test_coordinator_can_list_assigned_submitted_requests(client, monkeypatch):
    authenticate_as(monkeypatch, COORDINATOR_PROFILE)
    monkeypatch.setattr(
        event_service,
        "list_assigned_submitted_events",
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

    monkeypatch.setattr(
        event_service, "list_assigned_submitted_events", list_events
    )

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

    monkeypatch.setattr(
        event_service, "get_assigned_submitted_event", get_event
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
    monkeypatch.setattr(
        event_service,
        "get_assigned_submitted_event",
        lambda *args: (_ for _ in ()).throw(
            AssertionError("the service must not be reached")
        ),
    )

    response = client.get(
        f"/events/review/{EVENT_RESPONSE.id}",
        headers={"Authorization": "Bearer organiser-token"},
    )

    assert response.status_code == 403


def test_coordinator_detail_and_documents_routes_return_requested_data(
    client, monkeypatch
):
    authenticate_as(monkeypatch, COORDINATOR_PROFILE)
    monkeypatch.setattr(
        event_service,
        "get_assigned_submitted_event",
        lambda access_token, coordinator_id, event_id: EVENT_RESPONSE,
    )
    monkeypatch.setattr(
        event_service,
        "list_assigned_event_documents",
        lambda access_token, coordinator_id, event_id: [
            {"id": "doc-1", "file_name": "brief.pdf", "url": "https://signed"}
        ],
    )

    headers = {"Authorization": "Bearer coordinator-token"}
    detail = client.get(f"/events/review/{EVENT_RESPONSE.id}", headers=headers)
    documents = client.get(
        f"/events/review/{EVENT_RESPONSE.id}/documents", headers=headers
    )

    assert detail.status_code == 200
    assert detail.get_json()["event"]["layout_preference"] == "Theatre"
    assert detail.get_json()["event"]["accessibility_requirements"]
    assert documents.status_code == 200
    assert documents.get_json()["documents"][0]["file_name"] == "brief.pdf"


def test_coordinator_can_approve_an_assigned_request(client, monkeypatch):
    authenticate_as(monkeypatch, COORDINATOR_PROFILE)
    approved = EVENT_RESPONSE.model_copy(
        update={
            "coordinator_id": COORDINATOR_PROFILE.id,
            "status": EventStatus.APPROVED,
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
        "status": EventStatus.APPROVED,
    }
    assert response.get_json()["event"]["status"] == "approved"


def test_non_coordinators_cannot_reject_review_requests(client, monkeypatch):
    authenticate_as(monkeypatch, ORGANISER_PROFILE)
    monkeypatch.setattr(
        event_service,
        "decide_assigned_event",
        lambda *args: (_ for _ in ()).throw(
            AssertionError("the service must not be reached")
        ),
    )

    response = client.post(
        f"/events/review/{EVENT_RESPONSE.id}/reject",
        headers={"Authorization": "Bearer organiser-token"},
    )

    assert response.status_code == 403
