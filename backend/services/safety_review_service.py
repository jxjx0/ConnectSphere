"""Service module for Safety Officer review queues and event safety details."""

import logging
from datetime import datetime, timezone
from postgrest import APIError as PostgrestAPIError
from config import get_admin_client, get_user_client
from services import venue_availability_service as availability
from services.auth_service import AuthError
from services.notification_service import notify

logger = logging.getLogger(__name__)

# Where each Safety Officer decision sends the event next.
DECISION_NEXT_STATUS = {
    "approved": "confirmed",
    "changes_requested": "planning",
    "rejected": "planning",
}
# Bookings that still hold the venue and must be released when safety is rejected.
RELEASABLE_BOOKING_STATUSES = (
    "PENDING_VENUE_APPROVAL", "APPROVED", "AFFECTED_BY_UNAVAILABILITY", "AFFECTED_BY_SESSION_CHANGE",
)
SETTLED_BOOKING_STATUSES = ("CANCELLED", "REJECTED", "REJECTED_BY_SAFETY")


def _get_client(access_token: str = None):
    """Helper to resolve admin client or fallback to user client with access token."""
    try:
        return get_admin_client()
    except Exception:
        if access_token:
            return get_user_client(access_token)
        raise AuthError("Database client initialization failed.", status_code=500)


def get_safety_review_queue(access_token: str) -> list[dict]:
    """Retrieve all events in 'awaiting_safety_check' status in FIFO order (updated_at ASC)."""
    try:
        client = _get_client(access_token)

        response = (
            client.table("events")
            .select("*, coordinator:coordinator_id!left(id, full_name, role), sessions:event_sessions(id)")
            .eq("status", "awaiting_safety_check")  # 👈 Updated to check event status
            .order("updated_at", desc=False)         # 👈 FIFO queue based on when it reached this status
            .execute()
        )
        return response.data or []
    except PostgrestAPIError as exc:
        raise AuthError(f"Failed to fetch safety review queue: {exc.message}", status_code=400)
    except Exception as exc:
        raise AuthError(f"Internal server error while fetching safety queue: {str(exc)}", status_code=500)


def get_safety_review_history(access_token: str) -> dict:
    """Decisions made, and events that ended while waiting for a safety check."""
    try:
        client = _get_client(access_token)

        reviewed = (
            client.table("event_safety_reviews")
            .select(
                "id, event_id, decision, reason, created_at, "
                "event:events(id, name), officer:profiles(full_name)"
            )
            .order("created_at", desc=True)
            .execute()
        )
        # The trigger in event_safety_queue_tracking.sql keeps this timestamp
        # only when an event ends in the queue.
        expired = (
            client.table("events")
            .select(
                "id, name, category, category_other, start_time, end_time, status, "
                "updated_at, expected_attendance, sessions:event_sessions(id)"
            )
            .in_("status", ["cancelled", "rejected", "completed"])
            .not_.is_("safety_check_requested_at", "null")
            .order("updated_at", desc=True)
            .execute()
        )
        return {"reviewed": reviewed.data or [], "expired": expired.data or []}
    except PostgrestAPIError as exc:
        raise AuthError(f"Failed to fetch safety review history: {exc.message}", status_code=400)
    except Exception as exc:
        raise AuthError(f"Internal server error while fetching safety history: {str(exc)}", status_code=500)


def _layout_capacity(venue: dict, layout_name: str | None) -> int:
    """The booked layout's capacity in this venue, or 0 when it is unknown."""
    layouts = venue.get("layouts") or []
    if isinstance(layouts, dict):
        layouts = [{"name": name, "capacity": capacity} for name, capacity in layouts.items()]
    if not layout_name or not isinstance(layouts, list):
        return 0
    match = next(
        (layout for layout in layouts
         if isinstance(layout, dict) and layout.get("name", "").lower() == layout_name.lower()),
        None,
    )
    return (match or {}).get("capacity") or 0


def _venue_flags(booking: dict, session: dict, event_attendance: int, accessibility_req: str) -> list[dict]:
    """Capacity, operating-hours and accessibility flags for one booked venue.

    Attendance is the booking's own session's; bookings made before
    sessions existed fall back to the event's. Each message names the
    session and venue, since an event may have several.
    """
    venue = booking.get("venue") or {}
    if not isinstance(venue, dict):
        venue = {}
    attendance = session.get("expected_attendance") or event_attendance
    where = " - ".join(
        part for part in (session.get("name"), venue.get("name")) if part
    ) or "Venue"
    flags = []

    # Flag 1: Capacity Exceeded (booked layout when known, otherwise the whole venue)
    layout = booking.get("room_layout")
    layout_capacity = _layout_capacity(venue, layout)
    venue_capacity = venue.get("capacity") or 0
    if layout_capacity > 0 and attendance > layout_capacity:
        flags.append({
            "type": "CAPACITY_EXCEEDED",
            "severity": "HIGH",
            "message": f"{where}: expected attendance ({attendance}) exceeds capacity ({layout_capacity}) for layout '{layout}'.",
        })
    elif layout_capacity == 0 and venue_capacity > 0 and attendance > venue_capacity:
        flags.append({
            "type": "CAPACITY_EXCEEDED",
            "severity": "HIGH",
            "message": f"{where}: expected attendance ({attendance}) exceeds venue capacity ({venue_capacity}).",
        })

    # Flag 2: Operating Hours Violation
    op_hours = venue.get("operating_hours")
    start_str = booking.get("effective_start_at") or booking.get("start_at")
    end_str = booking.get("effective_end_at") or booking.get("end_at")
    if op_hours and start_str and end_str:
        try:
            start_dt = datetime.fromisoformat(start_str)
            end_dt = datetime.fromisoformat(end_str)
            if not availability.booking_within_operating_hours(start_dt, end_dt, op_hours):
                local_start = start_dt.astimezone(availability.VENUE_TIMEZONE)
                local_end = end_dt.astimezone(availability.VENUE_TIMEZONE)
                flags.append({
                    "type": "OPERATING_HOURS_VIOLATION",
                    "severity": "HIGH",
                    "message": (
                        f"{where}: schedule including setup and turnaround "
                        f"({local_start:%H:%M} - {local_end:%H:%M}) falls outside venue "
                        f"operating hours ({op_hours.get('open')} - {op_hours.get('close')})."
                    ),
                })
        except ValueError:
            pass

    # Flag 4: Accessibility Requirements Misalignment
    venue_access = venue.get("accessibility") or []
    is_accessible = any("wheelchair" in str(feature).lower() for feature in venue_access)
    if "wheelchair" in accessibility_req and not is_accessible:
        flags.append({
            "type": "ACCESSIBILITY_GAP",
            "severity": "MEDIUM",
            "message": f"{where}: the event needs wheelchair access, but this venue is not marked as accessible.",
        })

    return flags


def _peak_attendance(event: dict) -> int:
    """The most people at the event at any one time.

    Sessions may run at the same time (scope doc 9.1), so the crowd is the
    total of every session running at each session's start. Events without
    timed sessions fall back to the event's own attendance.
    """
    sessions = [
        session for session in (event.get("sessions") or [])
        if session.get("start_time") and session.get("end_time")
    ]
    peak = 0
    for session in sessions:
        moment = datetime.fromisoformat(session["start_time"])
        peak = max(peak, sum(
            other.get("expected_attendance") or 0 for other in sessions
            if datetime.fromisoformat(other["start_time"]) <= moment < datetime.fromisoformat(other["end_time"])
        ))
    return max(peak, event.get("expected_attendance") or 0)


def get_safety_event_details(event_id: str, access_token: str) -> dict:
    """Retrieve full event, venue, equipment, and automated safety flags."""
    try:
        client = _get_client(access_token)

        # 1. Fetch Event with Left-Joined Coordinator
        event_res = (
            client.table("events")
            .select("*, coordinator:coordinator_id!left(id, full_name, role, contact_number), sessions:event_sessions(*)")
            .eq("id", event_id)
            .execute()
        )
        if not event_res.data:
            raise AuthError("Event not found", status_code=404)
        event = event_res.data[0]

        # 2. Fetch every approved venue booking, each with its venue profile.
        # An event may use several venues, one per session (W7 change 3).
        venue_bookings = []
        try:
            venue_booking_res = (
                client.table("venue_bookings")
                .select("*, venue:venue_id(*)")
                .eq("event_id", event_id)
                .eq("status", "APPROVED")
                .execute()
            )
            venue_bookings = [
                booking for booking in (venue_booking_res.data or [])
                if isinstance(booking, dict)
            ]
        except Exception as exc:
            logger.warning(f"Could not load venue bookings for event {event_id}: {exc}")

        # 3. Fetch approved equipment requests and the items allocated to them.
        # Tech Support allocates each physical item as one equipment_bookings
        # row, so each booking is shown as one item.
        equipment_items = []
        try:
            equip_res = (
                client.table("equipment_requests")
                .select("id, status, created_at, session_id")
                .eq("event_id", event_id)
                .eq("status", "Approved")
                .execute()
            )
            if equip_res.data:
                # Each request is for one session (T7-279), so each item
                # carries its request's session_id for the page to group by.
                session_by_request = {
                    req["id"]: req.get("session_id") for req in equip_res.data
                    if isinstance(req, dict) and req.get("id")
                }
                if session_by_request:
                    bookings_res = (
                        client.table("equipment_bookings")
                        .select("request_id, equipment:equipment_id(name, type, maintenance_status)")
                        .in_("request_id", list(session_by_request))
                        .execute()
                    )
                    equipment_items = [
                        {
                            **booking,
                            "quantity": 1,
                            "session_id": session_by_request.get(booking.get("request_id")),
                        }
                        for booking in (bookings_res.data or [])
                        if isinstance(booking, dict)
                    ]
        except Exception as exc:
            logger.warning(f"Could not load equipment items for event {event_id}: {exc}")

        # 4. Automated Safety Flag & Clash Detection
        flags = []
        expected_attendance = event.get("expected_attendance") or 0
        sessions_by_id = {
            session.get("id"): session for session in (event.get("sessions") or [])
        }
        accessibility_req = (event.get("accessibility_requirements") or "").lower()

        # Flags 1, 2 and 4 are checked for each booked venue against its own
        # session, so a 50-seat breakout room is not judged by the 300-person
        # main programme (T7-278).
        for booking in venue_bookings:
            session = sessions_by_id.get(booking.get("session_id")) or {}
            booking["session"] = session or None
            flags.extend(_venue_flags(booking, session, expected_attendance, accessibility_req))

        # Flag 3: Equipment Under Maintenance / Damaged
        for item in equipment_items:
            equip = item.get("equipment") or {}
            m_status = equip.get("maintenance_status") or "Unknown"
            if m_status != "Functional":
                flags.append({
                    "type": "EQUIPMENT_HAZARD",
                    "severity": "CRITICAL",
                    "message": f"Requested equipment '{equip.get('name', 'Item')}' is currently marked as '{m_status}'.",
                })

        # Flag 5: Large Crowd Safety Protocol. Counts everyone on site at
        # once, so overlapping sessions add up.
        if _peak_attendance(event) >= 500:
            flags.append({
                "type": "LARGE_CROWD_PROTOCOL",
                "severity": "MEDIUM",
                "message": "Up to 500 or more people are expected at the same time. Requires First Aid & Crowd Management Plan.",
            })

        return {
            "event": event,
            "venue_bookings": venue_bookings,
            "equipment_items": equipment_items,
            "safety_flags": flags,
        }
    except AuthError:
        raise
    except PostgrestAPIError as exc:
        raise AuthError(f"Failed to fetch safety event details: {exc.message}", status_code=400)
    except Exception as exc:
        raise AuthError(f"Internal error processing event details: {str(exc)}", status_code=500)


def _has_open_requests(client, event_id: str) -> bool:
    """Whether a clarification, change or cancellation request is still open.

    An event cannot move forward while one is open; the database enforces
    this too, but checking first gives the user a clear message.
    """
    return bool(client.rpc("event_has_open_requests", {"p_event_id": event_id}).execute().data)


def _safety_check_blockers(client, event: dict) -> list[str]:
    """What still stops this event from being sent for its safety check."""
    blockers = []
    if event.get("status") != "planning":
        blockers.append("the event must be in Planning")
    if _has_open_requests(client, event["id"]):
        blockers.append("close the open clarification, change or cancellation request first")

    bookings = (
        client.table("venue_bookings")
        .select("status, session_id")
        .eq("event_id", event["id"])
        .execute()
    ).data or []
    booking_statuses = [(booking.get("status") or "").upper() for booking in bookings]
    # Settled bookings hold no venue, so they must not block a re-planned event forever.
    live_statuses = [status for status in booking_statuses if status not in SETTLED_BOOKING_STATUSES]
    if "APPROVED" not in live_statuses:
        blockers.append("it needs an approved venue booking")
    elif any(status != "APPROVED" for status in live_statuses):
        blockers.append("every venue booking must be approved first")
    else:
        # Every session needs its own approved venue (scope doc 9.1).
        # Events created before sessions existed have none to check.
        sessions = (
            client.table("event_sessions")
            .select("id, name")
            .eq("event_id", event["id"])
            .execute()
        ).data or []
        approved_sessions = {
            booking.get("session_id") for booking in bookings
            if (booking.get("status") or "").upper() == "APPROVED"
        }
        missing = [
            session.get("name") or "a session" for session in sessions
            if session.get("id") not in approved_sessions
        ]
        if missing:
            blockers.append(
                "every session needs an approved venue booking ("
                + ", ".join(missing)
                + (" has" if len(missing) == 1 else " have")
                + " none)"
            )

    equipment_requests = (
        client.table("equipment_requests")
        .select("status, session_id")
        .eq("event_id", event["id"])
        .execute()
    ).data or []
    if any(request.get("status") == "Pending Technical Approval" for request in equipment_requests):
        blockers.append("pending equipment requests must be reviewed first")
    elif any(request.get("status") == "Affected by Session Change" for request in equipment_requests):
        # Its session moved or was removed (T7-281): cancel it and request again.
        blockers.append("equipment requests affected by a session change must be cancelled and requested again")
    else:
        # Every session that lists equipment needs its own request (scope
        # doc 9.1). Sessions that need none count as done.
        sessions = (
            client.table("event_sessions")
            .select("id, name, equipment_requirements")
            .eq("event_id", event["id"])
            .execute()
        ).data or []
        # A cancelled request counts as none, so the session must request again (T7-282).
        requested_sessions = {
            request.get("session_id") for request in equipment_requests
            if request.get("status") != "Cancelled"
        }
        missing = [
            session.get("name") or "a session" for session in sessions
            if (session.get("equipment_requirements") or "").strip()
            and session.get("id") not in requested_sessions
        ]
        if missing:
            blockers.append(
                "every session that needs equipment needs an equipment request ("
                + ", ".join(missing)
                + (" has" if len(missing) == 1 else " have")
                + " none)"
            )

    return blockers


def request_safety_check(event_id: str, access_token: str) -> dict:
    """Send an event to the Safety Officer queue once venue and equipment prerequisites are met."""
    try:
        client = _get_client(access_token)

        event_res = (
            client.table("events")
            .select("id, status")
            .eq("id", event_id)
            .execute()
        )
        if not event_res.data:
            raise AuthError("Event not found", status_code=404)
        event = event_res.data[0]

        if event.get("status") == "awaiting_safety_check":
            raise AuthError(
                "A safety check has already been requested for this event.",
                status_code=409,
            )

        blockers = _safety_check_blockers(client, event)
        if blockers:
            raise AuthError("This event is not ready for a safety check: " + "; ".join(blockers) + ".", status_code=409)

        response = (
            client.table("events")
            .update({
                "status": "awaiting_safety_check",
                "updated_at": datetime.now(timezone.utc).isoformat(),
            })
            .eq("id", event_id)
            .execute()
        )
        return {"message": "Safety review requested successfully", "data": response.data}
    except AuthError:
        raise
    except PostgrestAPIError as exc:
        raise AuthError(f"Failed to request safety check: {exc.message}", status_code=400)
    except Exception as exc:
        raise AuthError(
            f"Internal error requesting safety check: {str(exc)}",
            status_code=500,
        )


def get_latest_safety_decision(access_token: str, event_id: str) -> dict | None:
    """The newest Safety Officer decision; the event page still loads if it cannot be read."""
    try:
        rows = (
            get_user_client(access_token).table("event_safety_reviews")
            .select("decision, reason, created_at")
            .eq("event_id", event_id)
            .order("created_at", desc=True)
            .limit(1)
            .execute()
        ).data or []
    except Exception as exc:
        logger.warning(f"Could not load the latest safety decision for event {event_id}: {exc}")
        return None
    return rows[0] if rows else None


def _release_event_arrangements(client, event_id: str, reason: str) -> None:
    """Free the venue and equipment a rejected event holds so other events can use them."""
    bookings = (
        client.table("venue_bookings")
        .select("booking_id, venue_id, status, effective_start_at, effective_end_at")
        .eq("event_id", event_id)
        .in_("status", list(RELEASABLE_BOOKING_STATUSES))
        .execute()
    ).data or []

    for booking in bookings:
        client.table("venue_bookings").update({
            "status": "REJECTED_BY_SAFETY",
            "rejection_reason": f"Safety Officer Rejection: {reason}",
        }).eq("booking_id", booking["booking_id"]).execute()

        if booking.get("status") == "PENDING_VENUE_APPROVAL":
            continue
        removed = (
            client.table("venue_blocks").delete()
            .eq("booking_id", booking["booking_id"])
            .execute()
        ).data
        if not removed:
            # Approval blocks created before venue_blocks.booking_id existed carry no link.
            (
                client.table("venue_blocks").delete()
                .eq("venue_id", booking["venue_id"])
                .eq("start_at", booking["effective_start_at"])
                .eq("end_at", booking["effective_end_at"])
                .is_("booking_id", "null")
                .like("block_reason", "Approved Booking:%")
                .execute()
            )

    equipment_requests = (
        client.table("equipment_requests")
        .select("id")
        .eq("event_id", event_id)
        .in_("status", ["Pending Technical Approval", "Approved", "Affected by Session Change"])
        .execute()
    ).data or []
    request_ids = [request["id"] for request in equipment_requests]
    if request_ids:
        client.table("equipment_bookings").delete().in_("request_id", request_ids).execute()
        client.table("equipment_requests").update({"status": "Rejected"}).in_("id", request_ids).execute()


def submit_safety_decision(
    event_id: str,
    safety_officer_id: str,
    decision: str,  # 'approved' | 'rejected' | 'changes_requested'
    notes: str,
    rejection_or_change_reason: str | None = None,
    access_token: str | None = None,
) -> dict:
    """Record a Safety Officer's decision and move the event to its next status."""
    if decision not in DECISION_NEXT_STATUS:
        raise AuthError("Invalid decision outcome. Must be 'approved', 'rejected', or 'changes_requested'.", status_code=400)

    if decision in ("rejected", "changes_requested") and not (rejection_or_change_reason or "").strip():
        raise AuthError(f"A detailed reason is required when marking an event as {decision}.", status_code=400)

    try:
        client = _get_client(access_token)

        event_res = (
            client.table("events")
            .select("id, name, status, coordinator_id, organiser_id")
            .eq("id", event_id)
            .execute()
        )
        if not event_res.data:
            raise AuthError("Event not found.", status_code=404)
        event = event_res.data[0]

        if event.get("status") != "awaiting_safety_check":
            raise AuthError("This event is not currently awaiting an operational safety review.", status_code=409)

        if decision == "approved" and _has_open_requests(client, event_id):
            raise AuthError(
                "This event has an open clarification, change or cancellation request. "
                "It can be approved once the Coordinator has closed it.",
                status_code=409,
            )

        client.table("event_safety_reviews").insert({
            "event_id": event_id,
            "safety_officer_id": safety_officer_id,
            "decision": decision.upper(),
            "notes": notes,
            "reason": rejection_or_change_reason,
        }).execute()

        if decision == "rejected":
            _release_event_arrangements(client, event_id, rejection_or_change_reason)

        updated_res = (
            client.table("events")
            .update({
                "status": DECISION_NEXT_STATUS[decision],
                "updated_at": datetime.now(timezone.utc).isoformat(),
            })
            .eq("id", event_id)
            .execute()
        )

        event_name = event.get("name") or "your event"
        coordinator_id = event.get("coordinator_id")
        if coordinator_id:
            notification_type, title, body = {
                "approved": (
                    "safety_review_approved",
                    "Operational Safety Check Approved",
                    f"Safety Officer approved '{event_name}'. The event is now confirmed.",
                ),
                "rejected": (
                    "safety_review_rejected",
                    "Operational Safety Check Rejected",
                    f"Safety Officer rejected safety arrangements for '{event_name}'. "
                    "Venue and equipment reservations have been released and the event is back in Planning. "
                    f"Reason: {rejection_or_change_reason}",
                ),
                "changes_requested": (
                    "safety_review_changes_requested",
                    "Safety Changes Required for Event",
                    f"Safety Officer requested changes for '{event_name}'. "
                    "The event is back in Planning so you can update its arrangements. "
                    f"Reason: {rejection_or_change_reason}",
                ),
            }[decision]
            notify(
                user_id=coordinator_id,
                notification_type=notification_type,
                title=title,
                body=body,
                event_id=event_id,
            )

        # Safety approval is what confirms the event, so the Organiser hears it here.
        organiser_id = event.get("organiser_id")
        if decision == "approved" and organiser_id:
            notify(
                user_id=organiser_id,
                notification_type="event_confirmed",
                title="Event Confirmed",
                body=f"Your event '{event_name}' is confirmed. You can now set up attendee registration.",
                event_id=event_id,
            )
        return updated_res.data[0]

    except AuthError:
        raise
    except PostgrestAPIError as exc:
        raise AuthError(f"Failed to submit safety review decision: {exc.message}", status_code=400)
    except Exception as exc:
        raise AuthError(f"Internal error processing safety decision: {str(exc)}", status_code=500)
