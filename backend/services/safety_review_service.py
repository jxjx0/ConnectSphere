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
RELEASABLE_BOOKING_STATUSES = ("PENDING_VENUE_APPROVAL", "APPROVED", "AFFECTED_BY_UNAVAILABILITY")


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
            .select("*, coordinator:coordinator_id!left(id, full_name, role)")
            .eq("status", "awaiting_safety_check")  # 👈 Updated to check event status
            .order("updated_at", desc=False)         # 👈 FIFO queue based on when it reached this status
            .execute()
        )
        return response.data or []
    except PostgrestAPIError as exc:
        raise AuthError(f"Failed to fetch safety review queue: {exc.message}", status_code=400)
    except Exception as exc:
        raise AuthError(f"Internal server error while fetching safety queue: {str(exc)}", status_code=500)


def get_safety_event_details(event_id: str, access_token: str) -> dict:
    """Retrieve full event, venue, equipment, and automated safety flags."""
    try:
        client = _get_client(access_token)

        # 1. Fetch Event with Left-Joined Coordinator
        event_res = (
            client.table("events")
            .select("*, coordinator:coordinator_id!left(id, full_name, role, contact_number)")
            .eq("id", event_id)
            .execute()
        )
        if not event_res.data:
            raise AuthError("Event not found", status_code=404)
        event = event_res.data[0]

        # 2. Fetch Approved Venue Booking & Joined Venue Profile
        booking = {}
        venue = {}
        try:
            venue_booking_res = (
                client.table("venue_bookings")
                .select("*, venue:venue_id(*)")
                .eq("event_id", event_id)
                .eq("status", "APPROVED")
                .execute()
            )
            if venue_booking_res.data and len(venue_booking_res.data) > 0:
                booking = venue_booking_res.data[0] or {}
                if isinstance(booking, dict):
                    venue = booking.get("venue") or {}
        except Exception as exc:
            logger.warning(f"Could not load venue booking for event {event_id}: {exc}")

        # 3. Fetch Equipment Requests & Joined Items
        equipment_items = []
        try:
            equip_res = (
                client.table("equipment_requests")
                .select("id, status, created_at")
                .eq("event_id", event_id)
                .eq("status", "Approved")
                .execute()
            )
            if equip_res.data:
                request_ids = [
                    req["id"] for req in equip_res.data
                    if isinstance(req, dict) and req.get("id")
                ]
                if request_ids:
                    items_res = (
                        client.table("equipment_request_items")
                        .select("quantity, equipment:equipment_id(name, type, maintenance_status)")
                        .in_("request_id", request_ids)
                        .execute()
                    )
                    equipment_items = items_res.data or []
        except Exception as exc:
            logger.warning(f"Could not load equipment items for event {event_id}: {exc}")

        # 4. Automated Safety Flag & Clash Detection
        flags = []
        expected_attendance = event.get("expected_attendance") or 0
        
        # Room layout capacity check
        requested_layout = booking.get("room_layout") if isinstance(booking, dict) else None
        supported_layouts = venue.get("layouts") or [] if isinstance(venue, dict) else []
        
        # Normalize layouts if stored as object dictionary or array
        if isinstance(supported_layouts, dict):
            supported_layouts = [{"name": k, "capacity": v} for k, v in supported_layouts.items()]

        layout_capacity = 0
        if requested_layout and isinstance(supported_layouts, list):
            layout_match = next(
                (l for l in supported_layouts if isinstance(l, dict) and l.get("name", "").lower() == requested_layout.lower()),
                None
            )
            if layout_match:
                layout_capacity = layout_match.get("capacity") or 0

        # Flag 1: Capacity Exceeded (booked layout when known, otherwise the whole venue)
        venue_capacity = (venue.get("capacity") or 0) if isinstance(venue, dict) else 0
        if layout_capacity > 0 and expected_attendance > layout_capacity:
            flags.append({
                "type": "CAPACITY_EXCEEDED",
                "severity": "HIGH",
                "message": f"Expected attendance ({expected_attendance}) exceeds capacity ({layout_capacity}) for layout '{requested_layout}'.",
            })
        elif layout_capacity == 0 and venue_capacity > 0 and expected_attendance > venue_capacity:
            flags.append({
                "type": "CAPACITY_EXCEEDED",
                "severity": "HIGH",
                "message": f"Expected attendance ({expected_attendance}) exceeds venue capacity ({venue_capacity}).",
            })

        # Flag 2: Operating Hours Violation
        if booking and isinstance(venue, dict):
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
                                f"Event schedule including setup and turnaround "
                                f"({local_start:%H:%M} - {local_end:%H:%M}) falls outside venue "
                                f"operating hours ({op_hours.get('open')} - {op_hours.get('close')})."
                            ),
                        })
                except ValueError:
                    pass

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

        # Flag 4: Accessibility Requirements Misalignment
        accessibility_req = (event.get("accessibility_requirements") or "").lower()
        venue_access = venue.get("accessibility") or [] if isinstance(venue, dict) else []
        is_accessible = any("wheelchair" in str(feature).lower() for feature in venue_access)

        if "wheelchair" in accessibility_req and not is_accessible:
            flags.append({
                "type": "ACCESSIBILITY_GAP",
                "severity": "MEDIUM",
                "message": "Event specifies wheelchair accessibility needs, but the venue is not marked as accessible.",
            })

        # Flag 5: Large Crowd Safety Protocol
        if expected_attendance >= 500:
            flags.append({
                "type": "LARGE_CROWD_PROTOCOL",
                "severity": "MEDIUM",
                "message": "Expected attendance exceeds 500. Requires First Aid & Crowd Management Plan.",
            })

        return {
            "event": event,
            "venue_booking": booking,
            "venue": venue,
            "equipment_items": equipment_items,
            "safety_flags": flags,
        }
    except AuthError:
        raise
    except PostgrestAPIError as exc:
        raise AuthError(f"Failed to fetch safety event details: {exc.message}", status_code=400)
    except Exception as exc:
        raise AuthError(f"Internal error processing event details: {str(exc)}", status_code=500)


def _safety_check_blockers(client, event: dict) -> list[str]:
    """What still stops this event from being sent for its safety check."""
    blockers = []
    if event.get("status") != "planning":
        blockers.append("the event must be in Planning")

    bookings = (
        client.table("venue_bookings")
        .select("status")
        .eq("event_id", event["id"])
        .execute()
    ).data or []
    booking_statuses = [(booking.get("status") or "").upper() for booking in bookings]
    live_statuses = [status for status in booking_statuses if status != "CANCELLED"]
    if "APPROVED" not in live_statuses:
        blockers.append("it needs an approved venue booking")
    elif any(status != "APPROVED" for status in live_statuses):
        blockers.append("every venue booking must be approved first")

    equipment_requests = (
        client.table("equipment_requests")
        .select("status")
        .eq("event_id", event["id"])
        .execute()
    ).data or []
    if any(request.get("status") == "Pending Technical Approval" for request in equipment_requests):
        blockers.append("pending equipment requests must be reviewed first")

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
        .neq("status", "Rejected")
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
            .select("id, name, status, coordinator_id")
            .eq("id", event_id)
            .execute()
        )
        if not event_res.data:
            raise AuthError("Event not found.", status_code=404)
        event = event_res.data[0]

        if event.get("status") != "awaiting_safety_check":
            raise AuthError("This event is not currently awaiting an operational safety review.", status_code=409)

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

        coordinator_id = event.get("coordinator_id")
        if coordinator_id:
            event_name = event.get("name") or "your event"
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
        return updated_res.data[0]

    except AuthError:
        raise
    except PostgrestAPIError as exc:
        raise AuthError(f"Failed to submit safety review decision: {exc.message}", status_code=400)
    except Exception as exc:
        raise AuthError(f"Internal error processing safety decision: {str(exc)}", status_code=500)
