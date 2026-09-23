"""Event request persistence through Supabase."""

from postgrest import APIError as PostgrestAPIError

import config
from models.event import Event, EventStatus, EventSubmitRequest
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
    event["status"] = EventStatus.SUBMITTED.value

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
    return _with_coordinator_names(client, [Event(**result.data[0])])[0]
