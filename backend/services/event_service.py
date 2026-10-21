"""Event request persistence through Supabase."""

from datetime import datetime, timezone

from postgrest import APIError as PostgrestAPIError

import config
from models.event import (
    Event,
    EventChangeRequest,
    EventChangeRequestDecision,
    EventChangeRequestSubmit,
    EventClarification,
    EventClarificationRequest,
    EventClarificationResponse,
    EventDraftRequest,
    EventOrganiser,
    EventReviewSummary,
    EventSession,
    EventSessionSubmit,
    EventStatus,
    EventSubmitRequest,
)
from services.auth_service import AuthError



def get_event_activity_logs(event_id: str, access_token: str):
    """Fetch audit history logs for an event and attach coordinator names."""
    client = config.get_user_client(access_token)

    logs = (
        client.table("event_activity_logs")
        .select("*")
        .eq("event_id", event_id)
        .order("created_at", desc=True)
        .execute()
        .data
    )
    if not logs:
        return []

    # Collect profile IDs to fetch coordinator names
    profile_ids = set()
    for log in logs:
        if log.get("previous_coordinator_id"):
            profile_ids.add(log["previous_coordinator_id"])
        if log.get("new_coordinator_id"):
            profile_ids.add(log["new_coordinator_id"])
        if log.get("changed_by_id"):
            profile_ids.add(log["changed_by_id"])

    profiles_map = {}
    if profile_ids:
        prof_data = (
            client.table("profiles")
            .select("id, full_name")
            .in_("id", list(profile_ids))
            .execute()
            .data
        )
        profiles_map = {p["id"]: p for p in prof_data}

    for log in logs:
        log["previous_coordinator"] = profiles_map.get(log.get("previous_coordinator_id"))
        log["new_coordinator"] = profiles_map.get(log.get("new_coordinator_id"))
        log["changed_by"] = profiles_map.get(log.get("changed_by_id"))

    return logs


def _database_error(error: PostgrestAPIError) -> AuthError:
    """Translate known PostgREST constraint errors into API responses."""
    if error.code in {"42703", "PGRST204", "PGRST205"}:
        return AuthError(
            "The database schema is missing a required field or table.",
            status_code=503,
        )
    if error.code in {"23502", "23514", "22P02"}:
        return AuthError(
            "Event data violates a database validation rule.",
            status_code=400,
        )
    if error.code == "23503":
        return AuthError(
            "The event refers to a user that does not exist.",
            status_code=400,
        )
    if error.code in {"42501", "PGRST301"}:
        return AuthError(
            "You do not have permission to submit this event request.",
            status_code=403,
        )
    return AuthError("Unable to save the event request.", status_code=502)


def _review_read_error(error: PostgrestAPIError, resource: str) -> AuthError:
    """Translate PostgREST failures from the coordinator read paths."""
    if error.code in {"42501", "PGRST301"}:
        return AuthError(
            f"You do not have permission to view {resource}.",
            status_code=403,
        )
    return AuthError(f"Unable to load {resource}.", status_code=502)


def _clarification_database_error(error: PostgrestAPIError) -> AuthError:
    """Give a direct setup hint when the clarification migration is missing."""
    if error.code in {
        "42P01", "42703", "PGRST202", "PGRST204", "PGRST205", "42883"
    }:
        return AuthError(
            "Clarification history is not available yet. Apply database/event_clarifications.sql, then refresh the API schema cache if needed.",
            status_code=503,
        )
    return _database_error(error)


def submit_event(
    access_token: str,
    organiser_id: str,
    request: EventSubmitRequest,
) -> Event:
    """Store a submitted event request and its sessions for the signed-in Organiser.

    organiser_id and status are set here rather than taken from the request
    body, so a caller cannot submit a request in someone else's name or
    skip the event straight to a later status. The database enforces the
    same rule again through row-level security.

    Sessions can only be written while an event is a draft, so the request
    is saved in three steps: insert it as a draft, save its sessions, then
    submit it. If the second or third step fails, the half-saved draft is
    removed so the Organiser is not left with a stray draft.
    """
    client = config.get_user_client(access_token)
    event = request.model_dump(mode="json", exclude={"sessions"})
    event["organiser_id"] = organiser_id
    event["status"] = EventStatus.DRAFT.value

    try:
        result = client.table("events").insert(event).execute()
    except PostgrestAPIError as error:
        raise _database_error(error) from error

    if not result.data:
        raise AuthError("Event request was not submitted.", status_code=502)
    event_id = result.data[0]["id"]

    try:
        sessions = _save_sessions(client, event_id, request.sessions)
        submitted = _update_my_draft(
            client,
            organiser_id,
            event_id,
            {"status": EventStatus.UNDER_REVIEW.value},
        )
    except AuthError:
        _discard_unsubmitted_draft(client, organiser_id, event_id)
        raise

    return submitted.model_copy(update={"sessions": sessions})


def _save_sessions(
    client, event_id: str, sessions: list[EventSessionSubmit]
) -> list[EventSession]:
    """Replace all of a draft's sessions with these, in one database call.

    replace_draft_sessions deletes and inserts in a single transaction, so a
    failure never leaves a draft with only some of its sessions. Row-level
    security only lets the Organiser change sessions of their own draft.
    """
    try:
        result = client.rpc(
            "replace_draft_sessions",
            {
                "p_event_id": event_id,
                "p_sessions": [
                    session.model_dump(mode="json") for session in sessions
                ],
            },
        ).execute()
    except PostgrestAPIError as error:
        # Row-level security refuses sessions for anything but the
        # Organiser's own draft: the same answer as a missing draft.
        if error.code in {"42501", "PGRST301"}:
            raise AuthError(DRAFT_NOT_FOUND, status_code=404) from error
        raise _database_error(error) from error

    if len(result.data or []) != len(sessions):
        raise AuthError("Event sessions were not saved.", status_code=502)
    return [EventSession(**row) for row in result.data]


def _discard_unsubmitted_draft(client, organiser_id: str, event_id: str) -> None:
    """Best-effort clean-up after a submission failed part-way through."""
    try:
        (
            client.table("events")
            .delete()
            .eq("id", event_id)
            .eq("organiser_id", organiser_id)
            .eq("status", EventStatus.DRAFT.value)
            .execute()
        )
    except PostgrestAPIError:
        pass


def list_my_events(access_token: str, organiser_id: str) -> list[Event]:
    """Return the Organiser's own submitted requests, soonest event first.

    Drafts are left out: an unsubmitted draft is not a request ConnectSphere
    is processing, and viewing drafts is its own story (T7-37).

    Row-level security already limits the rows to this Organiser's own. The
    organiser_id filter is here as well so the intent is visible in the
    code, not only in the database.
    """
    client = config.get_user_client(access_token)
    try:
        result = (
            client.table("events")
            .select("*")
            .eq("organiser_id", organiser_id)
            .neq("status", EventStatus.DRAFT.value)
            .order("start_time")
            .execute()
        )
    except PostgrestAPIError as error:
        raise _database_error(error) from error

    events = [Event(**event) for event in result.data]
    return _with_coordinator_names(client, events)


def _with_coordinator_names(client, events: list[Event]) -> list[Event]:
    """Swap each assigned coordinator's id for their name.

    Events with no Coordinator yet keep coordinator_name as None, which is
    what the page shows as "Not assigned yet".
    """
    coordinator_ids = {
        event.coordinator_id for event in events if event.coordinator_id
    }
    if not coordinator_ids:
        return events

    try:
        profiles = (
            client.table("profiles")
            .select("id, full_name")
            .in_("id", list(coordinator_ids))
            .execute()
        )
    except PostgrestAPIError as error:
        raise _database_error(error) from error

    names_by_id = {
        profile["id"]: profile.get("full_name") or "Unknown user"
        for profile in profiles.data
    }
    return [
        event.model_copy(
            update={"coordinator_name": names_by_id.get(event.coordinator_id)}
        )
        if event.coordinator_id
        else event
        for event in events
    ]


def get_my_event(access_token: str, organiser_id: str, event_id: str) -> Event:
    """Return one of the Organiser's own submitted requests.

    A request belonging to someone else is not an error the caller should
    be able to tell apart from one that does not exist -- both come back as
    404, so an id cannot be used to probe for other Organisers' events.
    """
    client = config.get_user_client(access_token)
    try:
        result = (
            client.table("events")
            .select("*")
            .eq("id", event_id)
            .eq("organiser_id", organiser_id)
            .neq("status", EventStatus.DRAFT.value)
            .execute()
        )
    except PostgrestAPIError as error:
        raise _database_error(error) from error

    if not result.data:
        raise AuthError("Event request was not found.", status_code=404)
    event = _with_coordinator_names(client, [Event(**result.data[0])])[0]
    return _with_change_request(client, [event])[0]


def _with_change_request(client, events: list[Event]) -> list[Event]:
    """Attach each event's latest proposal and its review outcome."""
    if not events:
        return events
    try:
        result = (
            client.table("event_change_requests")
            .select("*")
            .in_("event_id", [event.id for event in events])
            .order("created_at", desc=True)
            .execute()
        )
    except PostgrestAPIError as error:
        raise _review_read_error(error, "event change requests") from error

    latest_by_event = {}
    for row in result.data:
        latest_by_event.setdefault(row["event_id"], EventChangeRequest(**row))
    return [
        event.model_copy(
            update={
                "change_request": latest_by_event.get(event.id),
                "has_pending_change_request": (
                    latest_by_event.get(event.id) is not None
                    and latest_by_event[event.id].status == "pending"
                ),
            }
        )
        for event in events
    ]


def submit_event_change_request(
    access_token: str,
    organiser_id: str,
    event_id: str,
    request: EventChangeRequestSubmit,
) -> None:
    """Persist a proposed change and mark its event as change_requested.

    The database function performs ownership, event status, duplicate
    pending request, and changed-values checks atomically.
    """
    client = config.get_user_client(access_token)
    try:
        client.rpc(
            "submit_event_change_request",
            {
                "p_event_id": event_id,
                "p_organiser_id": organiser_id,
                "p_changes": request.model_dump(mode="json"),
            },
        ).execute()
    except PostgrestAPIError as error:
        message = str(error).lower()
        if "pending change request" in message:
            raise AuthError(
                "A change request is already waiting for review.",
                status_code=409,
            ) from error
        if "event cannot be changed" in message:
            raise AuthError(
                "Only events under review, in planning or confirmed can be "
                "changed.",
                status_code=409,
            ) from error
        if "no event details were changed" in message:
            raise AuthError(
                "Change at least one event detail before submitting.",
                status_code=400,
            ) from error
        raise _database_error(error) from error


# --- Draft event requests (T7-37) ------------------------------------------
#
# Every draft query filters on organiser_id and status = 'draft'. Row-level
# security enforces the same thing in the database; the filters are here so
# the intent is visible in the code too. A draft that belongs to someone
# else, or has already been submitted, comes back as 404 -- the same answer
# as one that does not exist.

DRAFT_NOT_FOUND = "Draft was not found."


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def create_draft(
    access_token: str,
    organiser_id: str,
    request: EventDraftRequest,
) -> Event:
    """Save a new, possibly incomplete, event request as a draft.

    As with submit_event, organiser_id and status are set here, never taken
    from the request body.
    """
    client = config.get_user_client(access_token)
    draft = request.model_dump(mode="json")
    draft["organiser_id"] = organiser_id
    draft["status"] = EventStatus.DRAFT.value

    try:
        result = client.table("events").insert(draft).execute()
    except PostgrestAPIError as error:
        raise _database_error(error) from error

    if not result.data:
        raise AuthError("Draft was not saved.", status_code=502)
    return Event(**result.data[0])


def list_my_drafts(access_token: str, organiser_id: str) -> list[Event]:
    """Return the Organiser's drafts, most recently edited first."""
    client = config.get_user_client(access_token)
    try:
        result = (
            client.table("events")
            .select("*")
            .eq("organiser_id", organiser_id)
            .eq("status", EventStatus.DRAFT.value)
            .order("updated_at", desc=True)
            .execute()
        )
    except PostgrestAPIError as error:
        raise _database_error(error) from error

    return [Event(**event) for event in result.data]


def get_my_draft(access_token: str, organiser_id: str, draft_id: str) -> Event:
    """Return one of the Organiser's drafts, to continue editing it."""
    client = config.get_user_client(access_token)
    try:
        result = (
            client.table("events")
            .select("*")
            .eq("id", draft_id)
            .eq("organiser_id", organiser_id)
            .eq("status", EventStatus.DRAFT.value)
            .execute()
        )
    except PostgrestAPIError as error:
        raise _database_error(error) from error

    if not result.data:
        raise AuthError(DRAFT_NOT_FOUND, status_code=404)
    return Event(**result.data[0])


def _update_my_draft(client, organiser_id: str, draft_id: str, values: dict):
    """Write values onto one of the Organiser's drafts and return the row.

    Shared by saving and submitting. The status filter means a draft that
    has already been submitted can no longer be changed this way.
    """
    values["updated_at"] = _now()
    try:
        result = (
            client.table("events")
            .update(values)
            .eq("id", draft_id)
            .eq("organiser_id", organiser_id)
            .eq("status", EventStatus.DRAFT.value)
            .execute()
        )
    except PostgrestAPIError as error:
        raise _database_error(error) from error

    if not result.data:
        raise AuthError(DRAFT_NOT_FOUND, status_code=404)
    return Event(**result.data[0])


def update_draft(
    access_token: str,
    organiser_id: str,
    draft_id: str,
    request: EventDraftRequest,
) -> Event:
    """Save the form as it now stands over an existing draft.

    Every field is written, so a field cleared in the form is cleared in
    the draft too.
    """
    client = config.get_user_client(access_token)
    return _update_my_draft(
        client, organiser_id, draft_id, request.model_dump(mode="json")
    )


def submit_draft(
    access_token: str,
    organiser_id: str,
    draft_id: str,
    request: EventSubmitRequest,
) -> Event:
    """Save the final sessions and details, then submit the draft.

    The request has passed the same EventSubmitRequest checks as a brand
    new submission, so a draft cannot be submitted incomplete. The database
    checks this again (events_complete_unless_draft).

    Sessions are saved first, while the event is still a draft. If the
    final update fails, the draft simply keeps its new sessions.
    """
    client = config.get_user_client(access_token)
    sessions = _save_sessions(client, draft_id, request.sessions)
    values = request.model_dump(mode="json", exclude={"sessions"})
    values["status"] = EventStatus.UNDER_REVIEW.value
    submitted = _update_my_draft(client, organiser_id, draft_id, values)
    return submitted.model_copy(update={"sessions": sessions})


def delete_draft(access_token: str, organiser_id: str, draft_id: str) -> None:
    """Discard one of the Organiser's drafts. Submitted events cannot be deleted."""
    client = config.get_user_client(access_token)
    try:
        result = (
            client.table("events")
            .delete()
            .eq("id", draft_id)
            .eq("organiser_id", organiser_id)
            .eq("status", EventStatus.DRAFT.value)
            .execute()
        )
    except PostgrestAPIError as error:
        raise _database_error(error) from error

    if not result.data:
        raise AuthError(DRAFT_NOT_FOUND, status_code=404)


def list_assigned_events(
    access_token: str, coordinator_id: str
) -> list[EventReviewSummary]:
    """Return every event assigned to this Coordinator, whatever its status.

    Decided events stay on the list so the Coordinator can keep working on
    them. Drafts are left out: they have not been submitted yet.
    """
    client = config.get_user_client(access_token)
    try:
        result = (
            client.table("events")
            .select("id, name, start_time, end_time, status, safety_status, equipment_requirements, venue_bookings(status), equipment_requests(status)")
            .eq("coordinator_id", coordinator_id)
            .neq("status", EventStatus.DRAFT.value)
            .order("start_time")
            .execute()
        )
    except PostgrestAPIError as error:
        raise _review_read_error(error, "assigned event requests") from error
    return [EventReviewSummary(**event) for event in result.data]


def get_assigned_event(
    access_token: str, coordinator_id: str, event_id: str
) -> Event:
    """Return one event assigned to the signed-in Coordinator."""
    client = config.get_user_client(access_token)
    try:
        result = (
            client.table("events")
            .select("*")
            .eq("id", event_id)
            .eq("coordinator_id", coordinator_id)
            .neq("status", EventStatus.DRAFT.value)
            .execute()
        )
    except PostgrestAPIError as error:
        raise _review_read_error(error, "the event request") from error

    if not result.data:
        raise AuthError("Event request was not found.", status_code=404)
    event = Event(**result.data[0])
    return _with_change_request(client, [event])[0]


def review_assigned_change_request(
    access_token: str,
    coordinator_id: str,
    event_id: str,
    decision: str,
    rejection: EventChangeRequestDecision | None = None,
) -> tuple[Event, EventChangeRequest]:
    """Approve or reject the pending proposal through an atomic database RPC."""
    if decision not in {"approve", "reject"}:
        raise AuthError("Invalid change request decision.", status_code=400)
    if decision == "reject" and rejection is None:
        raise AuthError("A rejection reason is required.", status_code=400)

    client = config.get_user_client(access_token)
    function_name = (
        "approve_event_change_request"
        if decision == "approve"
        else "reject_event_change_request"
    )
    params = {"p_event_id": event_id}
    if rejection is not None:
        params["p_rejection_reason"] = rejection.reason

    try:
        result = client.rpc(function_name, params).execute()
    except PostgrestAPIError as error:
        message = str(error).lower()
        if error.code in {"42501", "PGRST301"}:
            raise _review_read_error(error, "the event change request") from error
        if "not assigned" in message or "not found" in message:
            raise AuthError(
                "Change request was not found for an event assigned to you.",
                status_code=404,
            ) from error
        if (
            "no longer pending" in message
            or "not awaiting" in message
        ):
            raise AuthError(
                "This change request has already been reviewed.",
                status_code=409,
            ) from error
        raise _database_error(error) from error

    if not result.data:
        raise AuthError(
            "The change request was reviewed but its details could not be loaded.",
            status_code=502,
        )
    return (
        Event(**result.data["event"]),
        EventChangeRequest(**result.data["change_request"]),
    )


def list_event_clarifications(
    access_token: str,
    event_id: str,
    *,
    organiser_id: str | None = None,
    coordinator_id: str | None = None,
) -> list[EventClarification]:
    """Return clarification exchanges visible to the event's current user."""
    if (organiser_id is None) == (coordinator_id is None):
        raise AuthError("An event owner or assigned Coordinator is required.", 403)

    client = config.get_user_client(access_token)
    event_query = (
        client.table("events")
        .select("id")
        .eq("id", event_id)
        .neq("status", EventStatus.DRAFT.value)
    )
    if organiser_id:
        event_query = event_query.eq("organiser_id", organiser_id)
    else:
        event_query = event_query.eq("coordinator_id", coordinator_id)

    try:
        event_result = event_query.execute()
        if not event_result.data:
            raise AuthError("Event request was not found.", status_code=404)
        result = (
            client.table("event_clarifications")
            .select("*")
            .eq("event_id", event_id)
            .order("requested_at")
            .execute()
        )
    except PostgrestAPIError as error:
        raise _clarification_database_error(error) from error

    return [EventClarification(**row) for row in result.data]


def request_event_clarification(
    access_token: str,
    coordinator_id: str,
    event_id: str,
    request: EventClarificationRequest,
) -> EventClarification:
    """Save a Coordinator's clarification request and hold event planning."""
    client = config.get_user_client(access_token)
    try:
        client.rpc(
            "request_event_clarification",
            {
                "p_event_id": event_id,
                "p_coordinator_id": coordinator_id,
                "p_notes": request.notes,
            },
        ).execute()
    except PostgrestAPIError as error:
        message = str(error).lower()
        if error.code in {"42P01", "PGRST202", "42883"}:
            raise _clarification_database_error(error) from error
        if "only the assigned coordinator" in message:
            raise AuthError(
                "Only the assigned Coordinator can request clarification.",
                status_code=403,
            ) from error
        if "event request was not found" in message:
            raise AuthError("Event request was not found.", status_code=404) from error
        if "event cannot be clarified" in message:
            raise AuthError(
                "Only events under review, in planning, or with a change request can be sent for clarification.",
                status_code=409,
            ) from error
        raise _database_error(error) from error

    history = list_event_clarifications(
        access_token, event_id, coordinator_id=coordinator_id
    )
    return history[-1]


def respond_to_event_clarification(
    access_token: str,
    organiser_id: str,
    event_id: str,
    request: EventClarificationResponse,
) -> EventClarification:
    """Record the Organiser's response and return the event to review."""
    client = config.get_user_client(access_token)
    try:
        client.rpc(
            "respond_to_event_clarification",
            {
                "p_event_id": event_id,
                "p_organiser_id": organiser_id,
                "p_response": request.response,
            },
        ).execute()
    except PostgrestAPIError as error:
        message = str(error).lower()
        if error.code in {"42P01", "PGRST202", "42883"}:
            raise _clarification_database_error(error) from error
        if "only the signed-in organiser" in message:
            raise AuthError(
                "Only the event Organiser can respond to clarification.",
                status_code=403,
            ) from error
        if "event request was not found" in message:
            raise AuthError("Event request was not found.", status_code=404) from error
        if (
            "no clarification is awaiting a response" in message
            or "event is not awaiting clarification" in message
        ):
            raise AuthError(
                "This event is not awaiting a clarification response.",
                status_code=409,
            ) from error
        raise _database_error(error) from error

    history = list_event_clarifications(
        access_token, event_id, organiser_id=organiser_id
    )
    return history[-1]


def get_event_organiser(
    access_token: str, organiser_id: str
) -> EventOrganiser | None:
    """Return the contact details of an event's Organiser.

    Row-level security only lets a Coordinator read the profile of an
    Organiser whose event is assigned to them. None means the profile
    could not be read.
    """
    client = config.get_user_client(access_token)
    try:
        result = (
            client.table("profiles")
            .select("full_name, contact_number, organization")
            .eq("id", organiser_id)
            .execute()
        )
    except PostgrestAPIError as error:
        raise _review_read_error(error, "the event organiser") from error

    if not result.data:
        return None
    return EventOrganiser(**result.data[0])


def decide_assigned_event(
    access_token: str,
    coordinator_id: str,
    event_id: str,
    status: EventStatus,
) -> Event:
    """Approve or reject a reviewable request assigned to this Coordinator."""
    if status not in {EventStatus.PLANNING, EventStatus.REJECTED}:
        raise AuthError("Invalid event decision.", status_code=400)

    client = config.get_user_client(access_token)
    try:
        result = (
            client.table("events")
            .update({"status": status.value, "updated_at": _now()})
            .eq("id", event_id)
            .eq("coordinator_id", coordinator_id)
            .eq("status", EventStatus.UNDER_REVIEW.value)
            .execute()
        )
    except PostgrestAPIError as error:
        raise _database_error(error) from error

    if result.data:
        return Event(**result.data[0])

    # Nothing was updated: either the event is not assigned to this
    # Coordinator, or it has already been decided.
    try:
        existing = (
            client.table("events")
            .select("id")
            .eq("id", event_id)
            .eq("coordinator_id", coordinator_id)
            .neq("status", EventStatus.DRAFT.value)
            .execute()
        )
    except PostgrestAPIError as error:
        raise _database_error(error) from error

    if existing.data:
        raise AuthError(
            "Only a request under review can be approved or rejected.",
            status_code=409,
        )
    raise AuthError("Event request was not found.", status_code=404)
