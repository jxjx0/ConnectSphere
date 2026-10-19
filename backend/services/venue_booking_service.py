"""Venue booking persistence, review workflow, and block synchronization."""

from datetime import timedelta
from postgrest import APIError as PostgrestAPIError

import config
from models.venue_booking import VenueBookingCreateRequest, VenueBookingReviewRequest
from services.auth_service import AuthError
from services.notification_service import notify

from services.safety_review_service import check_and_update_safety_status


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


def check_schedule_conflict_details(client, venue_id: str, effective_start: str, effective_end: str) -> list[dict]:
    """Check for overlaps against existing operational blocks in venue_blocks."""
    blocks = (
        client.table("venue_blocks")
        .select("block_id, start_at, end_at, block_reason")
        .eq("venue_id", venue_id)
        .lt("start_at", effective_end)
        .gt("end_at", effective_start)
        .execute()
        .data
    )
    return blocks or []


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

    effective_start = request.start_at - timedelta(minutes=request.setup_buffer_minutes)
    effective_end = request.end_at + timedelta(minutes=request.teardown_buffer_minutes)

    effective_start_iso = effective_start.isoformat()
    effective_end_iso = effective_end.isoformat()

    try:
        if check_schedule_conflict_details(client, venue_id, effective_start_iso, effective_end_iso):
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
        "setup_buffer_minutes": request.setup_buffer_minutes,
        "teardown_buffer_minutes": request.teardown_buffer_minutes,
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

        conflicts = check_schedule_conflict_details(
            client, booking["venue_id"], booking["effective_start_at"], booking["effective_end_at"]
        )
        if conflicts:
            conflict = conflicts[0]
            raise AuthError(
                f"Cannot approve due to conflicting block '{conflict.get('block_reason')}' "
                f"from {conflict.get('start_at')} to {conflict.get('end_at')}.",
                status_code=409,
            )

        block_data = {
            "venue_id": booking["venue_id"],
            "start_at": booking["effective_start_at"],
            "end_at": booking["effective_end_at"],
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
            .update({"status": "APPROVED", "reviewed_by": reviewer_id})
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