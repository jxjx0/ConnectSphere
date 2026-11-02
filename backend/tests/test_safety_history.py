"""Tests for the Safety Officer's history, routes and remaining service paths."""

from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from postgrest import APIError as PostgrestAPIError

from models.profile import Profile, Role
from routes import events as event_routes
from services import auth_service, safety_review_service
from services.auth_service import AuthError


SAFETY_OFFICER = Profile(id="officer-1", full_name="Safety Officer", role=Role.SAFETY_OFFICER)
COORDINATOR = Profile(id="coordinator-1", full_name="Coordinator", role=Role.COORDINATOR)
HEADERS = {"Authorization": "Bearer token"}
EVENT_ID = "55555555-5555-5555-5555-555555555555"


def authenticate_as(monkeypatch, profile):
    monkeypatch.setattr(auth_service, "get_user_id", lambda token: profile.id)
    monkeypatch.setattr(auth_service, "get_profile", lambda token, user_id: profile)


def api_error():
    return PostgrestAPIError({"message": "DB Error", "code": "XX000", "details": None, "hint": None})


def chain(data=None, error=None):
    query = Mock()
    for method in ("select", "in_", "not_", "is_", "order", "eq"):
        getattr(query, method).return_value = query
    query.not_ = query
    query.is_.return_value = query
    if error:
        query.execute.side_effect = error
    else:
        query.execute.return_value = SimpleNamespace(data=data)
    return query


def database(monkeypatch, tables):
    client = Mock()
    client.table.side_effect = tables.__getitem__
    monkeypatch.setattr(safety_review_service, "_get_client", lambda access_token=None: client)
    return client


# --- History -----------------------------------------------------------------


def test_history_lists_decisions_and_events_that_ended_in_the_queue(monkeypatch):
    reviews = chain([{"id": "review-1", "decision": "APPROVED"}])
    events = chain([{"id": EVENT_ID, "status": "cancelled"}])
    database(monkeypatch, {"event_safety_reviews": reviews, "events": events})

    history = safety_review_service.get_safety_review_history("token")

    assert history == {
        "reviewed": [{"id": "review-1", "decision": "APPROVED"}],
        "expired": [{"id": EVENT_ID, "status": "cancelled"}],
    }
    reviews.order.assert_called_once_with("created_at", desc=True)
    events.in_.assert_called_once_with("status", ["cancelled", "rejected", "completed"])
    events.is_.assert_called_once_with("safety_check_requested_at", "null")
    events.order.assert_called_once_with("updated_at", desc=True)


def test_empty_history_is_two_empty_lists(monkeypatch):
    database(monkeypatch, {"event_safety_reviews": chain(None), "events": chain(None)})

    assert safety_review_service.get_safety_review_history("token") == {"reviewed": [], "expired": []}


@pytest.mark.parametrize(
    "error, status_code",
    [(api_error(), 400), (RuntimeError("boom"), 500)],
    ids=["database", "unexpected"],
)
def test_a_failed_history_load_is_reported(monkeypatch, error, status_code):
    database(monkeypatch, {"event_safety_reviews": chain(error=error), "events": chain([])})

    with pytest.raises(AuthError) as caught:
        safety_review_service.get_safety_review_history("token")

    assert caught.value.status_code == status_code


# --- Routes ------------------------------------------------------------------


ROUTES = [
    ("get", "/events/safety/queue", "get_safety_review_queue", [], {"queue": []}),
    ("get", "/events/safety/history", "get_safety_review_history", {"reviewed": [], "expired": []},
     {"reviewed": [], "expired": []}),
    ("get", f"/events/safety/review/{EVENT_ID}", "get_safety_event_details", {"event": {}}, {"event": {}}),
    ("post", f"/events/safety/review/{EVENT_ID}/decision", "submit_safety_decision", {"id": EVENT_ID},
     {"event": {"id": EVENT_ID}}),
]
ROUTE_IDS = ["queue", "history", "details", "decision"]


@pytest.mark.parametrize("method, url, service, result, expected", ROUTES, ids=ROUTE_IDS)
def test_safety_officers_can_use_safety_routes(client, monkeypatch, method, url, service, result, expected):
    authenticate_as(monkeypatch, SAFETY_OFFICER)
    monkeypatch.setattr(safety_review_service, service, Mock(return_value=result))

    response = getattr(client, method)(url, headers=HEADERS)

    assert response.status_code == 200
    assert response.get_json() == expected


@pytest.mark.parametrize("method, url, service, result, expected", ROUTES, ids=ROUTE_IDS)
def test_only_safety_officers_can_use_safety_routes(client, monkeypatch, method, url, service, result, expected):
    authenticate_as(monkeypatch, COORDINATOR)
    monkeypatch.setattr(
        safety_review_service, service, Mock(side_effect=AssertionError("must not reach the service"))
    )

    assert getattr(client, method)(url, headers=HEADERS).status_code == 403


@pytest.mark.parametrize("method, url, service, result, expected", ROUTES, ids=ROUTE_IDS)
def test_safety_route_errors_are_reported(client, monkeypatch, method, url, service, result, expected):
    authenticate_as(monkeypatch, SAFETY_OFFICER)
    monkeypatch.setattr(safety_review_service, service, Mock(side_effect=AuthError("Refused", status_code=409)))
    assert getattr(client, method)(url, headers=HEADERS).get_json() == {"error": "Refused"}

    monkeypatch.setattr(safety_review_service, service, Mock(side_effect=RuntimeError("private detail")))
    response = getattr(client, method)(url, headers=HEADERS)
    assert response.status_code == 500
    assert "private detail" not in response.get_data(as_text=True)


def test_a_decision_passes_on_what_the_officer_entered(client, monkeypatch):
    authenticate_as(monkeypatch, SAFETY_OFFICER)
    submit = Mock(return_value={"id": EVENT_ID})
    monkeypatch.setattr(safety_review_service, "submit_safety_decision", submit)

    client.post(
        f"/events/safety/review/{EVENT_ID}/decision",
        json={"decision": "rejected", "notes": "Noted", "reason": "Blocked exit"},
        headers=HEADERS,
    )

    assert submit.call_args.kwargs == {
        "event_id": EVENT_ID,
        "safety_officer_id": SAFETY_OFFICER.id,
        "decision": "rejected",
        "notes": "Noted",
        "rejection_or_change_reason": "Blocked exit",
        "access_token": "token",
    }


def test_coordinators_can_request_a_safety_check(client, monkeypatch):
    authenticate_as(monkeypatch, COORDINATOR)
    monkeypatch.setattr(safety_review_service, "request_safety_check", Mock(return_value={"id": EVENT_ID}))

    response = client.post(f"/events/{EVENT_ID}/request-safety-check", headers=HEADERS)

    assert response.status_code == 200


def test_only_coordinators_can_request_a_safety_check(client, monkeypatch):
    authenticate_as(monkeypatch, SAFETY_OFFICER)
    monkeypatch.setattr(
        safety_review_service, "request_safety_check", Mock(side_effect=AssertionError("must not reach the service"))
    )

    assert client.post(f"/events/{EVENT_ID}/request-safety-check", headers=HEADERS).status_code == 403


def test_a_failed_safety_check_request_is_reported(client, monkeypatch):
    authenticate_as(monkeypatch, COORDINATOR)
    monkeypatch.setattr(safety_review_service, "request_safety_check", Mock(side_effect=RuntimeError("private detail")))

    response = client.post(f"/events/{EVENT_ID}/request-safety-check", headers=HEADERS)

    assert response.status_code == 500
    assert "private detail" not in response.get_data(as_text=True)


# --- Remaining service paths -------------------------------------------------


def test_unreadable_layouts_have_no_capacity():
    assert safety_review_service._layout_capacity({"layouts": "Theatre"}, "Theatre") == 0
    assert safety_review_service._layout_capacity({"layouts": [{"name": "Theatre"}]}, None) == 0


def test_layouts_saved_as_a_mapping_still_give_a_capacity():
    assert safety_review_service._layout_capacity({"layouts": {"Theatre": 80}}, "theatre") == 80


def _flags(booking, attendance=10, accessibility=""):
    return safety_review_service._venue_flags(booking, {"name": "Main"}, attendance, accessibility)


def test_a_booking_with_unreadable_venue_details_does_not_crash():
    assert _flags({"venue": "not a venue"}) == []


def test_a_booking_outside_operating_hours_is_flagged():
    flags = _flags({
        "venue": {"name": "Hall", "operating_hours": {"open": "09:00", "close": "10:00"}},
        "start_at": "2099-11-13T20:00:00+08:00",
        "end_at": "2099-11-13T22:00:00+08:00",
    })

    assert [flag["type"] for flag in flags] == ["OPERATING_HOURS_VIOLATION"]
    assert "20:00 - 22:00" in flags[0]["message"]
    assert "09:00 - 10:00" in flags[0]["message"]


def test_a_booking_within_operating_hours_is_not_flagged():
    assert _flags({
        "venue": {"name": "Hall", "operating_hours": {"open": "09:00", "close": "23:00"}},
        "start_at": "2099-11-13T20:00:00+08:00",
        "end_at": "2099-11-13T22:00:00+08:00",
    }) == []


def test_unreadable_booking_times_do_not_crash_the_hours_check():
    assert _flags({
        "venue": {"name": "Hall", "operating_hours": {"open": "09:00", "close": "10:00"}},
        "start_at": "not a time",
        "end_at": "not a time",
    }) == []


def _waiting_event_database(monkeypatch, insert_error=None, open_requests=False):
    client = Mock()
    client.table.return_value = chain([{
        "id": EVENT_ID, "name": "Gala", "status": "awaiting_safety_check", "coordinator_id": None,
    }])
    if insert_error:
        client.table.return_value.insert.side_effect = insert_error
    client.rpc.return_value.execute.return_value = SimpleNamespace(data=open_requests)
    monkeypatch.setattr(safety_review_service, "_get_client", lambda access_token=None: client)
    return client


def _decide(decision="approved"):
    return safety_review_service.submit_safety_decision(EVENT_ID, "officer-1", decision, "", "Reason")


def test_approval_waits_for_open_requests(monkeypatch):
    _waiting_event_database(monkeypatch, open_requests=True)

    with pytest.raises(AuthError) as caught:
        _decide()

    assert caught.value.status_code == 409
    assert "open clarification" in caught.value.message


def test_an_unexpected_decision_failure_is_reported(monkeypatch):
    _waiting_event_database(monkeypatch, insert_error=RuntimeError("boom"))

    with pytest.raises(AuthError) as caught:
        _decide()

    assert caught.value.status_code == 500


def test_a_database_decision_failure_is_reported(monkeypatch):
    _waiting_event_database(monkeypatch, insert_error=api_error())

    with pytest.raises(AuthError) as caught:
        _decide()

    assert caught.value.status_code == 400
