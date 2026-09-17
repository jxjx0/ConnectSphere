"""Venue catalogue persistence through Supabase."""

from postgrest import APIError as PostgrestAPIError

import config
from models.venue_audit import VenueEditHistory
from models.venue import Venue, VenueCreateRequest, VenueUpdateRequest
from services.auth_service import AuthError


def _database_error(error: PostgrestAPIError) -> AuthError:
    """Translate known PostgREST constraint errors into API responses."""
    if error.code == "23505":
        return AuthError(
            "A venue with this name already exists.",
            status_code=409,
        )
    if error.code in {"23502", "23514", "22P02"}:
        return AuthError(
            "Venue data violates a database validation rule.",
            status_code=400,
        )
    if error.code in {"42501", "PGRST301"}:
        return AuthError(
            "You do not have permission to perform this venue action.",
            status_code=403,
        )
    return AuthError("Unable to access the venue catalogue.", status_code=502)


def create_venue(access_token: str, request: VenueCreateRequest) -> Venue:
    """Create a venue using the caller's RLS-scoped Supabase client."""
    client = config.get_user_client(access_token)
    try:
        result = (
            client.table("venues")
            .insert(request.model_dump(mode="json"))
            .execute()
        )
    except PostgrestAPIError as error:
        raise _database_error(error) from error

    if not result.data:
        raise AuthError("Venue was not created.", status_code=502)
    return Venue(**result.data[0])


def update_venue(
    access_token: str,
    venue_id: str,
    request: VenueUpdateRequest,
) -> Venue:
    """Update a venue using the caller's RLS-scoped Supabase client."""
    client = config.get_user_client(access_token)
    try:
        result = (
            client.table("venues")
            .update(request.model_dump(mode="json"))
            .eq("id", venue_id)
            .execute()
        )
    except PostgrestAPIError as error:
        raise _database_error(error) from error

    if not result.data:
        raise AuthError("Venue was not found.", status_code=404)
    return Venue(**result.data[0])


def get_venue_history(
    access_token: str,
    venue_id: str,
) -> list[VenueEditHistory]:
    """Return venue edit history, newest changes first."""
    client = config.get_user_client(access_token)
    try:
        result = (
            client.table("venue_edit_history")
            .select("*")
            .eq("venue_id", venue_id)
            .order("changed_at", desc=True)
            .execute()
        )
    except PostgrestAPIError as error:
        raise _database_error(error) from error

    history = [VenueEditHistory(**record) for record in result.data]
    user_ids = {record.changed_by for record in history}
    if not user_ids:
        return history

    try:
        profiles = (
            client.table("profiles")
            .select("id, full_name")
            .in_("id", list(user_ids))
            .execute()
        )
    except PostgrestAPIError as error:
        raise _database_error(error) from error

    names_by_id = {
        profile["id"]: profile.get("full_name") or "Unknown user"
        for profile in profiles.data
    }
    return [
        record.model_copy(
            update={"changed_by_name": names_by_id.get(record.changed_by, "Unknown user")}
        )
        for record in history
    ]


def list_venues(access_token: str) -> list[Venue]:
    """Return the venue catalogue using the caller's RLS-scoped client."""
    client = config.get_user_client(access_token)
    try:
        result = client.table("venues").select("*").order("name").execute()
    except PostgrestAPIError as error:
        raise _database_error(error) from error

    return [Venue(**venue) for venue in result.data]
