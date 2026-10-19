"""Venue block persistence through Supabase."""

from httpx import HTTPError
from postgrest import APIError as PostgrestAPIError
from pydantic import ValidationError

import config
from models.venue_block import VenueBlockCreateRequest
from models.venue_availability import OperationalBlockItem
from models.venue_search import OccupiedPeriod
from services.auth_service import AuthError
from services import venue_availability_service as availability
from services.notification_service import notify


def read_operational_blocks(client, venue_id, start, end) -> list[OperationalBlockItem]:
    """Read half-open overlapping blocks through the caller's RLS client."""
    try:
        records = client.rpc("get_venue_operational_blocks", {
            "p_venue_ids": [venue_id], "p_start_at": start.isoformat(), "p_end_at": end.isoformat(),
        }).execute().data
        if not isinstance(records, list):
            raise ValueError("block data must be a complete list")
        items = []
        for record in records:
            if record["venue_id"] != venue_id:
                continue
            item = OperationalBlockItem(
                id=record["block_id"], start_at=record["start_at"],
                end_at=record["end_at"], reason=record["block_reason"],
                source_booking_id=record.get("source_booking_id"),
            )
            if availability.overlaps(start, end, item):
                items.append(item)
        if len({item.id for item in items}) != len(items):
            raise ValueError("duplicate blocks")
        return sorted(items, key=lambda item: item.start_at)
    except (PostgrestAPIError, HTTPError, ValidationError, KeyError, TypeError, ValueError) as error:
        raise AuthError("Unable to verify venue block data.", status_code=502) from error


def check_booking_impact(access_token: str, venue_id: str, request: VenueBlockCreateRequest) -> dict:
    """Mark affected approvals and notify without cancelling any arrangements."""
    client = config.get_user_client(access_token)
    try:
        bookings = availability.read_approved_venue_bookings(client, venue_id)
        affected = []
        for booking in bookings:
            start, end = availability.effective_period(
                booking.start_at, booking.end_at,
                booking.setup_time_minutes, booking.turnaround_time_minutes,
            )
            period = OccupiedPeriod(start_at=start, end_at=end)
            if availability.overlaps(request.start_at, request.end_at, period):
                affected.append({
                    "booking_id": booking.booking_id, "event_id": booking.event_id,
                    "event_name": booking.event_name, "coordinator_id": booking.coordinator_id,
                    "effective_start": start.isoformat(), "effective_end": end.isoformat(),
                    "venue_name": booking.venue_name,
                })
    except (PostgrestAPIError, HTTPError, ValidationError, ValueError, KeyError, TypeError, OverflowError):
        # The block is already saved: never turn an impact-read failure into a
        # failed creation response that encourages duplicate block submissions.
        return {"status": "unavailable", "affected_bookings": None}

    updates = _mark_affected_bookings(client, venue_id, affected)
    for booking in affected:
        booking["status_update"] = updates[booking["booking_id"]]
        booking["notification_status"] = (
            "not_required" if booking["status_update"] == "not_updated"
            else _notify_affected_coordinator(booking, request)
        )
    complete = all(booking["status_update"] == "updated" and booking["notification_status"] == "saved"
                   for booking in affected)
    return {"status": "verified" if complete else "partial", "affected_bookings": affected}


def _mark_affected_bookings(client, venue_id: str, affected: list[dict]) -> dict[str, str]:
    """One conditional UPDATE is atomic; never overwrite a concurrently changed status."""
    identities = {booking["booking_id"] for booking in affected}
    if not identities:
        return {}
    try:
        records = client.rpc("mark_venue_block_bookings_affected", {
            "p_venue_id": venue_id, "p_booking_ids": sorted(identities),
        }).execute().data
    except PostgrestAPIError:
        # The operational block stays saved. Still warn Coordinators, but make
        # the failed status update explicit to staff rather than claiming success.
        return dict.fromkeys(identities, "failed")
    except HTTPError:
        # A timeout may happen after commit; do not claim either success or rollback.
        return dict.fromkeys(identities, "unverified")
    try:
        if not isinstance(records, list):
            raise ValueError("status update response must be a list")
        changed = {record["booking_id"] for record in records
                   if record["status"] == "AFFECTED_BY_UNAVAILABILITY"}
        if len(changed) != len(records) or not changed <= identities:
            raise ValueError("status update response cannot be verified")
    except (ValueError, KeyError, TypeError):
        return dict.fromkeys(identities, "unverified")
    return {identity: "updated" if identity in changed else "not_updated" for identity in identities}


def _notify_affected_coordinator(booking: dict, request: VenueBlockCreateRequest) -> str:
    if not booking["coordinator_id"]:
        return "missing_coordinator"
    local_start = request.start_at.astimezone(availability.VENUE_TIMEZONE)
    local_end = request.end_at.astimezone(availability.VENUE_TIMEZONE)
    start = local_start.strftime("%d %b %Y, %H:%M")
    end = local_end.strftime("%H:%M" if local_start.date() == local_end.date() else "%d %b %Y, %H:%M")
    notification = notify(
        user_id=booking["coordinator_id"], notification_type="venue_booking_affected",
        title="Venue unavailable",
        body=(f"{booking['venue_name']} is unavailable: {start}–{end} (Singapore time). "
              f"This affects {booking['event_name'] or 'your booking'}. "
              f"Reason: {request.block_reason}. Please arrange another venue."),
        event_id=booking["event_id"],
    )
    # notify() confirms the in-app record only; email delivery is best-effort.
    return "saved" if notification is not None else "failed"


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
