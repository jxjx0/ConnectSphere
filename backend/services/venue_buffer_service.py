"""Review newly conflicting approvals after a venue buffer edit has saved."""

from datetime import datetime, timezone

from httpx import HTTPError
from postgrest import APIError as PostgrestAPIError
from pydantic import ValidationError

from services import venue_availability_service as availability
from services.auth_service import AuthError
from services.notification_service import notify
from services.venue_block_service import mark_affected_bookings, read_operational_blocks


def _reservation_periods(item, previous):
    """Use the same authoritative windows as search/calendar, including snapshots."""
    old = previous.get(str(item.id))
    if old is None or old.type != item.type or (
        old.event_start_at, old.event_end_at
    ) != (item.event_start_at, item.event_end_at):
        raise ValueError("reservation changed during impact checking")
    return old, item


def _new_conflict(booking_periods, occupied_periods):
    old, new = booking_periods
    old_occupied, new_occupied = occupied_periods
    return (availability.overlaps(new.start_at, new.end_at, new_occupied)
            and not availability.overlaps(old.start_at, old.end_at, old_occupied))


def _affected_bookings(client, venue_id, previous_reservations):
    bookings = availability.read_approved_venue_bookings(client, venue_id)
    if not bookings:
        return []
    reservations = availability.read_reservations(client, [venue_id])
    confirmed = {str(item.id): item for item in reservations if item.type == "confirmed_booking"}
    approved = {booking.booking_id: booking for booking in bookings}
    if not approved.keys() <= confirmed.keys():
        raise ValueError("booking reads changed during impact checking")
    previous = {str(item.id): item for item in previous_reservations}
    periods = {identity: _reservation_periods(item, previous) for identity, item in confirmed.items()}
    if any((booking.start_at, booking.end_at) != (
        confirmed[booking.booking_id].event_start_at, confirmed[booking.booking_id].event_end_at
    ) for booking in bookings):
        raise ValueError("booking period changed during impact checking")

    bounds = [period for pair in periods.values() for period in pair]
    blocks = read_operational_blocks(client, venue_id,
                                     min(item.start_at for item in bounds), max(item.end_at for item in bounds))
    legacy_ids = {block.id for item in reservations for block in item.legacy_blocks}
    operational = []
    for block in blocks:
        if block.source_booking_id is not None or block.id in legacy_ids:
            continue
        if block.reason.startswith("Approved Booking:"):
            # Uncertain legacy provenance must not turn a booking's own lock into a conflict.
            raise ValueError("legacy booking reservation cannot be identified")
        operational.append(block)

    holds_by_event = {}
    affected = []
    for booking in bookings:
        event_id = booking.event_id
        if event_id not in holds_by_event:
            holds = availability.read_reservations(client, [venue_id], exclude_event_id=event_id, holds_only=True)
            holds_by_event[event_id] = []
            for hold in holds:
                if hold.type != "tentative_hold":
                    raise ValueError("hold projection contains another occupancy type")
                if hold.expires_at <= datetime.now(timezone.utc):
                    continue
                holds_by_event[event_id].append(_reservation_periods(hold, previous))
        occupied = [(block, block) for block in operational]
        occupied += [pair for identity, pair in periods.items() if identity != booking.booking_id]
        occupied += holds_by_event[event_id]
        if any(_new_conflict(periods[booking.booking_id], pair) for pair in occupied):
            _, new = periods[booking.booking_id]
            affected.append({
                "booking_id": booking.booking_id, "event_id": booking.event_id,
                "event_name": booking.event_name, "venue_name": booking.venue_name,
                "coordinator_id": booking.coordinator_id,
                "effective_start": new.start_at.isoformat(), "effective_end": new.end_at.isoformat(),
            })
    return affected


def check_buffer_impact(client, venue_id, previous_reservations):
    """The venue is already saved: report failures as incomplete impact checks."""
    try:
        affected = _affected_bookings(client, venue_id, previous_reservations)
    except (AuthError, PostgrestAPIError, HTTPError, ValidationError, ValueError, KeyError, TypeError, OverflowError):
        return {"status": "unavailable", "affected_bookings": None}

    updates = mark_affected_bookings(client, venue_id, affected)
    for booking in affected:
        booking["status_update"] = updates[booking["booking_id"]]
        if booking["status_update"] == "not_updated":
            booking["notification_status"] = "not_required"
        elif not booking["coordinator_id"]:
            booking["notification_status"] = "missing_coordinator"
        else:
            saved = notify(
                user_id=booking["coordinator_id"], notification_type="venue_booking_affected",
                title="Venue booking needs review",
                body=(f"Setup or turnaround times changed at {booking['venue_name']}. "
                      f"Your booking for {booking['event_name'] or 'this event'} now conflicts with another "
                      "venue arrangement. Please review the booking and arrange an alternative if needed."),
                event_id=booking["event_id"],
            )
            booking["notification_status"] = "saved" if saved is not None else "failed"
    complete = all(item["status_update"] == "updated" and item["notification_status"] == "saved"
                   for item in affected)
    return {"status": "verified" if complete else "partial", "affected_bookings": affected}
