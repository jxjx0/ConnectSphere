"""Event request persistence through Supabase."""

from datetime import datetime, timezone

from postgrest import APIError as PostgrestAPIError

import config
from models.event import (
    Event,
    EventChangeRequestSubmit,
    EventDraftRequest,
    EventReviewSummary,
    EventStatus,
    EventSubmitRequest,
)
from services.auth_service import AuthError


def _database_error(error: PostgrestAPIError) -> AuthError:
    """Translate known PostgREST constraint errors into API responses."""
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


def submit_event(
    access_token: str,
    organiser_id: str,
    request: EventSubmitRequest,
) -> Event:
    """Store a submitted event request for the signed-in Organiser.

    organiser_id and status are set here rather than taken from the request
    body, so a caller cannot submit a request in someone else's name or
    skip the event straight to a later status. The database enforces the
    same rule again through row-level security.
    """
    client = config.get_user_client(access_token)
    event = request.model_dump(mode="json")
    event["organiser_id"] = organiser_id
    event["status"] = EventStatus.UNDER_REVIEW.value

    try:
        result = client.table("events").insert(event).execute()
    except PostgrestAPIError as error:
        raise _database_error(error) from error

    if not result.data:
        raise AuthError("Event request was not submitted.", status_code=502)
    return Event(**result.data[0])


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
    return _with_pending_change_requests(client, [event])[0]


def _with_pending_change_requests(client, events: list[Event]) -> list[Event]:
    """Add whether an event is waiting for a change request review."""
    if not events:
        return events
    try:
        result = (
            client.table("event_change_requests")
            .select("event_id")
            .in_("event_id", [event.id for event in events])
            .eq("status", "pending")
            .execute()
        )
    except PostgrestAPIError as error:
        raise _database_error(error) from error

    pending_ids = {row["event_id"] for row in result.data}
    return [
        event.model_copy(
            update={"has_pending_change_request": event.id in pending_ids}
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
    """Save the final details and submit the draft, in one update.

    The request has passed the same EventSubmitRequest checks as a brand
    new submission, so a draft cannot be submitted incomplete. The database
    checks this again (events_complete_unless_draft).
    """
    client = config.get_user_client(access_token)
    values = request.model_dump(mode="json")
    values["status"] = EventStatus.UNDER_REVIEW.value
    return _update_my_draft(client, organiser_id, draft_id, values)


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


def list_assigned_submitted_events(
    access_token: str, coordinator_id: str
) -> list[EventReviewSummary]:
    """Return assigned requests that are awaiting a Coordinator decision."""
    client = config.get_user_client(access_token)
    try:
        result = (
            client.table("events")
            .select("id, name, start_time, end_time, status")
            .eq("coordinator_id", coordinator_id)
            .eq("status", EventStatus.UNDER_REVIEW.value)
            .order("start_time")
            .execute()
        )
    except PostgrestAPIError as error:
        raise _review_read_error(error, "assigned event requests") from error
    return [EventReviewSummary(**event) for event in result.data]


def get_assigned_submitted_event(
    access_token: str, coordinator_id: str, event_id: str
) -> Event:
    """Return one reviewable request assigned to the signed-in Coordinator."""
    client = config.get_user_client(access_token)
    try:
        result = (
            client.table("events")
            .select("*")
            .eq("id", event_id)
            .eq("coordinator_id", coordinator_id)
            .eq("status", EventStatus.UNDER_REVIEW.value)
            .execute()
        )
    except PostgrestAPIError as error:
        raise _review_read_error(error, "the event request") from error

    if not result.data:
        raise AuthError("Event request was not found.", status_code=404)
    return Event(**result.data[0])


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
            .update({"status": status.value})
            .eq("id", event_id)
            .eq("coordinator_id", coordinator_id)
            .eq("status", EventStatus.UNDER_REVIEW.value)
            .select("*")
            .execute()
        )
    except PostgrestAPIError as error:
        raise _review_read_error(error, "the event decision") from error

    if not result.data:
        raise AuthError(
            "Only an assigned submitted event can be decided.",
            status_code=404,
        )
    return Event(**result.data[0])


def list_assigned_event_documents(
    access_token: str, coordinator_id: str, event_id: str
) -> list[dict]:
    """Return signed links for documents on this Coordinator's reviewable event."""
    client = config.get_user_client(access_token)
    try:
        event = (
            client.table("events")
            .select("id")
            .eq("id", event_id)
            .eq("coordinator_id", coordinator_id)
            .eq("status", EventStatus.UNDER_REVIEW.value)
            .execute()
        )
        if not event.data:
            raise AuthError("Event request was not found.", status_code=404)

        result = (
            client.table("event_documents")
            .select("id, file_name, storage_path, created_at")
            .eq("event_id", event_id)
            .order("created_at")
            .execute()
        )
    except PostgrestAPIError as error:
        raise _review_read_error(error, "supporting documents") from error

    documents = []
    for document in result.data:
        try:
            signed = client.storage.from_(
                "event-supporting-documents"
            ).create_signed_url(document["storage_path"], 3600)
        except PostgrestAPIError as error:
            raise _review_read_error(error, "supporting documents") from error
        url = signed.get("signedURL") or signed.get("signedUrl")
        if not url:
            raise AuthError("Unable to access a supporting document.", status_code=502)
        documents.append(
            {
                "id": document["id"],
                "file_name": document["file_name"],
                "url": url,
                "created_at": document.get("created_at"),
            }
        )
    return documents
