"""Shared venue interval rules, calendar reads and booking integration boundary."""

from datetime import datetime, time, timedelta, timezone

from models.venue import OperatingHours
from models.venue_search import OccupiedPeriod
from models.venue_availability import ApprovedVenueBooking, VenueAvailabilityRequest, VenueAvailabilityResponse
from postgrest import APIError as PostgrestAPIError
from pydantic import ValidationError

import config
from services.auth_service import AuthError


# Venue profiles use Singapore wall-clock hours, independent of browser offsets.
VENUE_TIMEZONE = timezone(timedelta(hours=8))


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


def read_approved_venue_bookings(client, venue_id: str) -> list[ApprovedVenueBooking]:
    """Read through the staff-only projection, not incomplete event RLS joins.

    The RPC returns one JSON value so the API row limit cannot silently truncate
    affected-booking checks. It is separate from the still-missing hold adapter.
    """
    records = client.rpc("get_venue_block_bookings", {"p_venue_id": venue_id}).execute().data
    if not isinstance(records, list):
        raise ValueError("approved booking data must be a complete list")
    bookings = [ApprovedVenueBooking.model_validate(record) for record in records]
    if any(booking.venue_id != venue_id for booking in bookings):
        raise ValueError("approved booking data must belong to the requested venue")
    if len({booking.booking_id for booking in bookings}) != len(bookings):
        raise ValueError("approved booking identities must be unique")
    return bookings


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


def within_operating_hours(start: datetime, end: datetime, hours: OperatingHours) -> bool:
    """Fit the whole occupied period into one of the venue's daily open windows."""
    if start.utcoffset() is None or end.utcoffset() is None:
        raise ValueError("operating-hours checks require explicit timezones")
    local_start = start.astimezone(VENUE_TIMEZONE)
    local_end = end.astimezone(VENUE_TIMEZONE)
    # The current profile model allows only same-day opening/closing hours.
    return (
        local_start < local_end
        and local_start.date() == local_end.date()
        and time.fromisoformat(hours.open) <= local_start.time()
        and local_end.time() <= time.fromisoformat(hours.close)
    )


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
