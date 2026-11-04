"""Remaining draft and clarification HTTP workflows and notification fallbacks."""

from unittest.mock import Mock

import pytest

from models.event import Event, EventCancellationRequest, EventClarification
from models.profile import Profile, Role
from services import event_service, notification_service
from services.auth_service import AuthError
from test_event_clarification_responses import clarification_row
from test_event_drafts import DRAFT_ID, DRAFT_ROW, ORGANISER, UNDER_REVIEW_ROW, complete_event
from test_events import authenticate_as


HEADERS = {"Authorization": "Bearer owner-token"}


@pytest.mark.parametrize("method,url,service", [
    ("get", f"/events/drafts/{DRAFT_ID}", "get_my_draft"),
    ("put", f"/events/drafts/{DRAFT_ID}", "update_draft"),
    ("post", f"/events/drafts/{DRAFT_ID}/submit", "submit_draft"),
    ("delete", f"/events/drafts/{DRAFT_ID}", "delete_draft"),
])
def test_organiser_can_continue_save_submit_and_delete_draft(client, monkeypatch, method, url, service):
    authenticate_as(monkeypatch, ORGANISER)
    saved = Event(**(UNDER_REVIEW_ROW if service == "submit_draft" else DRAFT_ROW))
    handler = Mock(return_value=None if service == "delete_draft" else saved)
    notify = Mock()
    monkeypatch.setattr(event_service, service, handler)
    monkeypatch.setattr(notification_service, "notify_role", notify)
    kwargs = {"headers": HEADERS}
    if method in {"put", "post"}:
        kwargs["json"] = complete_event() if method == "post" else {"name": "  Revised draft  "}
    response = getattr(client, method)(url, **kwargs)
    assert response.status_code == (204 if method == "delete" else 200)
    assert handler.call_args.args[:3] == ("owner-token", ORGANISER.id, DRAFT_ID)
    if method == "delete":
        assert response.data == b""
    else:
        assert response.get_json()["event"] == saved.model_dump(mode="json")
    if method == "put":
        assert handler.call_args.args[3].name == "Revised draft"
    if service == "submit_draft":
        assert handler.call_args.args[3].sessions[0].name == "Main programme"
        notify.assert_called_once_with(
            "event_coordinator_lead", "event_submitted", "New event request submitted",
            f"A new event request '{saved.name}' has been submitted for assignment.", saved.id,
        )
    else:
        notify.assert_not_called()


@pytest.mark.parametrize("method,url,service", [
    ("post", "/events/drafts", "create_draft"),
    ("put", f"/events/drafts/{DRAFT_ID}", "update_draft"),
])
@pytest.mark.parametrize("payload", [{}, {"name": "   "}, {"name": "Draft", "category": "invalid"}])
def test_invalid_draft_form_is_rejected_before_service(client, monkeypatch, method, url, service, payload):
    authenticate_as(monkeypatch, ORGANISER)
    save = Mock()
    monkeypatch.setattr(event_service, service, save)
    response = getattr(client, method)(url, json=payload, headers=HEADERS)
    assert response.status_code == 400
    assert response.get_json()["errors"]
    save.assert_not_called()


@pytest.mark.parametrize("method,service", [("get", "get_my_draft"), ("put", "update_draft"), ("delete", "delete_draft")])
@pytest.mark.parametrize("role", [role for role in Role if role != Role.ORGANISER])
def test_draft_endpoints_reject_other_roles_before_accessing_saved_draft(client, monkeypatch, method, service, role):
    authenticate_as(monkeypatch, Profile(id="other-user", full_name="Other user", role=role))
    handler = Mock()
    monkeypatch.setattr(event_service, service, handler)
    response = getattr(client, method)(f"/events/drafts/{DRAFT_ID}", json={"name": "Draft"}, headers=HEADERS)
    assert response.status_code == 403
    handler.assert_not_called()


def test_failed_draft_submission_sends_no_assignment_notification(client, monkeypatch):
    authenticate_as(monkeypatch, ORGANISER)
    submit = Mock(side_effect=AuthError("Draft was not found.", 404))
    notify = Mock()
    monkeypatch.setattr(event_service, "submit_draft", submit)
    monkeypatch.setattr(notification_service, "notify_role", notify)
    response = client.post(f"/events/drafts/{DRAFT_ID}/submit", json=complete_event(), headers=HEADERS)
    assert response.status_code == 404
    assert response.get_json() == {"error": "Draft was not found."}
    notify.assert_not_called()


@pytest.mark.parametrize("role", [Role.COORDINATOR, Role.EVENT_COORDINATOR_LEAD])
def test_coordinator_clarification_history_passes_assignee_context(client, monkeypatch, role):
    profile = Profile(id="coordinator", full_name="Coordinator", role=role)
    authenticate_as(monkeypatch, profile)
    exchange = EventClarification(**clarification_row())
    read = Mock(return_value=[exchange])
    monkeypatch.setattr(event_service, "list_event_clarifications", read)
    response = client.get("/events/review/event-1/clarifications", headers=HEADERS)
    assert response.status_code == 200
    assert response.get_json() == {"clarifications": [exchange.model_dump(mode="json")]}
    read.assert_called_once_with("owner-token", "event-1", coordinator_id="coordinator")


@pytest.mark.parametrize("lookup_failure", [True, False])
def test_saved_cancellation_request_survives_unavailable_notification_recipient(client, monkeypatch, lookup_failure):
    authenticate_as(monkeypatch, ORGANISER)
    saved = EventCancellationRequest(
        id="request-1", event_id="event-1", organiser_id=ORGANISER.id, status="pending", reason="Schedule changed",
    )
    submit = Mock(return_value=saved)
    read = Mock(side_effect=AuthError("Event unavailable", 502)) if lookup_failure else Mock(return_value=Event(
        id="event-1", organiser_id=ORGANISER.id, name="Workshop", status="planning", coordinator_id=None,
    ))
    notify = Mock()
    monkeypatch.setattr(event_service, "submit_event_cancellation_request", submit)
    monkeypatch.setattr(event_service, "get_my_event", read)
    monkeypatch.setattr(notification_service, "notify", notify)
    response = client.post("/events/event-1/cancellation-requests", json={"reason": "Schedule changed"}, headers=HEADERS)
    assert response.status_code == 201
    assert response.get_json()["cancellation_request"]["id"] == saved.id
    assert submit.call_args.args[:3] == ("owner-token", ORGANISER.id, "event-1")
    notify.assert_not_called()
