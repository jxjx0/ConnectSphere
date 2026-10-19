"""Venue catalogue persistence through Supabase."""

from postgrest import APIError as PostgrestAPIError
from httpx import HTTPError

import config
from models.venue_audit import VenueEditHistory
from models.venue import Venue, VenueCreateRequest, VenueUpdateRequest, VenueUpdateResult
from services.venue_availability_service import read_reservations, venue_buffers
from services.venue_buffer_service import check_buffer_impact
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
) -> VenueUpdateResult:
    """Update a venue using the caller's RLS-scoped Supabase client."""
    client = config.get_user_client(access_token)
    # Older clients may omit these fields; omission must not reset configuration.
    omitted_buffers = {"setup_time_minutes", "turnaround_time_minutes"} - request.model_fields_set
    previous_buffers = None
    previous_reservations = None
    checking_buffers = len(omitted_buffers) < 2
    if checking_buffers:
        try:
            previous = (client.table("venues").select("setup_time_minutes, turnaround_time_minutes")
                        .eq("id", venue_id).execute().data)
            if previous:
                previous_buffers = venue_buffers(previous[0])
                if previous_buffers is not None:
                    requested_buffers = tuple(
                        getattr(request, name) if name not in omitted_buffers else previous_buffers[index]
                        for index, name in enumerate(("setup_time_minutes", "turnaround_time_minutes"))
                    )
                    if requested_buffers != previous_buffers:
                        # Capture the old windows before the RPC starts applying the new buffers.
                        previous_reservations = read_reservations(client, [venue_id])
        except (AuthError, PostgrestAPIError, HTTPError, ValueError, KeyError, TypeError):
            # A failed comparison must not prevent the venue edit itself.
            previous_buffers = None
    try:
        result = (
            client.table("venues")
            .update(request.model_dump(mode="json", exclude=omitted_buffers))
            .eq("id", venue_id)
            .execute()
        )
    except PostgrestAPIError as error:
        raise _database_error(error) from error

    if not result.data:
        raise AuthError("Venue was not found.", status_code=404)
    venue = VenueUpdateResult(**result.data[0])
    if checking_buffers:
        current_buffers = venue_buffers(result.data[0])
        if previous_buffers is None or current_buffers is None:
            venue.buffer_impact = {"status": "unavailable", "affected_bookings": None}
        elif previous_buffers != current_buffers:
            venue.buffer_impact = (
                {"status": "unavailable", "affected_bookings": None}
                if previous_reservations is None
                else check_buffer_impact(client, venue_id, previous_reservations)
            )
    return venue


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
