"""Service module for Safety Officer review queues and event safety details."""

import logging
from postgrest import APIError as PostgrestAPIError
from config import get_admin_client, get_user_client
from services.auth_service import AuthError

logger = logging.getLogger(__name__)


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
        raise AuthError(
            f"Failed to fetch safety review queue: {exc.message}",
            status_code=400,
        )
    except Exception as exc:
        raise AuthError(
            f"Internal server error while fetching safety queue: {str(exc)}",
            status_code=500,
        )


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
        venue_capacity = 0
        if isinstance(venue, dict):
            venue_capacity = venue.get("capacity") or 0

        # Flag 1: Capacity Exceeded
        if venue_capacity > 0 and expected_attendance > venue_capacity:
            flags.append({
                "type": "CAPACITY_EXCEEDED",
                "severity": "HIGH",
                "message": f"Expected attendance ({expected_attendance}) exceeds venue capacity ({venue_capacity}).",
            })

        # Flag 2: Equipment Under Maintenance / Damaged
        for item in equipment_items:
            equip = item.get("equipment") or {}
            m_status = equip.get("maintenance_status") or "Unknown"
            if m_status != "Functional":
                flags.append({
                    "type": "EQUIPMENT_HAZARD",
                    "severity": "CRITICAL",
                    "message": f"Requested equipment '{equip.get('name', 'Item')}' is currently marked as '{m_status}'.",
                })

        # Flag 3: Accessibility Requirements Misalignment
        accessibility_req = (event.get("accessibility_requirements") or "").lower()
        venue_access = venue.get("accessibility") or []
        is_accessible = any("wheelchair" in str(feature).lower() for feature in venue_access)

        if "wheelchair" in accessibility_req and not is_accessible:
            flags.append({
                "type": "ACCESSIBILITY_GAP",
                "severity": "MEDIUM",
                "message": "Event specifies wheelchair accessibility needs, but the venue is not marked as accessible.",
            })

        # Flag 4: Large Crowd Safety Protocol
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
        raise AuthError(
            f"Failed to fetch safety event details: {exc.message}",
            status_code=400,
        )
    except Exception as exc:
        raise AuthError(
            f"Internal error processing event details: {str(exc)}",
            status_code=500,
        )


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
    if not any((booking.get("status") or "").upper() == "APPROVED" for booking in bookings):
        blockers.append("it needs an approved venue booking")

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
            raise AuthError(
                "This event is not ready for a safety check: " + "; ".join(blockers) + ".",
                status_code=409,
            )

        response = (
            client.table("events")
            .update({"status": "awaiting_safety_check"})
            .eq("id", event_id)
            .execute()
        )
        return {"message": "Safety review requested successfully", "data": response.data}
    except AuthError:
        raise
    except PostgrestAPIError as exc:
        raise AuthError(
            f"Failed to request safety check: {exc.message}",
            status_code=400,
        )



def check_and_update_safety_status(event_id: str, access_token: str = None) -> bool:
    """
    Evaluates if an event has an approved venue and approved (or no) equipment.
    Returns True if conditions pass for the coordinator to manually request a safety check.
    """
    try:
        client = get_admin_client()
    except Exception as exc:
        logger.error(f"Could not initialize admin client for safety check: {exc}")
        return False

    # 1. Check venue approval
    venue_res = (
        client.table("venue_bookings")
        .select("status")
        .eq("event_id", event_id)
        .eq("status", "APPROVED")
        .execute()
    )
    if not venue_res.data:
        return False

    # 2. Check equipment approval
    equip_res = (
        client.table("equipment_requests")
        .select("status")
        .eq("event_id", event_id)
        .execute()
    )
    equip_requests = equip_res.data or []

    all_equip_approved = not equip_requests or all(
        req.get("status") == "APPROVED" for req in equip_requests
    )

    return all_equip_approved