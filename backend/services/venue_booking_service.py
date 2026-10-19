"""Venue booking persistence, review workflow, and block synchronization."""

from datetime import datetime, timezone
from httpx import HTTPError
from postgrest import APIError as PostgrestAPIError

import config
from models.venue_booking import VenueBookingCreateRequest, VenueBookingReviewRequest
from services.auth_service import AuthError
from services.notification_service import notify
from services.venue_availability_service import read_reservations, venue_buffers, effective_period
from models.venue_search import OccupiedPeriod


def get_event_booking_context(access_token, event_id):
    """Use existing booking RLS and current-assignee hold RLS for event context."""
    client = config.get_user_client(access_token)
    try:
        bookings = (client.table("venue_bookings").select("*, venues(name)")
                    .eq("event_id", event_id).order("created_at", desc=True).execute().data)
        holds = (client.table("venue_tentative_holds").select("hold_id")
                 .eq("event_id", event_id).is_("released_at", "null")
                 .gt("expires_at", datetime.now(timezone.utc).isoformat()).limit(1).execute().data)
        if not isinstance(bookings, list) or not isinstance(holds, list):
            raise ValueError("incomplete venue context")
        return {"bookings": bookings, "has_active_venue_hold": bool(holds)}
    except (PostgrestAPIError, HTTPError, ValueError) as error:
        raise AuthError("Unable to load this event's venue arrangements.", status_code=502) from error


def _venue_configuration(client, venue_id):
    venues = (client.table("venues").select("setup_time_minutes, turnaround_time_minutes")
              .eq("id", venue_id).execute().data)
    if not venues:
        raise AuthError("Venue was not found.", status_code=404)
    return venues[0]


def _booking_occupancy(booking):
    """Current venue buffers are a floor; preserve any larger legacy reservation."""
    try:
        buffers = venue_buffers(booking.get("venues") or {})
        if buffers is None:
            raise ValueError("missing venue buffers")
        setup = max(buffers[0], booking.get("setup_buffer_minutes") or 0)
        turnaround = max(buffers[1], booking.get("teardown_buffer_minutes") or 0)
        def timestamp(value):
            parsed = value if isinstance(value, datetime) else datetime.fromisoformat(value.replace("Z", "+00:00"))
            if parsed.utcoffset() is None:
                raise ValueError("missing timezone")
            return parsed
        start, end = effective_period(timestamp(booking["start_at"]), timestamp(booking["end_at"]), setup, turnaround)
        if booking.get("effective_start_at"):
            start = min(start, timestamp(booking["effective_start_at"]))
        if booking.get("effective_end_at"):
            end = max(end, timestamp(booking["effective_end_at"]))
        return {"setup_buffer_minutes": setup, "teardown_buffer_minutes": turnaround,
                "effective_start_at": start, "effective_end_at": end}
    except (ValueError, TypeError, KeyError, OverflowError) as error:
        raise AuthError("Unable to verify venue buffers. Check the venue configuration.", status_code=502) from error


def get_pending_venue_bookings(access_token: str, venue_id: str | None = None) -> list[dict]:
    """Retrieve all venue bookings with status 'PENDING_VENUE_APPROVAL'."""
    client = config.get_user_client(access_token)

    query = (
        client.table("venue_bookings")
        .select("*, venues(*), events(name, expected_attendance)")
        .eq("status", "PENDING_VENUE_APPROVAL")
    )

    if venue_id:
        query = query.eq("venue_id", venue_id)

    result = query.order("created_at", desc=True).execute()
    return result.data or []


def check_schedule_conflict_details(client, venue_id: str, effective_start: str, effective_end: str, event_id=None) -> list[dict]:
    """Check recorded blocks and other events' active tentative holds."""
    blocks = (
        client.table("venue_blocks")
        .select("block_id, start_at, end_at, block_reason")
        .eq("venue_id", venue_id)
        .lt("start_at", effective_end)
        .gt("end_at", effective_start)
        .execute()
        .data
    )
    # The corresponding event can convert its own hold into a booking; other
    # events' active holds still reserve their effective periods.
    from services.venue_availability_service import overlaps
    period = OccupiedPeriod(start_at=effective_start, end_at=effective_end)
    holds = read_reservations(client, [venue_id], exclude_event_id=event_id, holds_only=True)
    return (blocks or []) + [{**item.model_dump(mode="json"), "block_reason": "Tentative hold"} for item in holds
                            if overlaps(period.start_at, period.end_at, item)]


def check_duplicate_event_booking(client, venue_id: str, event_id: str) -> None:
    """Prevent submitting multiple active booking requests for the same venue and event."""
    if not event_id:
        return

    existing = (
        client.table("venue_bookings")
        .select("booking_id, status")
        .eq("venue_id", venue_id)
        .eq("event_id", event_id)
        .neq("status", "REJECTED")
        .neq("status", "CANCELLED")
        .execute()
        .data
    )

    if existing:
        raise AuthError(
            "A booking request for this venue and event has already been submitted.",
            status_code=409,
        )


def create_venue_booking(
    access_token: str,
    venue_id: str,
    request: VenueBookingCreateRequest,
    coordinator_id: str,
) -> dict:
    """Submit a venue booking request with status set to PENDING_VENUE_APPROVAL."""
    client = config.get_user_client(access_token)

    if request.event_id:
        check_duplicate_event_booking(client, venue_id, request.event_id)

    try:
        venue = _venue_configuration(client, venue_id)
        occupancy = _booking_occupancy({"start_at": request.start_at, "end_at": request.end_at,
            "setup_buffer_minutes": request.setup_buffer_minutes,
            "teardown_buffer_minutes": request.teardown_buffer_minutes, "venues": venue})
    except PostgrestAPIError as error:
        raise AuthError("Unable to verify venue buffers.", status_code=502) from error
    effective_start = occupancy["effective_start_at"]
    effective_end = occupancy["effective_end_at"]

    effective_start_iso = effective_start.isoformat()
    effective_end_iso = effective_end.isoformat()

    try:
        if check_schedule_conflict_details(client, venue_id, effective_start_iso, effective_end_iso, request.event_id):
            raise AuthError(
                "The requested venue is unavailable during the selected time slot (including buffers).",
                status_code=409,
            )
    except PostgrestAPIError as error:
        raise AuthError("Unable to verify venue schedule availability.", status_code=502) from error

    data = {
        "venue_id": venue_id,
        "coordinator_id": coordinator_id,
        "event_id": request.event_id,
        "room_layout": request.room_layout,
        "start_at": request.start_at.isoformat(),
        "end_at": request.end_at.isoformat(),
        "setup_buffer_minutes": occupancy["setup_buffer_minutes"],
        "teardown_buffer_minutes": occupancy["teardown_buffer_minutes"],
        "effective_start_at": effective_start_iso,
        "effective_end_at": effective_end_iso,
        "status": "PENDING_VENUE_APPROVAL",
    }

    try:
        result = client.table("venue_bookings").insert(data).execute()
    except PostgrestAPIError as error:
        raise AuthError("Unable to submit venue booking request.", status_code=502) from error

    if not result.data:
        raise AuthError("Venue booking request was not created.", status_code=502)

    return result.data[0]


def review_venue_booking(
    access_token: str,
    booking_id: str,
    reviewer_id: str,
    review: VenueBookingReviewRequest,
) -> dict:
    """Approve or reject a request. On approval/rejection, dispatches a notification to the event coordinator."""
    client = config.get_user_client(access_token)

    booking_res = (
        client.table("venue_bookings")
        .select("*, venues(*), events(name, expected_attendance)")
        .eq("booking_id", booking_id)
        .execute()
    )
    if not booking_res.data:
        raise AuthError("Booking request not found.", status_code=404)

    booking = booking_res.data[0]

    if booking["status"] != "PENDING_VENUE_APPROVAL":
        raise AuthError("This booking request has already been processed.", status_code=400)

    venue = booking.get("venues") or {}
    event = booking.get("events") or {}

    if review.status == "APPROVED":
        supported_layouts = venue.get("layouts") or []
        if isinstance(supported_layouts, dict):
            supported_layouts = [{"name": k, "capacity": v} for k, v in supported_layouts.items()]

        requested_layout = booking.get("room_layout", "")
        expected_attendance = event.get("expected_attendance") or booking.get("expected_attendance") or 0

        layout_match = next(
            (
                layout for layout in supported_layouts
                if isinstance(layout, dict) and layout.get("name", "").strip().lower() == requested_layout.strip().lower()
            ),
            None,
        )

        if not layout_match:
            raise AuthError(
                f"Invalid request: Venue does not support requested layout '{requested_layout}'.",
                status_code=400,
            )

        max_capacity = layout_match.get("capacity", 0)
        if expected_attendance > max_capacity:
            raise AuthError(
                f"Invalid request: Expected attendance ({expected_attendance}) exceeds capacity ({max_capacity}) for layout '{requested_layout}'.",
                status_code=400,
            )

        occupancy = _booking_occupancy(booking)
        occupied = {key: value.isoformat() if isinstance(value, datetime) else value
                    for key, value in occupancy.items()}
        conflicts = check_schedule_conflict_details(
            client, booking["venue_id"], occupied["effective_start_at"], occupied["effective_end_at"], booking.get("event_id")
        )
        if conflicts:
            conflict = conflicts[0]
            raise AuthError(
                f"Cannot approve due to conflicting block '{conflict.get('block_reason')}' "
                f"from {conflict.get('start_at')} to {conflict.get('end_at')}.",
                status_code=409,
            )

        block_data = {
            "source_booking_id": booking_id,
            "venue_id": booking["venue_id"],
            "start_at": occupied["effective_start_at"],
            "end_at": occupied["effective_end_at"],
            "block_reason": f"Approved Booking: {event.get('name', 'Event')} ({requested_layout})",
            "block_issuer": reviewer_id,
        }

        try:
            block_res = client.table("venue_blocks").insert(block_data).execute()
            if not block_res.data:
                raise AuthError("Failed to lock calendar operational block.", status_code=502)
        except PostgrestAPIError as error:
            raise AuthError("Unable to create calendar reservation block.", status_code=502) from error

        update_res = (
            client.table("venue_bookings")
            .update({"status": "APPROVED", "reviewed_by": reviewer_id, **occupied})
            .eq("booking_id", booking_id)
            .execute()
        )

        approved_booking = update_res.data[0]

        # Dispatch notification with positional notification_type
        if booking.get("coordinator_id"):
            notify(
                booking["coordinator_id"],
                "venue_booking_approved",
                title="Venue Booking Approved",
                body=f"Your venue booking request for '{venue.get('name', 'the requested venue')}' has been approved.",
            )

        return approved_booking

    update_res = (
        client.table("venue_bookings")
        .update({
            "status": "REJECTED",
            "rejection_reason": review.rejection_reason,
            "reviewed_by": reviewer_id,
        })
        .eq("booking_id", booking_id)
        .execute()
    )

    rejected_booking = update_res.data[0]

    # Dispatch notification with positional notification_type
    if booking.get("coordinator_id"):
        reason_text = f" Reason: {review.rejection_reason}" if review.rejection_reason else ""
        notify(
            booking["coordinator_id"],
            "venue_booking_rejected",
            title="Venue Booking Rejected",
            body=f"Your venue booking request for '{venue.get('name', 'the requested venue')}' was rejected.{reason_text}",
        )

    return rejected_booking
