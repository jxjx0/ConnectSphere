"""Name-only enrichment of Venue Staff's existing pending-booking response."""

from copy import deepcopy
from unittest.mock import Mock

import pytest
from httpx import ReadTimeout
from postgrest import APIError

import config
from fake_supabase import FakeDatabase
from models.profile import Profile, Role
from services import auth_service, venue_booking_service
from services.venue_booking_service import get_pending_venue_bookings


RPC = ("rpc:get_venue_booking_event_names", "rpc")


@pytest.fixture
def database(monkeypatch):
    db = FakeDatabase({
        ("venue_bookings", "select"): [
            {"booking_id": "bk-1", "event_id": "ev-1", "events": None, "session_id": "ss-1", "session": None,
             "status": "PENDING_VENUE_APPROVAL", "venues": {"name": "Hall"}},
            {"booking_id": "bk-2", "event_id": "ev-2", "events": {"expected_attendance": 40},
             "session_id": "ss-2", "session": {"expected_attendance": 30}},
        ],
        RPC: [{"booking_id": "bk-2", "event_name": "Annual dinner", "session_name": "Dinner"},
              {"booking_id": "bk-1", "event_name": "Tech conference", "session_name": "Opening session"}],
    })
    tokens = []
    monkeypatch.setattr(config, "get_user_client", lambda token: tokens.append(token) or db.client)
    db.tokens = tokens
    return db


def test_names_are_batched_and_joined_by_booking_without_changing_other_fields(database):
    original = deepcopy(database.responses[("venue_bookings", "select")])
    rows = get_pending_venue_bookings("staff-token", venue_id="v-1")

    assert rows[0]["events"] == {"name": "Tech conference"}
    assert rows[1]["events"] == {"name": "Annual dinner", "expected_attendance": 40}
    assert rows[0]["session"] == {"name": "Opening session"}
    assert rows[1]["session"] == {"name": "Dinner", "expected_attendance": 30}
    assert rows[0]["venues"] == {"name": "Hall"}
    assert rows[0]["status"] == "PENDING_VENUE_APPROVAL"
    assert database.responses[("venue_bookings", "select")] == original
    assert database.tokens == ["staff-token"]
    (rpc,) = database.calls_to(*RPC)
    assert rpc.payload == {"p_booking_ids": ["bk-1", "bk-2"]}
    (query,) = database.calls_to("venue_bookings", "select")
    assert ("eq", "venue_id", "v-1") in query.filters


@pytest.mark.parametrize("rows", [[], [
    {"booking_id": "known", "event_id": "ev-1", "events": {"name": "Existing"},
     "session_id": "ss-1", "session": {"name": "Visible session"}},
    {"booking_id": "legacy", "event_id": None, "events": None},
]])
def test_no_lookup_for_empty_legacy_or_already_named_bookings(database, rows):
    database.responses[("venue_bookings", "select")] = rows
    assert get_pending_venue_bookings("token") == rows
    assert database.calls_to(*RPC) == []


def test_only_missing_names_are_requested_and_absent_links_remain_unchanged(database):
    rows = database.responses[("venue_bookings", "select")]
    rows[0]["events"] = {"name": "Already visible"}
    rows[0]["session"] = {"name": "Already visible session"}
    database.responses[RPC] = []  # Deleted event or booking processed during lookup.
    assert get_pending_venue_bookings("token") == rows
    assert database.calls_to(*RPC)[0].payload == {"p_booking_ids": ["bk-2"]}


def test_lookup_still_runs_when_only_the_session_name_is_missing(database):
    rows = database.responses[("venue_bookings", "select")]
    rows[0]["events"] = {"name": "Tech conference"}
    rows[1]["events"]["name"] = "Annual dinner"
    assert get_pending_venue_bookings("token")[0]["session"]["name"] == "Opening session"
    assert database.calls_to(*RPC)[0].payload == {"p_booking_ids": ["bk-1", "bk-2"]}


def test_null_session_name_does_not_invent_a_session_or_erase_existing_fields(database):
    for names in database.responses[RPC]:
        names["session_name"] = None
    rows = get_pending_venue_bookings("token")
    assert rows[0]["events"]["name"] == "Tech conference"
    assert rows[0]["session"] is None
    assert rows[1]["session"] == {"expected_attendance": 30}


def test_existing_list_still_loads_before_local_migration_is_applied(database):
    database.responses[RPC] = APIError({"code": "PGRST202", "message": "Function not found"})
    assert get_pending_venue_bookings("token") == database.responses[("venue_bookings", "select")]


@pytest.mark.parametrize("response", [
    APIError({"code": "42501", "message": "Forbidden"}),
    ReadTimeout("Timed out"),
    None,
    [{"booking_id": "not-requested", "event_name": "Private event"}],
    [{"booking_id": "bk-1", "event_name": None}],
    [{"booking_id": "bk-1", "event_name": "Old RPC without session projection"}],
    [{"booking_id": "bk-1", "event_name": "Event", "session_name": 42}],
    [{"booking_id": "bk-1", "event_name": "Event", "session_name": ""}],
    [{"booking_id": "bk-1", "event_name": "Event", "session_name": None}] * 2,
])
def test_lookup_failure_preserves_existing_list_and_logs_no_private_names(database, response, caplog):
    database.responses[RPC] = response
    assert get_pending_venue_bookings("token") == database.responses[("venue_bookings", "select")]
    assert "Booking name lookup unavailable" in caplog.text
    assert "Private event" not in caplog.text


def authenticate(monkeypatch, role):
    profile = Profile(id="00000000-0000-0000-0000-000000000001", full_name="Test user", role=role)
    monkeypatch.setattr(auth_service, "get_user_id", lambda token: profile.id)
    monkeypatch.setattr(auth_service, "get_profile", lambda token, user_id: profile)


def test_pending_api_preserves_envelope_and_nested_name_fields(client, monkeypatch, database):
    authenticate(monkeypatch, Role.VENUE_STAFF)
    response = client.get("/venues/bookings/pending", headers={"Authorization": "Bearer staff-token"})
    assert response.status_code == 200
    assert set(response.get_json()) == {"bookings"}
    assert response.get_json()["bookings"][0]["events"] == {"name": "Tech conference"}
    assert response.get_json()["bookings"][0]["session"] == {"name": "Opening session"}


@pytest.mark.parametrize("role", [role for role in Role if role != Role.VENUE_STAFF])
def test_pending_api_still_denies_all_other_roles_before_any_lookup(client, monkeypatch, role):
    authenticate(monkeypatch, role)
    lookup = Mock()
    monkeypatch.setattr(venue_booking_service, "get_pending_venue_bookings", lookup)
    response = client.get("/venues/bookings/pending", headers={"Authorization": "Bearer other-token"})
    assert response.status_code == 403
    lookup.assert_not_called()
