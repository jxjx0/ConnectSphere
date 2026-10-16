"""Venue booking persistence, review workflow, and block synchronization."""

from datetime import timedelta
from postgrest import APIError as PostgrestAPIError

import config
from models.venue_booking import VenueBookingCreateRequest, VenueBookingReviewRequest
from services.auth_service import AuthError


def check_schedule_conflict(client, venue_id: str, effective_start: str, effective_end: str) -> bool:
    """Check for overlaps against existing operational blocks in venue_blocks."""
    blocks = (
        client.table("venue_blocks")
        .select("block_id")
        .eq("venue_id", venue_id)
        .lt("start_at", effective_end)
        .gt("end_at", effective_start)
        .execute()
        .data
    )
    return bool(blocks)


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

    # 1. Check for duplicate event/venue submission
    if request.event_id:
        check_duplicate_event_booking(client, venue_id, request.event_id)

    # 2. Compute effective time bounds including setup & teardown buffers
    effective_start = request.start_at - timedelta(minutes=request.setup_buffer_minutes)
    effective_end = request.end_at + timedelta(minutes=request.teardown_buffer_minutes)

    effective_start_iso = effective_start.isoformat()
    effective_end_iso = effective_end.isoformat()

    # 3. Check for schedule conflicts against venue_blocks
    try:
        if check_schedule_conflict(client, venue_id, effective_start_iso, effective_end_iso):
            raise AuthError(
                "The requested venue is unavailable during the selected time slot (including buffers).",
                status_code=409,
            )
    except PostgrestAPIError as error:
        raise AuthError("Unable to verify venue schedule availability.", status_code=502) from error

    # 4. Insert the record into Supabase
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
    """Approve or reject a request. On approval, synced into venue_blocks."""
    client = config.get_user_client(access_token)

    # 1. Fetch existing booking request
    booking_res = (
        client.table("venue_bookings")
        .select("*")
        .eq("booking_id", booking_id)
        .execute()
    )
    if not booking_res.data:
        raise AuthError("Booking request not found.", status_code=404)

    booking = booking_res.data[0]

    if booking["status"] != "PENDING_VENUE_APPROVAL":
        raise AuthError("This booking request has already been processed.", status_code=400)

    # 2. Process Approval
    if review.status == "APPROVED":
        # Re-check for conflicts before final approval
        if check_schedule_conflict(client, booking["venue_id"], booking["effective_start_at"], booking["effective_end_at"]):
            raise AuthError("Cannot approve booking due to a conflicting schedule block.", status_code=409)

        # FIXED (Bug 3): Reserve availability grid FIRST before marking status APPROVED
        block_data = {
            "venue_id": booking["venue_id"],
            "start_at": booking["effective_start_at"],
            "end_at": booking["effective_end_at"],
            "block_reason": f"Approved Booking ({booking['room_layout']})",
            "block_issuer": reviewer_id,
        }
        
        try:
            block_res = client.table("venue_blocks").insert(block_data).execute()
            if not block_res.data:
                raise AuthError("Failed to lock calendar operational block.", status_code=502)
        except PostgrestAPIError as error:
            raise AuthError("Unable to create calendar reservation block.", status_code=502) from error

        # Update booking status ONLY after calendar block insertion succeeds
        update_res = (
            client.table("venue_bookings")
            .update({"status": "APPROVED", "reviewed_by": reviewer_id})
            .eq("booking_id", booking_id)
            .execute()
        )

        return update_res.data[0]

    # 3. Process Rejection
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
    return update_res.data[0]