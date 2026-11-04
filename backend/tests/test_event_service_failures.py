"""Event persistence failures and access filters, without network or database I/O."""

from unittest.mock import Mock

import pytest
from postgrest import APIError

import config
from fake_supabase import FakeDatabase
from models.event import (
    EventCancellationRequestSubmit, EventChangeRequestSubmit,
    EventClarificationRequest, EventClarificationResponse, EventDraftRequest,
    EventStatus, EventSubmitRequest,
)
from services import event_service as events
from services.auth_service import AuthError
from test_event_change_requests import valid_change_request
from test_event_drafts import DRAFT_ROW
from test_events import valid_event


def database_error(code="XX000", message="database unavailable"):
    return APIError({"code": code, "message": message})


@pytest.fixture
def database(monkeypatch):
    database = FakeDatabase()
    monkeypatch.setattr(config, "get_user_client", Mock(return_value=database.client))
    monkeypatch.setattr(config, "get_admin_client", Mock(side_effect=AssertionError("Use caller's token")))
    return database


@pytest.mark.parametrize("rows", [None, []])
def test_activity_history_with_no_rows_does_not_read_profiles(database, rows):
    database.responses[("event_activity_logs", "select")] = rows
    assert events.get_event_activity_logs("event-1", "token") == []
    assert database.calls[0].filters == [("eq", "event_id", "event-1"), ("order", "created_at")]
    assert database.calls_to("profiles", "select") == []


def test_activity_history_batches_distinct_people_and_handles_deleted_profiles(database):
    database.responses[("event_activity_logs", "select")] = [
        {"id": "log-1", "previous_coordinator_id": "old", "new_coordinator_id": "new", "changed_by_id": "lead"},
        {"id": "log-2", "previous_coordinator_id": "new", "changed_by_id": "deleted"},
    ]
    people = [{"id": person, "full_name": person.title()} for person in ("old", "new", "lead")]
    database.responses[("profiles", "select")] = people
    result = events.get_event_activity_logs("event-1", "user-token")
    assert result[0]["previous_coordinator"] == people[0]
    assert result[0]["new_coordinator"] == people[1]
    assert result[0]["changed_by"] == people[2]
    assert result[1]["previous_coordinator"] == people[1]
    assert result[1]["new_coordinator"] is None
    assert result[1]["changed_by"] is None
    (query,) = database.calls_to("profiles", "select")
    assert query.filters[0][:2] == ("in_", "id")
    assert set(query.filters[0][2]) == {"old", "new", "lead", "deleted"}
    config.get_user_client.assert_called_once_with("user-token")


def test_activity_history_without_people_keeps_logs_without_profile_query(database):
    database.responses[("event_activity_logs", "select")] = [{"id": "system-log"}]
    assert events.get_event_activity_logs("event-1", "token") == [{
        "id": "system-log", "previous_coordinator": None, "new_coordinator": None, "changed_by": None,
    }]
    assert database.calls_to("profiles", "select") == []


@pytest.mark.parametrize("table", ["event_activity_logs", "profiles"])
@pytest.mark.parametrize("code,status,message", [
    ("42501", 403, "You do not have permission to view this event's history."),
    ("XX000", 502, "Unable to load this event's history."),
])
def test_activity_history_read_failure_hides_database_details(database, table, code, status, message):
    database.responses[("event_activity_logs", "select")] = [{"id": "log-1", "changed_by_id": "lead"}]
    error = database_error(code)
    database.responses[(table, "select")] = error
    with pytest.raises(AuthError) as caught:
        events.get_event_activity_logs("event-1", "token")
    assert caught.value.status_code == status
    assert caught.value.message == message
    assert caught.value.__cause__ is error


@pytest.mark.parametrize("code,status,message", [
    ("42703", 503, "schema is missing"), ("PGRST204", 503, "schema is missing"),
    ("PGRST205", 503, "schema is missing"), ("23502", 400, "validation rule"),
    ("23514", 400, "validation rule"), ("22P02", 400, "validation rule"),
    ("23503", 400, "user that does not exist"), ("42501", 403, "permission"),
    ("PGRST301", 403, "permission"), ("XX000", 502, "Unable to save"),
])
def test_event_submission_translates_insert_errors_without_saving_sessions(database, code, status, message):
    error = database_error(code)
    database.responses[("events", "insert")] = error
    with pytest.raises(AuthError, match=message) as caught:
        events.submit_event("token", "organiser", EventSubmitRequest(**valid_event()))
    assert caught.value.status_code == status
    assert caught.value.__cause__ is error
    assert [(q.table, q.operation) for q in database.calls] == [("events", "insert")]


@pytest.mark.parametrize("operation", ["submit", "draft"])
def test_event_creation_requires_a_returned_row(database, operation):
    with pytest.raises(AuthError, match="not submitted|not saved") as caught:
        if operation == "submit":
            events.submit_event("token", "organiser", EventSubmitRequest(**valid_event()))
        else:
            events.create_draft("token", "organiser", EventDraftRequest(name="Draft"))
    assert caught.value.status_code == 502
    assert len(database.calls) == 1


def test_new_draft_maps_insert_error(database):
    error = database_error("42501")
    database.responses[("events", "insert")] = error
    with pytest.raises(AuthError) as caught:
        events.create_draft("token", "organiser", EventDraftRequest(name="Draft"))
    assert caught.value.status_code == 403
    assert caught.value.__cause__ is error
    assert len(database.calls) == 1


def test_failed_session_save_preserves_original_failure_when_cleanup_also_fails(database):
    database.responses[("events", "insert")] = [DRAFT_ROW]
    database.responses[("events", "delete")] = database_error()
    # The RPC returns fewer sessions than requested; it must not report success.
    request = EventSubmitRequest(**valid_event())
    with pytest.raises(AuthError, match="Event sessions were not saved") as caught:
        events.submit_event("token", DRAFT_ROW["organiser_id"], request)
    assert caught.value.status_code == 502
    (cleanup,) = database.calls_to("events", "delete")
    assert cleanup.filters == [
        ("eq", "id", DRAFT_ROW["id"]), ("eq", "organiser_id", DRAFT_ROW["organiser_id"]),
        ("eq", "status", "draft"),
    ]
    assert database.calls_to("events", "update") == []


@pytest.mark.parametrize("operation,filters", [
    ("list_my_events", [("eq", "organiser_id", "owner"), ("neq", "status", "draft"), ("order", "start_time")]),
    ("get_my_event", [("eq", "id", "event"), ("eq", "organiser_id", "owner"), ("neq", "status", "draft")]),
    ("list_my_drafts", [("eq", "organiser_id", "owner"), ("eq", "status", "draft"), ("order", "updated_at")]),
    ("get_my_draft", [("eq", "id", "event"), ("eq", "organiser_id", "owner"), ("eq", "status", "draft")]),
    ("list_assigned_events", [("eq", "coordinator_id", "owner"), ("neq", "status", "draft"), ("order", "start_time")]),
    ("get_assigned_event", [("eq", "id", "event"), ("eq", "coordinator_id", "owner"), ("neq", "status", "draft")]),
])
@pytest.mark.parametrize("code,status", [("42501", 403), ("XX000", 502)])
def test_event_reads_keep_owner_filters_and_report_database_failures(database, operation, filters, code, status):
    error = database_error(code)
    database.responses[("events", "select")] = error
    args = ("token", "owner", "event") if operation.startswith("get_") else ("token", "owner")
    with pytest.raises(AuthError) as caught:
        getattr(events, operation)(*args)
    assert caught.value.status_code == status
    assert caught.value.__cause__ is error
    assert database.calls[0].filters == filters
    assert len(database.calls) == 1


def test_draft_list_returns_saved_drafts_and_uses_user_token(database):
    database.responses[("events", "select")] = [DRAFT_ROW]
    result = events.list_my_drafts("owner-token", DRAFT_ROW["organiser_id"])
    assert [event.id for event in result] == [DRAFT_ROW["id"]]
    assert result[0].status == EventStatus.DRAFT
    config.get_user_client.assert_called_once_with("owner-token")


@pytest.mark.parametrize("operation", ["update", "delete"])
@pytest.mark.parametrize("failure,status", [(None, 404), ("42501", 403), ("XX000", 502)])
def test_draft_mutations_cannot_succeed_without_a_visible_updated_row(database, operation, failure, status):
    database.responses[("events", operation)] = database_error(failure) if failure else []
    with pytest.raises(AuthError) as caught:
        if operation == "update":
            events.update_draft("token", "owner", "draft", EventDraftRequest(name="Revised"))
        else:
            events.delete_draft("token", "owner", "draft")
    assert caught.value.status_code == status
    assert database.calls[0].filters == [
        ("eq", "id", "draft"), ("eq", "organiser_id", "owner"), ("eq", "status", "draft"),
    ]
    assert len(database.calls) == 1


@pytest.mark.parametrize("table,operation", [
    ("event_clarifications", "get_assigned_event"),
    ("event_change_requests", "get_my_event"),
    ("event_cancellation_requests", "get_my_event"),
    ("event_sessions", "get_my_draft"),
    ("profiles", "get_my_event"),
])
def test_event_detail_does_not_silently_hide_related_read_failures(database, table, operation):
    database.responses[("events", "select")] = [{**DRAFT_ROW, "id": "event", "organiser_id": "owner", "status": "draft" if operation == "get_my_draft" else "planning", "coordinator_id": "owner"}]
    error = database_error("42501")
    database.responses[(table, "select")] = error
    with pytest.raises(AuthError) as caught:
        getattr(events, operation)("token", "owner", "event")
    assert caught.value.status_code == 403
    assert caught.value.__cause__ is error


@pytest.mark.parametrize("helper", ["_with_cancellation_request", "_with_change_request", "_with_sessions"])
def test_empty_event_batches_do_not_query_related_private_data(database, helper):
    assert getattr(events, helper)(database.client, []) == []
    assert database.calls == []


@pytest.mark.parametrize("code", ["42P01", "42703", "PGRST202", "PGRST204", "PGRST205", "42883", "42501"])
def test_cancellation_history_explains_schema_or_permission_failure(database, code):
    database.responses[("events", "select")] = [{**DRAFT_ROW, "id": "event", "organiser_id": "owner", "status": "planning"}]
    database.responses[("event_cancellation_requests", "select")] = database_error(code)
    with pytest.raises(AuthError) as caught:
        events.get_my_event("token", "owner", "event")
    assert caught.value.status_code == (403 if code == "42501" else 503)
    assert ("permission" if code == "42501" else "event_cancellation_requests.sql") in caught.value.message


@pytest.mark.parametrize("saved", [None, []])
def test_cancellation_submission_requires_saved_details(database, saved):
    database.responses[("rpc:submit_event_cancellation_request", "rpc")] = "request"
    database.responses[("event_cancellation_requests", "select")] = saved
    with pytest.raises(AuthError, match="saved but its details could not be loaded") as caught:
        events.submit_event_cancellation_request("token", "owner", "event", EventCancellationRequestSubmit(reason="Unavailable"))
    assert caught.value.status_code == 502
    assert database.calls[-1].filters == [("eq", "id", "request"), ("eq", "organiser_id", "owner")]


@pytest.mark.parametrize("operation,rpc", [
    ("cancellation", "submit_event_cancellation_request"), ("change", "submit_session_change_request"),
])
def test_request_submission_reports_unexpected_database_failure(database, operation, rpc):
    database.responses[(f"rpc:{rpc}", "rpc")] = database_error()
    with pytest.raises(AuthError) as caught:
        if operation == "cancellation":
            events.submit_event_cancellation_request("token", "owner", "event", EventCancellationRequestSubmit(reason="Unavailable"))
        else:
            events.submit_event_change_request("token", "owner", "event", EventChangeRequestSubmit(**valid_change_request()))
    assert caught.value.status_code == 502


@pytest.mark.parametrize("operation,decision,reason", [
    ("cancellation", "invalid", "Reason"), ("cancellation", "approve", "  "),
    ("change", "invalid", None), ("change", "reject", None),
])
def test_invalid_review_inputs_do_not_reach_database(database, operation, decision, reason):
    with pytest.raises(AuthError) as caught:
        if operation == "cancellation":
            events.review_event_cancellation_request("token", "coordinator", "event", decision, reason)
        else:
            events.review_assigned_change_request("token", "coordinator", "event", decision)
    assert caught.value.status_code == 400
    assert database.calls == []
    config.get_user_client.assert_not_called()


@pytest.mark.parametrize("operation,code,message,status", [
    ("cancellation", "42501", "access denied", 403),
    ("cancellation", "PGRST301", "invalid JWT", 403),
    ("cancellation", "22023", "decision reason is required", 400),
    ("cancellation", "22023", "decision must be approve or reject", 400),
    ("cancellation", "XX000", "database unavailable", 502),
    ("change", "42501", "access denied", 403),
    ("change", "PGRST301", "invalid JWT", 403),
    ("change", "P0001", "not assigned to you", 404),
    ("change", "XX000", "database unavailable", 502),
])
def test_review_database_errors_preserve_access_and_validation_meaning(database, operation, code, message, status):
    rpc = "review_event_cancellation_request" if operation == "cancellation" else "approve_session_change_request"
    error = database_error(code, message)
    database.responses[(f"rpc:{rpc}", "rpc")] = error
    with pytest.raises(AuthError) as caught:
        if operation == "cancellation":
            events.review_event_cancellation_request("token", "coordinator", "event", "approve", "Valid reason")
        else:
            events.review_assigned_change_request("token", "coordinator", "event", "approve")
    assert caught.value.status_code == status
    assert caught.value.__cause__ is error


def test_change_review_cannot_report_success_without_database_result(database):
    with pytest.raises(AuthError, match="reviewed but its details could not be loaded") as caught:
        events.review_assigned_change_request("token", "coordinator", "event", "approve")
    assert caught.value.status_code == 502


@pytest.mark.parametrize("owners", [{}, {"organiser_id": "owner", "coordinator_id": "coordinator"}])
def test_clarification_history_requires_exactly_one_owner_context(database, owners):
    with pytest.raises(AuthError) as caught:
        events.list_event_clarifications("token", "event", **owners)
    assert caught.value.status_code == 403
    assert database.calls == []


def test_clarification_history_hides_nonvisible_event_and_does_not_read_history(database):
    with pytest.raises(AuthError, match="Event request was not found") as caught:
        events.list_event_clarifications("token", "event", organiser_id="owner")
    assert caught.value.status_code == 404
    assert database.calls_to("event_clarifications", "select") == []


@pytest.mark.parametrize("code", ["42P01", "42703", "PGRST202", "PGRST204", "PGRST205", "42883", "42501"])
def test_clarification_history_explains_schema_or_permission_failure(database, code):
    database.responses[("events", "select")] = [{"id": "event"}]
    database.responses[("event_clarifications", "select")] = database_error(code)
    with pytest.raises(AuthError) as caught:
        events.list_event_clarifications("token", "event", coordinator_id="coordinator")
    assert caught.value.status_code == (403 if code == "42501" else 503)
    assert ("permission" if code == "42501" else "event_clarifications.sql") in caught.value.message


@pytest.mark.parametrize("operation,code,message,status", [
    ("request", "42P01", "missing table", 503),
    ("request", "P0001", "only the assigned coordinator can request clarification", 403),
    ("request", "P0001", "event request was not found", 404),
    ("request", "XX000", "database unavailable", 502),
    ("respond", "PGRST202", "missing function", 503),
    ("respond", "P0001", "only the signed-in organiser can respond", 403),
    ("respond", "P0001", "event request was not found", 404),
    ("respond", "XX000", "database unavailable", 502),
])
def test_clarification_writes_stop_on_database_error(database, operation, code, message, status):
    rpc = "request_event_clarification" if operation == "request" else "respond_to_event_clarification"
    error = database_error(code, message)
    database.responses[(f"rpc:{rpc}", "rpc")] = error
    with pytest.raises(AuthError) as caught:
        if operation == "request":
            events.request_event_clarification("token", "coordinator", "event", EventClarificationRequest(notes="Please clarify"))
        else:
            events.respond_to_event_clarification("token", "owner", "event", EventClarificationResponse(response="Updated details"))
    assert caught.value.status_code == status
    assert caught.value.__cause__ is error
    assert len(database.calls) == 1


def test_organiser_contact_read_failure_does_not_look_like_missing_profile(database):
    database.responses[("profiles", "select")] = database_error("42501")
    with pytest.raises(AuthError, match="permission to view the event organiser") as caught:
        events.get_event_organiser("token", "owner")
    assert caught.value.status_code == 403
    assert database.calls[0].filters == [("eq", "id", "owner")]


@pytest.mark.parametrize("status", [EventStatus.CONFIRMED, EventStatus.DRAFT, EventStatus.COMPLETED])
def test_event_decision_cannot_skip_review_workflow(database, status):
    with pytest.raises(AuthError, match="Invalid event decision") as caught:
        events.decide_assigned_event("token", "coordinator", "event", status)
    assert caught.value.status_code == 400
    assert database.calls == []


def test_decision_fallback_read_failure_is_not_misreported_as_missing_event(database):
    database.responses[("events", "select")] = database_error("XX000")
    with pytest.raises(AuthError, match="Unable to save") as caught:
        events.decide_assigned_event("token", "coordinator", "event", EventStatus.PLANNING)
    assert caught.value.status_code == 502
    assert database.calls[0].filters == [
        ("eq", "id", "event"), ("eq", "coordinator_id", "coordinator"), ("eq", "status", "under_review"),
    ]
