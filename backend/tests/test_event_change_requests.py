"""Tests for an Organiser submitting an event change request."""

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from pydantic import ValidationError
from postgrest import APIError

import config
from models.event import (
    Event,
    EventChangeRequest,
    EventChangeRequestApproval,
    EventChangeRequestDecision,
    EventChangeRequestSubmit,
    EventStatus,
)
from models.profile import Profile, Role
from services import auth_service, event_service
from services.auth_service import AuthError

# Create reusable test data: EVENT_ID, ORGANISER_ID, ORGANISER PROFILE,
# COORDINATOR PROFILE, Valid_change_request() - valid set of event=change fields,
# _in_days() - generates future dates, authenticate_as() - mocks authentication to pretend to be organiser

EVENT_ID = "33333333-3333-3333-3333-333333333333"
ORGANISER_ID = "11111111-1111-1111-1111-111111111111"

ORGANISER = Profile(
    id=ORGANISER_ID,
    full_name="Ada Tan",
    role=Role.ORGANISER,
    contact_number="+65 9123 4567",
    organization="Northwind Pte Ltd",
)

COORDINATOR = Profile(
    id="22222222-2222-2222-2222-222222222222",
    full_name="Ben Lim",
    role=Role.COORDINATOR,
)


def _in_days(days: int, hours: int = 0) -> str:
    return (
        datetime.now(timezone.utc) + timedelta(days=days, hours=hours)
    ).isoformat()


MAIN_SESSION_ID = "55555555-5555-5555-5555-555555555555"


def valid_session(**overrides) -> dict:
    return {
        "session_id": MAIN_SESSION_ID,
        "name": "Main programme",
        "start_time": _in_days(30),
        "end_time": _in_days(30, hours=8),
        "expected_attendance": 120,
        "location_preference": "Central",
        "layout_preference": "Theatre",
        "equipment_requirements": None,
        **overrides,
    }


def valid_change_request() -> dict:
    return {
        "name": "Annual Client Summit",
        "description": "A full-day summit for our regional clients.",
        "reason_for_change": "The venue can only host us on the revised date.",
        "purpose": "Client relationship building",
        "category": "conference",
        "category_other": None,
        "accessibility_requirements": None,
        "sessions": [valid_session()],
    }


def authenticate_as(monkeypatch, profile: Profile) -> None:
    monkeypatch.setattr(
        auth_service, "get_user_id", lambda access_token: profile.id
    )
    monkeypatch.setattr(
        auth_service, "get_profile", lambda access_token, user_id: profile
    )


class FakeQuery:
    """Small PostgREST query fake that records the filters used by a service."""

    def __init__(self, rows, calls):
        self.rows = rows
        self.calls = calls

    def select(self, *columns):
        self.calls.append(("select", columns))
        return self

    def eq(self, column, value):
        self.calls.append(("eq", column, value))
        return self

    def neq(self, column, value):
        self.calls.append(("neq", column, value))
        return self

    def in_(self, column, values):
        self.calls.append(("in", column, tuple(values)))
        return self

    def order(self, column, desc=False):
        self.calls.append(("order", column, desc))
        return self

    def execute(self):
        return SimpleNamespace(data=self.rows)


def _event_row(status="under_review") -> dict:
    return Event(
        id=EVENT_ID,
        organiser_id=ORGANISER_ID,
        status=status,
        name="Annual Client Summit",
        description="A full-day summit for our regional clients.",
        purpose="Client relationship building",
        category="conference",
        start_time=_in_days(30),
        end_time=_in_days(30, hours=8),
        expected_attendance=120,
    ).model_dump(mode="json")


def _change_request_row(status="pending") -> dict:
    session = valid_session()
    return EventChangeRequest(
        id="44444444-4444-4444-4444-444444444444",
        event_id=EVENT_ID,
        organiser_id=ORGANISER_ID,
        event_status_before_request="under_review",
        status=status,
        created_at=_in_days(-1),
        rejection_reason="The revised date conflicts with the venue booking."
        if status == "rejected"
        else None,
        name="Annual Client Summit",
        description="A full-day summit for our regional clients.",
        reason_for_change="The venue can only host us on the revised date.",
        purpose="Client relationship building",
        category="conference",
        start_time=session["start_time"],
        end_time=session["end_time"],
        expected_attendance=session["expected_attendance"],
        sessions=[{"id": "66666666-6666-6666-6666-666666666666", **session}],
    ).model_dump(mode="json")


# Model validation ---------------------------------------------------------

def test_valid_change_request_keeps_reason_and_sessions():
    request = EventChangeRequestSubmit(**valid_change_request())

    assert request.reason_for_change.startswith("The venue")
    assert request.accessibility_requirements is None
    assert [session.session_id for session in request.sessions] == [MAIN_SESSION_ID]

# Tests that name, description, purpose and reason for change cannot
# just contain spaces.
@pytest.mark.parametrize("field", ["name", "description", "purpose", "reason_for_change"])
def test_required_text_fields_reject_blank_values(field):
    payload = valid_change_request()
    payload[field] = "   "

    with pytest.raises(ValidationError):
        EventChangeRequestSubmit(**payload)


def test_blank_optional_text_means_none():
    payload = valid_change_request()
    payload["accessibility_requirements"] = "   "
    payload["sessions"] = [valid_session(location_preference=" ", layout_preference="")]

    request = EventChangeRequestSubmit(**payload)

    assert request.accessibility_requirements is None
    assert request.sessions[0].location_preference is None
    assert request.sessions[0].layout_preference is None


# --- Sessions (T7-280) -----------------------------------------------------

def test_a_change_request_keeps_at_least_one_session():
    payload = valid_change_request()
    payload["sessions"] = []

    with pytest.raises(ValidationError, match="Keep at least one session"):
        EventChangeRequestSubmit(**payload)


def test_a_session_cannot_be_listed_twice():
    payload = valid_change_request()
    payload["sessions"] = [valid_session(), valid_session(name="Copy")]

    with pytest.raises(ValidationError, match="only be listed once"):
        EventChangeRequestSubmit(**payload)


def test_new_sessions_can_be_added_alongside_kept_ones():
    payload = valid_change_request()
    payload["sessions"] = [
        valid_session(),
        valid_session(session_id=None, name="Breakout A", expected_attendance=40),
        valid_session(session_id=None, name="Breakout B", expected_attendance=40),
    ]

    request = EventChangeRequestSubmit(**payload)

    assert [session.session_id for session in request.sessions] == [MAIN_SESSION_ID, None, None]


def test_a_session_must_end_after_it_starts():
    payload = valid_change_request()
    payload["sessions"] = [valid_session(end_time=_in_days(29))]

    with pytest.raises(ValidationError, match="Main programme: End time must be after the start time"):
        EventChangeRequestSubmit(**payload)


def test_a_new_session_must_start_in_the_future():
    payload = valid_change_request()
    payload["sessions"] = [valid_session(session_id=None, start_time=_in_days(-1), end_time=_in_days(-1, hours=2))]

    with pytest.raises(ValidationError, match="Start time must be in the future"):
        EventChangeRequestSubmit(**payload)


def test_a_kept_session_that_has_started_is_left_to_the_database():
    """Unchanged started sessions are allowed; the database compares them."""
    payload = valid_change_request()
    payload["sessions"] = [valid_session(start_time=_in_days(-1), end_time=_in_days(1))]

    request = EventChangeRequestSubmit(**payload)

    assert request.sessions[0].session_id == MAIN_SESSION_ID


# Tests if event category is "other", category_other cannot be blank.
def test_other_category_requires_its_description():
    payload = valid_change_request()
    payload["category"] = "other"
    payload["category_other"] = "  "

    with pytest.raises(ValidationError, match="Describe the category"):
        EventChangeRequestSubmit(**payload)


# Route and authorization ---------------------------------------------------

# Checks organiser is authenticated, endpoint returns 201, correct event ID 
# and organiser ID is passed, and all change-request data reaches the service
def _assigned_event(coordinator_id=COORDINATOR.id) -> Event:
    """The Organiser's event as it is before the change request is reviewed."""
    return Event(**{**_event_row("under_review"), "coordinator_id": coordinator_id})


def _stub_change_notification(monkeypatch, captured=None, event=None):
    """Stub the event lookup and notify() used after a change request is saved."""
    monkeypatch.setattr(
        event_service,
        "get_my_event",
        lambda token, organiser_id, event_id: event or _assigned_event(),
    )
    monkeypatch.setattr(
        "routes.events.notification_service.notify",
        lambda *args: (captured if captured is not None else {}).setdefault(
            "notification", args
        ),
    )


def test_organiser_can_submit_a_change_request(client, monkeypatch):
    authenticate_as(monkeypatch, ORGANISER)
    captured = {}
    payload = valid_change_request()

    def submit(access_token, organiser_id, event_id, change_request):
        captured.update(
            access_token=access_token,
            organiser_id=organiser_id,
            event_id=event_id,
            changes=change_request.model_dump(mode="json"),
        )

    monkeypatch.setattr(event_service, "submit_event_change_request", submit)
    _stub_change_notification(monkeypatch)
    response = client.post(
        f"/events/{EVENT_ID}/change-requests",
        json=payload,
        headers={"Authorization": "Bearer organiser-token"},
    )

    assert response.status_code == 201
    assert captured == {
        "access_token": "organiser-token",
        "organiser_id": ORGANISER_ID,
        "event_id": EVENT_ID,
        "changes": EventChangeRequestSubmit(**payload).model_dump(mode="json"),
    }

# Ensures invalid request does not reach service
def test_invalid_change_request_is_rejected_before_service_call(client, monkeypatch):
    authenticate_as(monkeypatch, ORGANISER)

    def must_not_submit(*args, **kwargs):
        raise AssertionError("invalid input must not reach the service")

    monkeypatch.setattr(event_service, "submit_event_change_request", must_not_submit)
    payload = valid_change_request()

    # Makes reason for change blank to check it does not reach the service
    payload["reason_for_change"] = "   "
    response = client.post(
        f"/events/{EVENT_ID}/change-requests",
        json=payload,
        headers={"Authorization": "Bearer organiser-token"},
    )

    assert response.status_code == 400
    assert "This field must not be blank" in response.get_json()["errors"]

# Ensures non-organiser is blocked from submitting change request
def test_non_organiser_cannot_submit_a_change_request(client, monkeypatch):
    authenticate_as(monkeypatch, COORDINATOR)

    def must_not_submit(*args, **kwargs):
        raise AssertionError("the service must not be reached")

    monkeypatch.setattr(event_service, "submit_event_change_request", must_not_submit)
    response = client.post(
        f"/events/{EVENT_ID}/change-requests",
        json=valid_change_request(),
        headers={"Authorization": "Bearer coordinator-token"},
    )

    assert response.status_code == 403

# Ensures unauthenticated users are blocked
def test_change_request_requires_authentication(client):
    response = client.post(
        f"/events/{EVENT_ID}/change-requests",
    )

    assert response.status_code == 401


# Supabase service boundary -------------------------------------------------

# Tests if correct data is sent to Supabase, if service constructs
# database request correctly
def test_service_sends_normalized_change_and_reason_to_atomic_rpc(monkeypatch):
    captured = {}
    request = EventChangeRequestSubmit(**valid_change_request())

    # Fake the Supabase RPC and to check that the service sends p_event_id, p_organiser_id, p_changes
    class FakeRPC:
        def execute(self):
            return SimpleNamespace(data="change-request-id")

    def rpc(function_name, params):
        captured["function_name"] = function_name
        captured["params"] = params
        return FakeRPC()

    monkeypatch.setattr(
        config,
        "get_user_client",
        lambda access_token: SimpleNamespace(rpc=rpc),
    )
    event_service.submit_event_change_request(
        "organiser-token", ORGANISER_ID, EVENT_ID, request
    )

    assert captured["function_name"] == "submit_session_change_request"
    assert captured["params"] == {
        "p_event_id": EVENT_ID,
        "p_changes": request.model_dump(mode="json"),
    }
    assert captured["params"]["p_changes"]["sessions"][0]["session_id"] == MAIN_SESSION_ID


@pytest.mark.parametrize(
    ("database_message", "status_code", "expected_message"),
    [
        (
            "Event cannot be changed in its current status",
            409,
            "Only events under review, in planning or confirmed can be changed.",
        ),
        (
            "A pending change request already exists",
            409,
            "A change request is already waiting for review.",
        ),
        (
            "No event details were changed",
            400,
            "Change at least one event detail before submitting.",
        ),
    ],
)

# Ensures low-level database errors are translated into meaningful 
# application-level errors.
def test_service_translates_database_rule_rejections(
    monkeypatch, database_message, status_code, expected_message
):
    class FakeRPC:
        def execute(self):
            raise APIError(
                {
                    "message": database_message,
                    "code": "P0001",
                    "details": None,
                    "hint": None,
                }
            )

    monkeypatch.setattr(
        config,
        "get_user_client",
        lambda access_token: SimpleNamespace(
            rpc=lambda function_name, params: FakeRPC()
        ),
    )
    request = EventChangeRequestSubmit(**valid_change_request())

    with pytest.raises(AuthError) as caught:
        event_service.submit_event_change_request(
            "organiser-token", ORGANISER_ID, EVENT_ID, request
        )

    assert caught.value.status_code == status_code
    assert caught.value.message == expected_message

def test_service_shows_session_rule_rejections_as_written(monkeypatch):
    message = "Main programme: This session has already started and cannot be changed"

    class FakeRPC:
        def execute(self):
            raise APIError({"message": message, "code": "22023", "details": None, "hint": None})

    monkeypatch.setattr(
        config,
        "get_user_client",
        lambda access_token: SimpleNamespace(rpc=lambda function_name, params: FakeRPC()),
    )

    with pytest.raises(AuthError) as caught:
        event_service.submit_event_change_request(
            "organiser-token", ORGANISER_ID, EVENT_ID,
            EventChangeRequestSubmit(**valid_change_request()),
        )

    assert caught.value.status_code == 400
    assert caught.value.message == message


# Checks if event has a pending change request
@pytest.mark.parametrize("pending_rows, expected", [([], False), ([{"event_id": EVENT_ID}], True)])
def test_event_detail_reports_if_change_request_is_pending(
    monkeypatch, pending_rows, expected
):
    rows = [_change_request_row()] if pending_rows else []
    rows_by_table = {
        "events": [_event_row()],
        "event_change_requests": rows,
    }
    calls = []

    def table(name):
        return FakeQuery(rows_by_table.get(name, []), calls)

    monkeypatch.setattr(
        config,
        "get_user_client",
        lambda access_token: SimpleNamespace(table=table),
    )

    event = event_service.get_my_event("organiser-token", ORGANISER_ID, EVENT_ID)

    assert event.has_pending_change_request is expected
    assert (event.change_request is not None) is expected
    assert ("select", ("*, sessions:event_change_request_sessions(*)",)) in calls
    if expected:
        assert event.change_request.sessions[0].session_id == MAIN_SESSION_ID
    assert ("eq", "organiser_id", ORGANISER_ID) in calls
    assert ("order", "created_at", True) in calls


def test_rejection_reason_is_required_and_trimmed():
    with pytest.raises(ValidationError):
        EventChangeRequestDecision(reason="   ")

    assert EventChangeRequestDecision(reason="  Venue unavailable  ").reason == (
        "Venue unavailable"
    )


def test_coordinator_review_calls_atomic_approval_rpc(monkeypatch):
    captured = {}
    change_request = _change_request_row("approved")
    updated_event = _event_row("under_review")

    class FakeRPC:
        def execute(self):
            return SimpleNamespace(
                data={"event": updated_event, "change_request": change_request}
            )

    def rpc(function_name, params):
        captured.update(function_name=function_name, params=params)
        return FakeRPC()

    monkeypatch.setattr(
        config,
        "get_user_client",
        lambda access_token: SimpleNamespace(rpc=rpc),
    )

    result = event_service.review_assigned_change_request(
        "coordinator-token", COORDINATOR.id, EVENT_ID, "approve",
        approval=EventChangeRequestApproval(cancel_booking_ids=["booking-1"]),
    )

    # T7-281: approving applies the sessions and cancels the ticked bookings.
    assert captured == {
        "function_name": "approve_session_change_request",
        "params": {"p_event_id": EVENT_ID, "p_cancel_booking_ids": ["booking-1"]},
    }
    assert result[1].status == "approved"


def test_approval_without_ticked_bookings_cancels_none(monkeypatch):
    captured = {}

    class FakeRPC:
        def execute(self):
            return SimpleNamespace(data={
                "event": _event_row("planning"),
                "change_request": _change_request_row("approved"),
            })

    def rpc(function_name, params):
        captured.update(params=params)
        return FakeRPC()

    monkeypatch.setattr(config, "get_user_client", lambda access_token: SimpleNamespace(rpc=rpc))

    event_service.review_assigned_change_request("coordinator-token", COORDINATOR.id, EVENT_ID, "approve")

    assert captured["params"]["p_cancel_booking_ids"] == []


def test_venue_staff_are_told_about_bookings_cancelled_on_approval(monkeypatch):
    sent = []

    class FakeRPC:
        def execute(self):
            return SimpleNamespace(data={
                "event": _event_row("planning"),
                "change_request": _change_request_row("approved"),
                "cancelled_bookings": [
                    {"booking_id": "booking-1", "venue_name": "Hall A", "session_name": "Breakout A"},
                ],
            })

    monkeypatch.setattr(
        config, "get_user_client",
        lambda access_token: SimpleNamespace(rpc=lambda name, params: FakeRPC()),
    )
    monkeypatch.setattr(
        event_service.notification_service, "notify_role",
        lambda role, notification_type, title, body, event_id=None: sent.append((role, notification_type, body, event_id)),
    )

    event_service.review_assigned_change_request("coordinator-token", COORDINATOR.id, EVENT_ID, "approve")

    ((role, notification_type, body, event_id),) = sent
    assert role == "venue_staff"
    assert notification_type == "venue_booking_cancelled"
    assert "Hall A" in body and "Breakout A" in body and "Annual Client Summit" in body
    assert event_id == EVENT_ID


def test_session_rule_rejections_on_approval_are_shown_as_written(monkeypatch):
    message = "Breakout A: This session has already started and cannot be changed"

    class FakeRPC:
        def execute(self):
            raise APIError({"message": message, "code": "22023", "details": None, "hint": None})

    monkeypatch.setattr(
        config, "get_user_client",
        lambda access_token: SimpleNamespace(rpc=lambda name, params: FakeRPC()),
    )

    with pytest.raises(AuthError) as caught:
        event_service.review_assigned_change_request("coordinator-token", COORDINATOR.id, EVENT_ID, "approve")

    assert caught.value.status_code == 409
    assert caught.value.message == message


def test_coordinator_review_calls_atomic_rejection_rpc_with_reason(monkeypatch):
    captured = {}
    change_request = _change_request_row("rejected")
    updated_event = _event_row("under_review")

    class FakeRPC:
        def execute(self):
            return SimpleNamespace(
                data={"event": updated_event, "change_request": change_request}
            )

    def rpc(function_name, params):
        captured.update(function_name=function_name, params=params)
        return FakeRPC()

    monkeypatch.setattr(
        config,
        "get_user_client",
        lambda access_token: SimpleNamespace(rpc=rpc),
    )
    rejection = EventChangeRequestDecision(reason="Venue unavailable")

    result = event_service.review_assigned_change_request(
        "coordinator-token",
        COORDINATOR.id,
        EVENT_ID,
        "reject",
        rejection,
    )

    assert captured == {
        "function_name": "reject_event_change_request",
        "params": {
            "p_event_id": EVENT_ID,
            "p_rejection_reason": "Venue unavailable",
        },
    }
    assert result[1].rejection_reason == (
        "The revised date conflicts with the venue booking."
    )


def test_coordinator_can_reject_change_request_and_notify_organiser(
    client, monkeypatch
):
    authenticate_as(monkeypatch, COORDINATOR)
    captured = {}
    reviewed_request = EventChangeRequest(**_change_request_row("rejected"))
    reviewed_event = Event(**_event_row("under_review"))
    monkeypatch.setattr(
        event_service,
        "review_assigned_change_request",
        lambda access_token, coordinator_id, event_id, decision, rejection, approval: (
            reviewed_event,
            reviewed_request,
        ),
    )
    monkeypatch.setattr(
        "routes.events.notification_service.notify",
        lambda *args: captured.setdefault("notification", args),
    )

    response = client.post(
        f"/events/review/{EVENT_ID}/change-request/reject",
        json={"reason": "Venue unavailable"},
        headers={"Authorization": "Bearer coordinator-token"},
    )

    assert response.status_code == 200
    assert response.get_json()["change_request"]["rejection_reason"]
    assert captured["notification"][0] == ORGANISER_ID
    assert captured["notification"][2] == "Event change request rejected"
    assert f"The proposed changes to '{reviewed_request.name}' were rejected." in captured["notification"][3]
    assert "Reason:" in captured["notification"][3]


# --- T7-164: notifying the Coordinator of a new change request -----------


def _post_change_request(client):
    return client.post(
        f"/events/{EVENT_ID}/change-requests",
        json=valid_change_request(),
        headers={"Authorization": "Bearer organiser-token"},
    )


def test_submitting_change_request_notifies_the_coordinator(client, monkeypatch):
    authenticate_as(monkeypatch, ORGANISER)
    monkeypatch.setattr(
        event_service, "submit_event_change_request", lambda *args: None
    )
    captured = {}
    _stub_change_notification(monkeypatch, captured)

    response = _post_change_request(client)

    assert response.status_code == 201
    user_id, notification_type, title, body, event_id = captured["notification"]
    assert user_id == COORDINATOR.id
    assert notification_type == "change_request_submitted"
    assert title == "Change request submitted"
    assert "Ada Tan" in body
    assert "Annual Client Summit" in body
    assert "The venue can only host us on the revised date." in body
    assert event_id == EVENT_ID


def test_failed_change_request_sends_no_notification(client, monkeypatch):
    authenticate_as(monkeypatch, ORGANISER)

    def failing_submit(*args):
        raise AuthError("A change request is already waiting for review.", 409)

    monkeypatch.setattr(event_service, "submit_event_change_request", failing_submit)
    monkeypatch.setattr(
        "routes.events.notification_service.notify",
        lambda *args: pytest.fail("a failed change request must not notify anyone"),
    )

    response = _post_change_request(client)

    assert response.status_code == 409


def test_change_request_is_still_saved_when_notification_fails(client, monkeypatch):
    authenticate_as(monkeypatch, ORGANISER)
    monkeypatch.setattr(
        event_service, "submit_event_change_request", lambda *args: None
    )
    _stub_change_notification(monkeypatch)
    # notify() returns None, rather than raising, when it cannot save.
    monkeypatch.setattr(
        "routes.events.notification_service.notify", lambda *args: None
    )

    response = _post_change_request(client)

    assert response.status_code == 201


def test_change_request_is_still_saved_when_event_lookup_fails(client, monkeypatch):
    authenticate_as(monkeypatch, ORGANISER)
    monkeypatch.setattr(
        event_service, "submit_event_change_request", lambda *args: None
    )

    def failing_lookup(*args):
        raise AuthError("Unable to load the event request.", 502)

    monkeypatch.setattr(event_service, "get_my_event", failing_lookup)
    monkeypatch.setattr(
        "routes.events.notification_service.notify",
        lambda *args: pytest.fail("no notification without the event"),
    )

    response = _post_change_request(client)

    assert response.status_code == 201


def test_event_without_coordinator_sends_no_notification(client, monkeypatch):
    authenticate_as(monkeypatch, ORGANISER)
    monkeypatch.setattr(
        event_service, "submit_event_change_request", lambda *args: None
    )
    _stub_change_notification(monkeypatch, event=_assigned_event(coordinator_id=None))
    monkeypatch.setattr(
        "routes.events.notification_service.notify",
        lambda *args: pytest.fail("there is no coordinator to notify"),
    )

    response = _post_change_request(client)

    assert response.status_code == 201


# --- T7-162: notifying the Organiser of the review outcome ---------------


def _review_returns(monkeypatch, status):
    """Make the review service succeed with a change request in `status`."""
    reviewed_request = EventChangeRequest(**_change_request_row(status))
    reviewed_event = Event(**_event_row("under_review"))
    monkeypatch.setattr(
        event_service,
        "review_assigned_change_request",
        lambda *args: (reviewed_event, reviewed_request),
    )


def test_approving_change_request_notifies_organiser_changes_were_applied(
    client, monkeypatch
):
    authenticate_as(monkeypatch, COORDINATOR)
    _review_returns(monkeypatch, "approved")
    captured = {}
    monkeypatch.setattr(
        "routes.events.notification_service.notify",
        lambda *args: captured.setdefault("notification", args),
    )

    response = client.post(
        f"/events/review/{EVENT_ID}/change-request/approve",
        headers={"Authorization": "Bearer coordinator-token"},
    )

    assert response.status_code == 200
    user_id, notification_type, title, body, event_id = captured["notification"]
    assert user_id == ORGANISER_ID
    assert notification_type == "event_change_approved"
    assert title == "Event change request approved"
    assert "Annual Client Summit" in body
    assert "approved and applied" in body
    assert body == (
        "The proposed changes to 'Annual Client Summit' have been "
        "approved and applied."
    )
    assert event_id == EVENT_ID


def test_approve_route_passes_the_ticked_bookings(client, monkeypatch):
    authenticate_as(monkeypatch, COORDINATOR)
    captured = {}

    def review(access_token, coordinator_id, event_id, decision, rejection, approval):
        captured["approval"] = approval
        return Event(**_event_row("planning")), EventChangeRequest(**_change_request_row("approved"))

    monkeypatch.setattr(event_service, "review_assigned_change_request", review)
    monkeypatch.setattr("routes.events.notification_service.notify", lambda *args: None)

    response = client.post(
        f"/events/review/{EVENT_ID}/change-request/approve",
        json={"cancel_booking_ids": ["booking-1", "booking-2"]},
        headers={"Authorization": "Bearer coordinator-token"},
    )

    assert response.status_code == 200
    assert captured["approval"].cancel_booking_ids == ["booking-1", "booking-2"]


def test_organiser_is_told_when_a_confirmed_event_returns_to_planning(client, monkeypatch):
    authenticate_as(monkeypatch, COORDINATOR)
    approved = EventChangeRequest(**{
        **_change_request_row("approved"), "event_status_before_request": "confirmed",
    })
    monkeypatch.setattr(
        event_service, "review_assigned_change_request",
        lambda *args: (Event(**_event_row("planning")), approved),
    )
    captured = {}
    monkeypatch.setattr(
        "routes.events.notification_service.notify",
        lambda *args: captured.setdefault("notification", args),
    )

    client.post(
        f"/events/review/{EVENT_ID}/change-request/approve",
        headers={"Authorization": "Bearer coordinator-token"},
    )

    assert "back in Planning and needs a new safety check" in captured["notification"][3]


def test_rejecting_change_request_notification_names_the_event(
    client, monkeypatch
):
    authenticate_as(monkeypatch, COORDINATOR)
    _review_returns(monkeypatch, "rejected")
    captured = {}
    monkeypatch.setattr(
        "routes.events.notification_service.notify",
        lambda *args: captured.setdefault("notification", args),
    )

    client.post(
        f"/events/review/{EVENT_ID}/change-request/reject",
        json={"reason": "Venue unavailable"},
        headers={"Authorization": "Bearer coordinator-token"},
    )

    body = captured["notification"][3]
    assert "Annual Client Summit" in body
    assert "The revised date conflicts with the venue booking." in body


@pytest.mark.parametrize("decision", ["approve", "reject"])
def test_failed_review_sends_no_notification(client, monkeypatch, decision):
    authenticate_as(monkeypatch, COORDINATOR)

    def failing_review(*args):
        raise AuthError("This change request has already been reviewed.", 409)

    monkeypatch.setattr(
        event_service, "review_assigned_change_request", failing_review
    )
    monkeypatch.setattr(
        "routes.events.notification_service.notify",
        lambda *args: pytest.fail("a failed review must not notify anyone"),
    )

    response = client.post(
        f"/events/review/{EVENT_ID}/change-request/{decision}",
        json={"reason": "Venue unavailable"},
        headers={"Authorization": "Bearer coordinator-token"},
    )

    assert response.status_code == 409


def test_review_still_succeeds_when_notification_fails(client, monkeypatch):
    authenticate_as(monkeypatch, COORDINATOR)
    _review_returns(monkeypatch, "approved")
    # notify() returns None, rather than raising, when it cannot save.
    monkeypatch.setattr(
        "routes.events.notification_service.notify", lambda *args: None
    )

    response = client.post(
        f"/events/review/{EVENT_ID}/change-request/approve",
        headers={"Authorization": "Bearer coordinator-token"},
    )

    assert response.status_code == 200
    assert response.get_json()["change_request"]["status"] == "approved"

def test_coordinator_must_provide_rejection_reason(client, monkeypatch):
    authenticate_as(monkeypatch, COORDINATOR)
    monkeypatch.setattr(
        event_service,
        "review_assigned_change_request",
        lambda *args: pytest.fail("invalid request reached the service"),
    )

    response = client.post(
        f"/events/review/{EVENT_ID}/change-request/reject",
        json={"reason": " "},
        headers={"Authorization": "Bearer coordinator-token"},
    )

    assert response.status_code == 400
    assert "Give a reason for rejecting this change request" in (
        response.get_json()["errors"]
    )
