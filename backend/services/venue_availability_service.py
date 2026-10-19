"""Shared venue interval rules, calendar reads and booking integration boundary."""

from datetime import datetime, time, timedelta, timezone

from models.venue import OperatingHours
from models.venue_search import OccupiedPeriod
from models.venue_availability import ApprovedVenueBooking, AvailabilitySources, VenueAvailabilityRequest, VenueAvailabilityResponse
from models.venue_hold import ReservationItem
from httpx import HTTPError
from postgrest import APIError as PostgrestAPIError
from pydantic import ValidationError

import config
from services.auth_service import AuthError


# Venue profiles use Singapore wall-clock hours, independent of browser offsets.
VENUE_TIMEZONE = timezone(timedelta(hours=8))


def read_reservations(client, venue_ids, exclude_event_id=None, holds_only=False):
    """Scalar JSON avoids row caps without exposing other events' identities."""
    try:
        records = client.rpc("get_venue_reservations", {
            "p_venue_ids": venue_ids, "p_exclude_event_id": exclude_event_id,
            "p_holds_only": holds_only,
        }).execute().data
        if not isinstance(records, list):
            raise ValueError("reservation data must be a list")
        items = [ReservationItem.model_validate(row) for row in records]
        if any(item.venue_id not in venue_ids for item in items):
            raise ValueError("reservation belongs to another venue")
        if len({item.id for item in items}) != len(items):
            raise ValueError("duplicate reservations")
        return items
    except (PostgrestAPIError, HTTPError, ValidationError, ValueError, TypeError) as error:
        raise AuthError("Unable to verify venue reservations. Please try again.", status_code=502) from error


def get_venue_availability(access_token: str, request: VenueAvailabilityRequest):
    """Aggregate real block reads without claiming missing reservation checks."""
    from services.venue_block_service import read_operational_blocks

    client = config.get_user_client(access_token)
    venue_id = str(request.venue_id)
    try:
        records = (client.table("venues").select("id, name, setup_time_minutes, turnaround_time_minutes")
                   .eq("id", venue_id).execute().data)
        if not records:
            raise AuthError("Venue was not found.", status_code=404)
        venue = {"id": records[0]["id"], "name": records[0]["name"]}
        buffers_known = venue_buffers(records[0]) is not None
        reservations = read_reservations(client, [venue_id])
        reservations = [item for item in reservations if overlaps(request.start_at, request.end_at, item)]
        bookings = {item.id: item for item in reservations if item.type == "confirmed_booking"}
        legacy_ids = {block.id for item in reservations for block in item.legacy_blocks}
        blocks = []
        for item in read_operational_blocks(client, venue_id, request.start_at, request.end_at):
            booking = bookings.get(item.source_booking_id)
            if item.id in legacy_ids or (booking and booking.start_at <= item.start_at and item.end_at <= booking.end_at):
                continue
            blocks.append(item)
        return VenueAvailabilityResponse(
            venue=venue, start_at=request.start_at, end_at=request.end_at,
            items=sorted(blocks + reservations, key=lambda item: item.start_at),
            verification_status="partial" if not buffers_known or legacy_ids or any(
                item.source_booking_id is None and item.reason.startswith("Approved Booking:") for item in blocks
            ) else "verified",
            sources=AvailabilitySources(confirmed_bookings="verified", tentative_holds="verified",
                                        hold_expiry="verified", venue_buffers="verified" if buffers_known else "unavailable"),
        )
    except (PostgrestAPIError, HTTPError) as error:
        raise AuthError("Unable to load venue availability.", status_code=502) from error
    except (ValidationError, ValueError, KeyError, TypeError) as error:
        raise AuthError("Unable to verify venue availability data.", status_code=502) from error


class BookingOccupancyUnavailable(Exception):
    """Booking/hold occupancy cannot yet be verified."""


def read_approved_venue_bookings(client, venue_id: str) -> list[ApprovedVenueBooking]:
    """Read through the staff-only projection, not incomplete event RLS joins.

    The RPC returns one JSON value so the API row limit cannot silently truncate
    affected-booking checks.
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


def load_booking_occupancy(client, venue_ids: list[str], exclude_event_id=None) -> dict[str, list[OccupiedPeriod]]:
    """Booking snapshots and holds expanded by current venue configuration."""
    result = {venue_id: [] for venue_id in venue_ids}
    for item in read_reservations(client, venue_ids, exclude_event_id=exclude_event_id):
        result[item.venue_id].append(OccupiedPeriod(start_at=item.start_at, end_at=item.end_at))
    return result


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
