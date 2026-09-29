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
