"""Tests for saving, continuing and submitting draft event requests (T7-37)."""
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from postgrest import APIError as PostgrestAPIError
from pydantic import ValidationError

import config
from models.event import Event, EventDraftRequest, EventStatus, EventSubmitRequest
from models.profile import Profile, Role
from services import auth_service, event_service
from services.auth_service import AuthError
from fake_supabase import FakeDatabase

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
    """A request body for submitting a draft: the event and its sessions."""
    return {
        "name": "Annual Client Summit",
        "description": "A full-day summit for our regional clients.",
        "purpose": "Client relationship building",
        "category": "conference",
        "sessions": [
            {
                "name": "Main programme",
                "start_time": _in_days(30),
                "end_time": _in_days(30, hours=8),
                "expected_attendance": 120,
            }
        ],
    }


def complete_event_row() -> dict:
    """A submitted events row; the database fills the times from the sessions."""
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
    **complete_event_row(),
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




# --- Model validation ------------------------------------------------------


def test_a_draft_needs_only_a_name():
    draft = EventDraftRequest(name="Summit")

    assert draft.sessions == []
    assert draft.description is None


def test_a_draft_without_a_name_is_rejected():
    with pytest.raises(ValidationError):
        EventDraftRequest(name="   ")


def test_a_draft_session_may_be_half_filled_in():
    """Untouched inputs arrive as "" and mean not filled in yet."""
    draft = EventDraftRequest(
        name="Summit",
        sessions=[{"name": "", "start_time": _in_days(5), "end_time": "",
                   "expected_attendance": ""}],
    )

    session = draft.sessions[0]
    assert session.name is None
    assert session.end_time is None
    assert session.expected_attendance is None


def test_what_a_draft_session_fills_in_is_still_checked():
    with pytest.raises(ValidationError) as caught:
        EventDraftRequest(
            name="Summit",
            sessions=[{"name": "Breakout A", "start_time": _in_days(5),
                       "end_time": _in_days(4)}],
        )

    assert "Breakout A: End time must be after the start time" in str(
        caught.value
    )


def test_a_draft_session_in_the_past_can_still_be_saved():
    """"Must be in the future" is checked on submit, not while drafting."""
    draft = EventDraftRequest(
        name="Summit",
        sessions=[{"name": "Kick-off", "start_time": _in_days(-3),
                   "end_time": _in_days(-3, hours=2)}],
    )

    assert draft.sessions[0].name == "Kick-off"


# --- Service ---------------------------------------------------------------


def saved_session_rows(query) -> list[dict]:
    """What replace_draft_sessions returns for the sessions it was given."""
    return [
        {"id": f"session-{index}", "event_id": query.payload["p_event_id"], **session}
        for index, session in enumerate(query.payload["p_sessions"])
    ]


def draft_database(monkeypatch, responses) -> FakeDatabase:
    database = FakeDatabase(
        {("rpc:replace_draft_sessions", "rpc"): saved_session_rows, **responses}
    )
    monkeypatch.setattr(
        config, "get_user_client", lambda access_token: database.client
    )
    return database


def test_creating_a_draft_sets_the_organiser_and_status_itself(monkeypatch):
    database = draft_database(monkeypatch, {("events", "insert"): [DRAFT_ROW]})

    event_service.create_draft(
        "organiser-token", ORGANISER.id, EventDraftRequest(name="Summit")
    )

    inserted = database.calls_to("events", "insert")[0].payload
    assert inserted["organiser_id"] == ORGANISER.id
    assert inserted["status"] == "draft"
    assert "sessions" not in inserted


def test_creating_a_draft_saves_its_sessions(monkeypatch):
    database = draft_database(monkeypatch, {("events", "insert"): [DRAFT_ROW]})
    request = EventDraftRequest(
        name="Summit",
        sessions=[{"name": "Main programme"}, {"name": "Breakout A"}],
    )

    draft = event_service.create_draft("organiser-token", ORGANISER.id, request)

    saved = database.calls_to("rpc:replace_draft_sessions", "rpc")[0].payload
    assert saved["p_event_id"] == DRAFT_ID
    assert [session["name"] for session in saved["p_sessions"]] == [
        "Main programme",
        "Breakout A",
    ]
    assert [session.name for session in draft.sessions] == [
        "Main programme",
        "Breakout A",
    ]


def test_a_draft_whose_sessions_fail_to_save_is_removed(monkeypatch):
    """Otherwise the form, which never got the id, would create a duplicate."""
    database = draft_database(monkeypatch, {
        ("events", "insert"): [DRAFT_ROW],
        ("rpc:replace_draft_sessions", "rpc"): PostgrestAPIError(
            {"message": "boom", "code": "XX000"}
        ),
    })

    with pytest.raises(AuthError):
        event_service.create_draft(
            "organiser-token",
            ORGANISER.id,
            EventDraftRequest(name="Summit", sessions=[{"name": "Main"}]),
        )

    deleted = database.calls_to("events", "delete")
    assert len(deleted) == 1
    assert ("eq", "status", "draft") in deleted[0].filters


def test_updating_a_draft_replaces_its_sessions(monkeypatch):
    """A session removed in the form is removed from the draft too."""
    database = draft_database(monkeypatch, {("events", "update"): [DRAFT_ROW]})

    draft = event_service.update_draft(
        "organiser-token",
        ORGANISER.id,
        DRAFT_ID,
        EventDraftRequest(name="Summit", sessions=[{"name": "Only one left"}]),
    )

    update = database.calls_to("events", "update")[0]
    assert "sessions" not in update.payload
    assert ("eq", "status", "draft") in update.filters
    saved = database.calls_to("rpc:replace_draft_sessions", "rpc")[0].payload
    assert [session["name"] for session in saved["p_sessions"]] == [
        "Only one left"
    ]
    assert [session.name for session in draft.sessions] == ["Only one left"]


def test_opening_a_draft_returns_its_sessions_in_time_order(monkeypatch):
    database = draft_database(monkeypatch, {
        ("events", "select"): [DRAFT_ROW],
        ("event_sessions", "select"): [
            {"id": "session-1", "event_id": DRAFT_ID, "name": "Morning"},
        ],
    })

    draft = event_service.get_my_draft("organiser-token", ORGANISER.id, DRAFT_ID)

    read = database.calls_to("event_sessions", "select")[0]
    assert ("eq", "event_id", DRAFT_ID) in read.filters
    assert read.filters[1:] == [("order", "start_time"), ("order", "created_at")]
    assert [session.name for session in draft.sessions] == ["Morning"]


def test_submitting_saves_the_sessions_then_changes_only_my_draft(monkeypatch):
    database = FakeDatabase({
        ("rpc:replace_draft_sessions", "rpc"): lambda query: [
            {"id": "session-1", "event_id": DRAFT_ID, **session}
            for session in query.payload["p_sessions"]
        ],
        ("events", "update"): [UNDER_REVIEW_ROW],
    })
    monkeypatch.setattr(
        config, "get_user_client", lambda access_token: database.client
    )

    event = event_service.submit_draft(
        "organiser-token",
        ORGANISER.id,
        DRAFT_ID,
        EventSubmitRequest(**complete_event()),
    )

    saved, update = database.calls
    assert (saved.table, saved.payload["p_event_id"]) == (
        "rpc:replace_draft_sessions",
        DRAFT_ID,
    )
    assert update.payload["status"] == "under_review"
    assert "sessions" not in update.payload
    assert ("eq", "organiser_id", ORGANISER.id) in update.filters
    assert ("eq", "status", "draft") in update.filters
    assert event.status is EventStatus.UNDER_REVIEW
    assert [session.name for session in event.sessions] == ["Main programme"]


def test_sessions_for_someone_elses_draft_are_not_found(monkeypatch):
    """Row-level security refuses the sessions; answer 404 like any missing draft."""
    database = FakeDatabase({
        ("rpc:replace_draft_sessions", "rpc"): PostgrestAPIError(
            {"message": "new row violates row-level security", "code": "42501"}
        ),
    })
    monkeypatch.setattr(
        config, "get_user_client", lambda access_token: database.client
    )

    with pytest.raises(AuthError) as caught:
        event_service.submit_draft(
            "organiser-token",
            ORGANISER.id,
            DRAFT_ID,
            EventSubmitRequest(**complete_event()),
        )

    assert caught.value.status_code == 404
    assert database.calls_to("events", "update") == []


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
