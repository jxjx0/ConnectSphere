"""Unfilled form values and overview filtering at the model boundary."""

import pytest
from pydantic import ValidationError

from models.event import (
    Event, EventChangeRequestSessionSubmit, EventChangeRequestSubmit,
    EventDraftRequest, EventSessionDraft, EventSessionSubmit, EventSubmitRequest,
)
from models.profile import SignupRequest
from models.venue_hold import ReservationItem
from test_auth import VALID_SIGNUP
from test_event_change_requests import valid_change_request
from test_events import valid_event, valid_session
from test_venue_holds import ITEM


def test_session_validation_accepts_future_browser_local_times():
    payload = valid_session()
    aware = EventSessionSubmit(**payload)
    payload.update(start_time=aware.start_time.replace(tzinfo=None), end_time=aware.end_time.replace(tzinfo=None))
    local = EventSessionSubmit(**payload)
    assert local.start_time == aware.start_time.replace(tzinfo=None)
    assert local.end_time == aware.end_time.replace(tzinfo=None)


def test_session_validation_rejects_past_browser_local_times():
    with pytest.raises(ValidationError, match="Start time must be in the future"):
        EventSessionSubmit(**{**valid_session(), "start_time": "2000-01-01T10:00:00"})


@pytest.mark.parametrize("field", ["location_preference", "layout_preference", "equipment_requirements"])
def test_explicit_null_session_preferences_remain_optional(field):
    session = EventSessionSubmit(**{**valid_session(), field: None})
    assert getattr(session, field) is None


@pytest.mark.parametrize("field", ["category_other", "accessibility_requirements"])
def test_explicit_null_event_preferences_remain_optional(field):
    request = EventSubmitRequest(**{**valid_event(), field: None})
    assert getattr(request, field) is None


@pytest.mark.parametrize("field", ["name", "location_preference", "layout_preference", "equipment_requirements"])
def test_incomplete_draft_session_accepts_explicit_null_text(field):
    session = EventSessionDraft(**{field: None})
    assert getattr(session, field) is None


@pytest.mark.parametrize("field", ["description", "purpose", "category_other", "accessibility_requirements"])
@pytest.mark.parametrize("value,expected", [(None, None), ("  ", None), ("  Detail  ", "Detail")])
def test_draft_optional_text_normalizes_form_values(field, value, expected):
    payload = {"name": "Draft", field: value}
    if field == "category_other" and expected:
        payload["category"] = "other"
    request = EventDraftRequest(**payload)
    assert getattr(request, field) == expected


@pytest.mark.parametrize("category,expected", [("", None), ("  ", None), (None, None), ("workshop", "workshop")])
def test_draft_category_can_be_unselected_or_chosen(category, expected):
    request = EventDraftRequest(name="Draft", category=category)
    assert request.category == expected


def test_draft_cannot_store_other_description_for_a_regular_category():
    with pytest.raises(ValidationError, match="Only choose a category description"):
        EventDraftRequest(name="Draft", category="workshop", category_other="Custom")


def test_changed_session_name_cannot_be_only_whitespace():
    with pytest.raises(ValidationError, match="Give every session a name"):
        EventChangeRequestSessionSubmit(**{**valid_session(), "name": "  "})


def test_change_request_cannot_store_other_description_for_a_regular_category():
    with pytest.raises(ValidationError, match="Only choose a category description"):
        EventChangeRequestSubmit(**{**valid_change_request(), "category_other": "Custom"})


@pytest.mark.parametrize("raw", [None, {}, "invalid"])
def test_lead_overview_does_not_format_a_non_list_response(raw):
    assert Event.format_lead_overview(raw) == []


def test_lead_overview_excludes_empty_completed_and_rejected_records():
    rows = [None, {}, {"id": "completed", "status": "completed"}, {"id": "rejected", "status": "rejected"},
            {"id": "planning", "name": "Workshop", "status": "planning"}]
    result = Event.format_lead_overview(rows)
    assert [row["id"] for row in result] == ["planning"]
    assert result[0]["coordinator_name"] == "Unassigned"


def test_attendee_signup_accepts_explicitly_null_organization():
    request = SignupRequest(**{**VALID_SIGNUP, "role": "attendee", "organization": None})
    assert request.organization is None


def test_reservation_rejects_an_unknown_kind():
    with pytest.raises(ValidationError, match="unknown reservation type"):
        ReservationItem(**{**ITEM, "type": "available"})
