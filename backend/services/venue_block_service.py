"""Venue block persistence through Supabase."""

from postgrest import APIError as PostgrestAPIError

import config
from models.venue_block import VenueBlockCreateRequest
from services.auth_service import AuthError


def check_booking_impact(access_token: str, venue_id: str, request: VenueBlockCreateRequest) -> dict:
    """Integration boundary: unavailable is not a verified empty booking list.

    TODO T7-90/T7-33: use authoritative booking reads with booking/event/
    coordinator identities and configured effective periods. Compare with
    availability.overlaps(), then reuse notification_service.notify(). A
    verified result carries affected_bookings (an empty list means none).
    Do not claim verification without persisted buffers or notification success
    when notify() fails. No booking/event writes belong here.
    """
    return {"status": "unavailable", "affected_bookings": None}


def create_venue_block_outcome(access_token, venue_id, request, block_issuer) -> dict:
    # Operational unavailability must be saved even when bookings overlap.
    block = create_venue_block(access_token, venue_id, request, block_issuer)
    return {
        "block": block,
        "booking_impact": check_booking_impact(access_token, venue_id, request),
    }


def _database_error(error: PostgrestAPIError) -> AuthError:
    """Translate known PostgREST constraint errors into API responses."""
    if error.code in {"23502", "23514", "22P02"}:
        return AuthError(
            "Venue block data violates a database validation rule.",
            status_code=400,
        )
    if error.code == "23503":
        return AuthError(
            "The specified venue or block issuer does not exist.",
            status_code=400,
        )
    if error.code in {"42501", "PGRST301"}:
        return AuthError(
            "You do not have permission to create a venue block.",
            status_code=403,
        )
    return AuthError("Unable to create the venue block.", status_code=502)


def create_venue_block(
    access_token: str,
    venue_id: str,
    request: VenueBlockCreateRequest,
    block_issuer: str,
):
    """Create a venue block using the caller's RLS-scoped Supabase client."""
    client = config.get_user_client(access_token)

    data = {
        "venue_id": venue_id,
        "start_at": request.start_at.isoformat(),
        "end_at": request.end_at.isoformat(),
        "block_reason": request.block_reason,
        "block_issuer": block_issuer,
    }

    try:
        result = (
            client.table("venue_blocks")
            .insert(data)
            .execute()
        )
    except PostgrestAPIError as error:
        raise _database_error(error) from error

    if not result.data:
        raise AuthError("Venue block was not created.", status_code=502)

    return result.data[0]
