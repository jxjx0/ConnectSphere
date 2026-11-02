"""Venue booking persistence, review workflow, and block synchronization."""

from datetime import datetime, timezone
import logging
from httpx import HTTPError
from postgrest import APIError as PostgrestAPIError

import config
from models.profile import Role
from models.venue_booking import (
    VenueBookingCancelRequest,
    VenueBookingCreateRequest,
    VenueBookingReviewRequest,
)
from services import venue_availability_service as availability
from services.auth_service import AuthError
from services.notification_service import notify, notify_role
from services.venue_availability_service import read_reservations, venue_buffers, effective_period
from models.venue_search import OccupiedPeriod


logger = logging.getLogger(__name__)


def get_event_booking_context(access_token, event_id):
    """Use existing booking RLS and current-assignee hold RLS for event context."""
    client = config.get_user_client(access_token)
    try:
        bookings = (client.table("venue_bookings").select("*, venues(name), session:event_sessions(name)")
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
    venues = (client.table("venues").select("setup_time_minutes, turnaround_time_minutes, operating_hours")
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

# Requests that still hold, or may soon hold, the venue for their event.
LIVE_BOOKING_STATUSES = ("PENDING_VENUE_APPROVAL", "APPROVED")


def _hours_label(operating_hours) -> str:
    if isinstance(operating_hours, dict) and operating_hours.get("open") and operating_hours.get("close"):
        return f"{operating_hours['open']} - {operating_hours['close']}"
    return "unknown"


def get_pending_venue_bookings(access_token: str, venue_id: str | None = None) -> list[dict]:
    """Retrieve all venue bookings with status 'PENDING_VENUE_APPROVAL'."""
    client = config.get_user_client(access_token)

    query = (
        client.table("venue_bookings")
        .select("*, venues(*), events(name, expected_attendance), session:event_sessions(name, expected_attendance)")
        .eq("status", "PENDING_VENUE_APPROVAL")
    )

    if venue_id:
        query = query.eq("venue_id", venue_id)

    result = query.order("created_at", desc=True).execute()
    bookings = result.data or []
    # Event/session joins respect RLS and may be null for Venue Staff.
    # Resolve only the missing names, without granting access to either record.
    missing_ids = [booking["booking_id"] for booking in bookings
                   if (booking.get("event_id") and not (booking.get("events") or {}).get("name"))
                   or (booking.get("session_id") and not (booking.get("session") or {}).get("name"))]
    if not missing_ids:
        return bookings

    try:
        names = client.rpc("get_venue_booking_event_names", {"p_booking_ids": missing_ids}).execute().data
        if not isinstance(names, list) or any(
            not isinstance(row, dict) or row.get("booking_id") not in missing_ids
            or not isinstance(row.get("event_name"), str) or not row["event_name"].strip()
            or "session_name" not in row
            or (row["session_name"] is not None and (
                not isinstance(row["session_name"], str) or not row["session_name"].strip()))
            for row in names
        ) or len({row["booking_id"] for row in names}) != len(names):
            raise ValueError("Invalid booking names")
    except (PostgrestAPIError, HTTPError, ValueError):
        # Names are optional display metadata. Keep the existing list usable
        # before migration rollout or on lookup failure; never invent names.
        logger.warning("Booking name lookup unavailable; returning the existing booking list.")
        return bookings

    names_by_booking = {row["booking_id"]: row for row in names}
    enriched = []
    for booking in bookings:
        names = names_by_booking.get(booking["booking_id"])
        if names:
            booking = {**booking, "events": {**(booking.get("events") or {}), "name": names["event_name"]}}
            if names["session_name"] is not None:
                booking["session"] = {**(booking.get("session") or {}), "name": names["session_name"]}
        enriched.append(booking)
    return enriched


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


def _parse_timestamp(value) -> datetime:
    return value if isinstance(value, datetime) else datetime.fromisoformat(
        value.replace("Z", "+00:00")
    )


def check_booking_session(client, request: VenueBookingCreateRequest) -> None:
    """The booking's session must belong to its event and fit inside the booking.

    A booking must cover the whole session (section 9.1 of the scope doc):
    start no later than the session starts and end no earlier than it ends.
    Setup and turnaround buffers are added around the booking separately.
    """
    try:
        rows = (
            client.table("event_sessions")
            .select("id, event_id, name, start_time, end_time")
            .eq("id", request.session_id)
            .execute()
            .data
        )
    except PostgrestAPIError as error:
        raise AuthError("Unable to verify the event session.", status_code=502) from error

    if not rows or rows[0].get("event_id") != request.event_id:
        raise AuthError("That session does not belong to this event.", status_code=400)

    session = rows[0]
    if not session.get("start_time") or not session.get("end_time"):
        raise AuthError("That session has no scheduled time yet.", status_code=400)

    session_start = _parse_timestamp(session["start_time"])
    session_end = _parse_timestamp(session["end_time"])
    if request.start_at > session_start or request.end_at < session_end:
        raise AuthError(
            f"The booking must cover the whole of {session.get('name') or 'the session'} "
            f"({_local_label(session_start)} – {_local_label(session_end)}).",
            status_code=400,
        )


def _local_label(value: datetime) -> str:
    """A time as Singapore staff read it, e.g. '7 Dec 2026, 09:00'."""
    return value.astimezone(availability.VENUE_TIMEZONE).strftime("%d %b %Y, %H:%M")


# Venues are requested only once the event request is approved. An Under
# review event may be held by Venue Staff, but not booked.
BOOKABLE_EVENT_STATUSES = ("planning", "confirmed")


def check_event_is_bookable(client, event_id: str) -> None:
    """Refuse venue requests for events that are not approved, or not assigned.

    Row-level security only returns events assigned to the signed-in
    Coordinator, so an event that is not theirs comes back as not found.
    """
    try:
        rows = client.table("events").select("status").eq("id", event_id).execute().data
    except PostgrestAPIError as error:
        raise AuthError("Unable to verify the event request.", status_code=502) from error

    if not rows:
        raise AuthError("Event request was not found.", status_code=404)
    if rows[0].get("status") not in BOOKABLE_EVENT_STATUSES:
        raise AuthError(
            "Approve this event request before requesting a venue.",
            status_code=409,
        )


def check_duplicate_session_booking(client, session_id: str) -> None:
    """One live venue request per session; settled requests may be retried.

    Per session rather than per venue and event, so the same venue can be
    booked for different sessions of one event (W9).
    """
    existing = (
        client.table("venue_bookings")
        .select("booking_id, status")
        .eq("session_id", session_id)
        .in_("status", list(LIVE_BOOKING_STATUSES))
        .execute()
        .data
    )

    if existing:
        raise AuthError(
            "This session already has a venue booking request. Each session "
            "has one venue; a rejected or cancelled request can be replaced.",
            status_code=409,
        )


def review_venue_booking(
    access_token: str,
    booking_id: str,
    reviewer_id: str,
    review: VenueBookingReviewRequest,
) -> dict:
    """Approve or reject a request. On approval, verifies operating hours and attaches booking_id to venue_blocks."""
    client = config.get_user_client(access_token)

    booking_res = (
        client.table("venue_bookings")
        .select("*, venues(*), events(name, expected_attendance), session:event_sessions(name, expected_attendance)")
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
        # Each venue is checked against its own session (W7 change 3);
        # bookings from before sessions fall back to the event's attendance.
        session = booking.get("session") or {}
        expected_attendance = (
            session.get("expected_attendance")
            or event.get("expected_attendance")
            or booking.get("expected_attendance")
            or 0
        )

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
        operating_hours = venue.get("operating_hours")
        if not availability.booking_within_operating_hours(
            occupancy["effective_start_at"],
            occupancy["effective_end_at"],
            operating_hours,
        ):
            raise AuthError(
                "Cannot approve: the booking, including setup and turnaround, falls outside "
                f"venue operating hours ({_hours_label(operating_hours)}).",
                status_code=400,
            )

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
            "booking_id": booking["booking_id"],
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

    if booking.get("coordinator_id"):
        reason_text = f" Reason: {review.rejection_reason}" if review.rejection_reason else ""
        notify(
            booking["coordinator_id"],
            "venue_booking_rejected",
            title="Venue Booking Rejected",
            body=f"Your venue booking request for '{venue.get('name', 'the requested venue')}' was rejected.{reason_text}",
        )

    return rejected_booking


def create_venue_booking(
    access_token: str,
    venue_id: str,
    request: VenueBookingCreateRequest,
    coordinator_id: str,
) -> dict:
    """Submit a venue booking request with operating hours & buffer validation."""
    client = config.get_user_client(access_token)

    try:
        venue_info = _venue_configuration(client, venue_id)
        occupancy = _booking_occupancy({
            "start_at": request.start_at, "end_at": request.end_at, "venues": venue_info,
        })
    except PostgrestAPIError as error:
        raise AuthError("Unable to verify venue buffers.", status_code=502) from error
    setup_mins = occupancy["setup_buffer_minutes"]
    turnaround_mins = occupancy["teardown_buffer_minutes"]
    operating_hours = venue_info.get("operating_hours")
    effective_start = occupancy["effective_start_at"]
    effective_end = occupancy["effective_end_at"]

    if not availability.booking_within_operating_hours(effective_start, effective_end, operating_hours):
        raise AuthError(
            "The requested time, including setup and turnaround, falls outside venue operating "
            f"hours ({_hours_label(operating_hours)}).",
            status_code=400,
        )

    if request.event_id:
        check_event_is_bookable(client, request.event_id)
        check_booking_session(client, request)
        check_duplicate_session_booking(client, request.session_id)

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
        "session_id": request.session_id,
        "room_layout": request.room_layout,
        "start_at": request.start_at.isoformat(),
        "end_at": request.end_at.isoformat(),
        "setup_buffer_minutes": setup_mins,
        "teardown_buffer_minutes": turnaround_mins,
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


def cancel_venue_booking(
    access_token: str,
    booking_id: str,
    cancellation: VenueBookingCancelRequest,
) -> dict:
    """Cancel one booking and free its venue (T7-282).

    The database function checks the Coordinator, the event status, the
    booking status and the session start, and removes the calendar block,
    all in one transaction.
    """
    client = config.get_user_client(access_token)
    try:
        result = client.rpc(
            "cancel_venue_booking",
            {"p_booking_id": booking_id, "p_reason": cancellation.reason},
        ).execute()
    except PostgrestAPIError as error:
        if error.code == "42501":
            raise AuthError("Only Event Coordinators can cancel venue bookings.", status_code=403) from error
        if error.code in {"P0002", "22P02"}:
            raise AuthError("Venue booking was not found for an event assigned to you.", status_code=404) from error
        if error.code == "22023":
            raise AuthError("Give a reason for cancelling this booking.", status_code=400) from error
        if error.code == "P0001":
            # Written for the Coordinator, e.g. "only while the event is in Planning".
            raise AuthError(error.message, status_code=409) from error
        raise AuthError("Unable to cancel the venue booking.", status_code=502) from error

    booking = result.data
    if not isinstance(booking, dict) or booking.get("status") != "CANCELLED":
        raise AuthError("Unable to cancel the venue booking.", status_code=502)

    session = f" ({booking['session_name']})" if booking.get("session_name") else ""
    notify_role(
        Role.VENUE_STAFF.value,
        "venue_booking_cancelled",
        "Venue booking cancelled",
        f"The booking of '{booking.get('venue_name') or 'a venue'}' for "
        f"'{booking.get('event_name') or 'an event'}'{session} was cancelled by "
        f"the Coordinator. Reason: {booking.get('cancellation_reason')}",
        booking.get("event_id"),
    )
    return booking
