"""Tests for submitting an event request (T7-45)."""

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

import config
from models.event import Event, EventStatus, EventSubmitRequest
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
        "category": "Conference",
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


@pytest.mark.parametrize("field", ["name", "description", "purpose", "category"])
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

