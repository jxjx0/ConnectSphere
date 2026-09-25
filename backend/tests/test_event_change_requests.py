"""Tests for an Organiser submitting an event change request."""

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from pydantic import ValidationError
from postgrest import APIError

import config
from models.event import Event, EventChangeRequestSubmit, EventStatus
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


def valid_change_request() -> dict:
    return {
        "name": "Annual Client Summit",
        "description": "A full-day summit for our regional clients.",
        "reason_for_change": "The venue can only host us on the revised date.",
        "purpose": "Client relationship building",
        "category": "conference",
        "category_other": None,
        "start_time": _in_days(30),
        "end_time": _in_days(30, hours=8),
        "expected_attendance": 120,
        "location_preference": "Central",
        "layout_preference": "Theatre",
        "accessibility_requirements": "NIL",
        "equipment_requirements": "Nil",
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

    def execute(self):
        return SimpleNamespace(data=self.rows)


def _event_row(status="submitted") -> dict:
    event_details = valid_change_request()
    event_details.pop("reason_for_change")
    event_details["accessibility_requirements"] = None
    event_details["equipment_requirements"] = None
    return Event(
        id=EVENT_ID,
        organiser_id=ORGANISER_ID,
        status=status,
        **event_details,
    ).model_dump(mode="json")


# Model validation ---------------------------------------------------------

# Checks that a valid change request can be created and that "NIL"
# requirements are converted to None.
def test_valid_change_request_accepts_reason_and_nil_requirements():
    request = EventChangeRequestSubmit(**valid_change_request())

    assert request.reason_for_change.startswith("The venue")
    assert request.accessibility_requirements is None
    assert request.equipment_requirements is None

# Tests that name, description, purpose and reason for change cannot
# just contain spaces.
@pytest.mark.parametrize("field", ["name", "description", "purpose", "reason_for_change"])
def test_required_text_fields_reject_blank_values(field):
    payload = valid_change_request()
    payload[field] = "   "

    with pytest.raises(ValidationError):
        EventChangeRequestSubmit(**payload)

# Checks that category, start time, end time, and expected attendance 
# cannot be missing.
def test_change_request_rejects_missing_required_structured_fields(
    field, empty_value
):
    payload = valid_change_request()
    payload[field] = empty_value

    with pytest.raises(ValidationError):
        EventChangeRequestSubmit(**payload)


@pytest.mark.parametrize(
    "field",
    [
        "location_preference",
        "layout_preference",
        "accessibility_requirements",
        "equipment_requirements",
    ],
)

# Tests that " " is invalid, " nIl " is accepted and converted to None
def test_optional_requirement_fields_accept_nil_but_reject_blank(field):
    payload = valid_change_request()
    payload[field] = "   "

    with pytest.raises(ValidationError):
        EventChangeRequestSubmit(**payload)

    payload[field] = " nIl "
    request = EventChangeRequestSubmit(**payload)
    assert getattr(request, field) is None

# Makes sure end time < start time
def test_change_request_rejects_end_time_before_start_time():
    payload = valid_change_request()
    payload["end_time"] = _in_days(29)

    with pytest.raises(ValidationError, match="End time must be after the start time"):
        EventChangeRequestSubmit(**payload)


@pytest.mark.parametrize(
    ("field", "empty_value"),
    [
        ("category", ""),
        ("start_time", ""),
        ("end_time", ""),
        ("expected_attendance", None),
    ],
)

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
        json=valid_change_request(),
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

    assert captured["function_name"] == "submit_event_change_request"
    assert captured["params"] == {
        "p_event_id": EVENT_ID,
        "p_organiser_id": ORGANISER_ID,
        "p_changes": request.model_dump(mode="json"),
    }


@pytest.mark.parametrize(
    ("database_message", "status_code", "expected_message"),
    [
        (
            "Event cannot be changed in its current status",
            409,
            "Only submitted or confirmed events can be changed.",
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

# Checks if event has a pending change request
@pytest.mark.parametrize("pending_rows, expected", [([], False), ([{"event_id": EVENT_ID}], True)])
def test_event_detail_reports_if_change_request_is_pending(
    monkeypatch, pending_rows, expected
):
    rows_by_table = {
        "events": [_event_row()],
        "event_change_requests": pending_rows,
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
    assert ("eq", "organiser_id", ORGANISER_ID) in calls
    assert ("eq", "status", "pending") in calls
