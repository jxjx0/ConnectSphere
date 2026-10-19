"""Tests for saving, continuing and submitting draft event requests (T7-37)."""
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

import config
from models.event import Event, EventDraftRequest, EventStatus, EventSubmitRequest
from models.profile import Profile, Role
from services import auth_service, event_service
from services.auth_service import AuthError

DRAFT_ID = "44444444-4444-4444-4444-444444444444"

ORGANISER = Profile(
    id="11111111-1111-1111-1111-111111111111",
    full_name="Ada Tan",
    role=Role.ORGANISER,
)

COORDINATOR = Profile(
    id="22222222-2222-2222-2222-222222222222",
    full_name="Ben Lim",
    role=Role.COORDINATOR,
)

ORGANISER_HEADERS = {"Authorization": "Bearer organiser-token"}


def _in_days(days: int, hours: int = 0) -> str:
    """An ISO timestamp relative to now, so tests never age out."""
    moment = datetime.now(timezone.utc) + timedelta(days=days, hours=hours)
    return moment.isoformat()


def complete_event() -> dict:
    return {
        "name": "Annual Client Summit",
        "description": "A full-day summit for our regional clients.",
        "purpose": "Client relationship building",
        "category": "conference",
        "start_time": _in_days(30),
        "end_time": _in_days(30, hours=8),
        "expected_attendance": 120,
    }


# A draft as the database returns it: only the name filled in.
DRAFT_ROW = {
    "id": DRAFT_ID,
    "organiser_id": ORGANISER.id,
    "name": "Summit (half done)",
    "status": "draft",
}

UNDER_REVIEW_ROW = {
    "id": DRAFT_ID,
    "organiser_id": ORGANISER.id,
    "status": "under_review",
    **complete_event(),
}


def authenticate_as(monkeypatch, profile: Profile) -> None:
    """Replace token verification and profile lookup for an isolated route test."""
    monkeypatch.setattr(
        auth_service, "get_user_id", lambda access_token: profile.id
    )
    monkeypatch.setattr(
        auth_service, "get_profile", lambda access_token, user_id: profile
    )


class FakeQuery:
    """Records what a service asked the events table for, then returns rows."""

    def __init__(self, rows, calls):
        self._rows = rows
        self._calls = calls

    def select(self, *args):
        return self

    def insert(self, row):
        self._calls.append(("insert", row))
        return self

    def update(self, values):
        self._calls.append(("update", values))
        return self

    def delete(self):
        self._calls.append(("delete",))
        return self

    def eq(self, column, value):
        self._calls.append(("eq", column, value))
        return self

    def execute(self):
        return SimpleNamespace(data=self._rows)


def fake_events_table(monkeypatch, rows):
    """Point the service at a fake events table; return the recorded calls."""
    calls = []
    monkeypatch.setattr(
        config,
        "get_user_client",
        lambda access_token: SimpleNamespace(
            table=lambda name: FakeQuery(rows, calls)
        ),
    )
    return calls


def call_named(calls, name):
    return next(call for call in calls if call[0] == name)


# --- Model validation ------------------------------------------------------


def test_a_draft_needs_only_a_name():
    draft = EventDraftRequest(name="Summit")

    assert draft.start_time is None
    assert draft.expected_attendance is None


def test_a_draft_without_a_name_is_rejected():
    with pytest.raises(ValidationError):
        EventDraftRequest(name="   ")


def test_what_a_draft_fills_in_is_still_checked():
    with pytest.raises(ValidationError) as caught:
        EventDraftRequest(
            name="Summit", start_time=_in_days(5), end_time=_in_days(4)
        )

    assert "End time must be after the start time" in str(caught.value)


# --- Service ---------------------------------------------------------------


def test_creating_a_draft_sets_the_organiser_and_status_itself(monkeypatch):
    calls = fake_events_table(monkeypatch, [DRAFT_ROW])

    event_service.create_draft(
        "organiser-token", ORGANISER.id, EventDraftRequest(name="Summit")
    )

    inserted = call_named(calls, "insert")[1]
    assert inserted["organiser_id"] == ORGANISER.id
    assert inserted["status"] == "draft"


def test_submitting_changes_only_my_draft_to_under_review(monkeypatch):
    calls = fake_events_table(monkeypatch, [UNDER_REVIEW_ROW])

    event = event_service.submit_draft(
        "organiser-token",
        ORGANISER.id,
        DRAFT_ID,
        EventSubmitRequest(**complete_event()),
    )

    assert call_named(calls, "update")[1]["status"] == "under_review"
    assert ("eq", "organiser_id", ORGANISER.id) in calls
    assert ("eq", "status", "draft") in calls
    assert event.status is EventStatus.UNDER_REVIEW


def test_deleting_touches_only_my_draft(monkeypatch):
    calls = fake_events_table(monkeypatch, [DRAFT_ROW])

    event_service.delete_draft("organiser-token", ORGANISER.id, DRAFT_ID)

    assert ("eq", "organiser_id", ORGANISER.id) in calls
    assert ("eq", "status", "draft") in calls


def test_a_draft_that_is_not_mine_is_not_found(monkeypatch):
    """The filters match no row; the service must answer 404, not leak it."""
    fake_events_table(monkeypatch, [])

    with pytest.raises(AuthError) as caught:
        event_service.get_my_draft("organiser-token", ORGANISER.id, DRAFT_ID)

    assert caught.value.status_code == 404


# --- Routes ----------------------------------------------------------------


def test_organiser_can_save_a_draft_with_only_a_name(client, monkeypatch):
    authenticate_as(monkeypatch, ORGANISER)
    monkeypatch.setattr(
        event_service,
        "create_draft",
        lambda access_token, organiser_id, request: Event(**DRAFT_ROW),
    )

    response = client.post(
        "/events/drafts",
        json={"name": "Summit (half done)"},
        headers=ORGANISER_HEADERS,
    )

    assert response.status_code == 201
    assert response.get_json()["event"]["status"] == "draft"


def test_organiser_can_list_their_drafts(client, monkeypatch):
    """Also shows /events/drafts is not mistaken for /events/<event_id>."""
    authenticate_as(monkeypatch, ORGANISER)
    monkeypatch.setattr(
        event_service,
        "list_my_drafts",
        lambda access_token, organiser_id: [Event(**DRAFT_ROW)],
    )

    response = client.get("/events/drafts", headers=ORGANISER_HEADERS)

    assert response.status_code == 200
    assert response.get_json()["events"][0]["id"] == DRAFT_ID


def test_an_incomplete_draft_cannot_be_submitted(client, monkeypatch):
    authenticate_as(monkeypatch, ORGANISER)

    def submit_draft(access_token, organiser_id, draft_id, request):
        raise AssertionError("the service must not be reached")

    monkeypatch.setattr(event_service, "submit_draft", submit_draft)

    response = client.post(
        f"/events/drafts/{DRAFT_ID}/submit",
        json={"name": "Summit (half done)"},
        headers=ORGANISER_HEADERS,
    )

    assert response.status_code == 400


def test_non_organisers_cannot_use_drafts(client, monkeypatch):
    authenticate_as(monkeypatch, COORDINATOR)

    response = client.get(
        "/events/drafts",
        headers={"Authorization": "Bearer coordinator-token"},
    )

    assert response.status_code == 403


def test_drafts_require_a_token(client):
    assert client.get("/events/drafts").status_code == 401
