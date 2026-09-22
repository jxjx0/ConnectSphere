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

