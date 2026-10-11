"""Shared venue interval rules, calendar reads and booking integration boundary."""

from datetime import datetime, timedelta

from models.venue_search import OccupiedPeriod
from models.venue_availability import VenueAvailabilityRequest, VenueAvailabilityResponse
from postgrest import APIError as PostgrestAPIError
from pydantic import ValidationError

import config
from services.auth_service import AuthError


def get_venue_availability(access_token: str, request: VenueAvailabilityRequest):
    """Aggregate real block reads without claiming missing reservation checks."""
    from services.venue_block_service import read_operational_blocks

    client = config.get_user_client(access_token)
    venue_id = str(request.venue_id)
    try:
        records = (client.table("venues").select("id, name")
                   .eq("id", venue_id).execute().data)
        if not records:
            raise AuthError("Venue was not found.", status_code=404)
        venue = {"id": records[0]["id"], "name": records[0]["name"]}
        return VenueAvailabilityResponse(
            venue=venue, start_at=request.start_at, end_at=request.end_at,
            items=read_operational_blocks(client, venue_id, request.start_at, request.end_at),
        )
    except PostgrestAPIError as error:
        raise AuthError("Unable to load venue availability.", status_code=502) from error
    except (ValidationError, KeyError, TypeError) as error:
        raise AuthError("Unable to verify venue availability data.", status_code=502) from error


class BookingOccupancyUnavailable(Exception):
    """Booking/hold occupancy cannot yet be verified."""


def load_booking_occupancy(client, venue_ids: list[str]) -> dict[str, list[OccupiedPeriod]]:
    """Replace this adapter when the teammate's persistence contract lands.

    Return a key for EVERY requested venue (empty list means verified empty).
    Include confirmed bookings and unexpired active holds, with each interval
    already expanded by the authoritative setup/turnaround values. Hold expiry
    must use the booking owner's rule. Do not invent tables or status mappings.
    Use the caller's RLS-scoped client and propagate read failures.
    """
    raise BookingOccupancyUnavailable(
        "Booking and tentative hold availability cannot yet be verified."
    )


def effective_period(start: datetime, end: datetime, setup: int, turnaround: int):
    return start - timedelta(minutes=setup), end + timedelta(minutes=turnaround)


def overlaps(start: datetime, end: datetime, occupied: OccupiedPeriod) -> bool:
    """Half-open intervals: exactly touching occupied boundaries are allowed."""
    return start < occupied.end_at and occupied.start_at < end


def venue_buffers(record: dict) -> tuple[int, int] | None:
    """Consume optional read fields; never manufacture missing configuration."""
    values = (record.get("setup_time_minutes"), record.get("turnaround_time_minutes"))
    if any(value is None for value in values):
        return None
    if any(type(value) is not int or value < 0 for value in values):
        raise ValueError("venue durations must be non-negative whole minutes")
    return values
