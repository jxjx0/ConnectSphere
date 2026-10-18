"""Service module for Safety Officer review queues and event safety details."""

import logging
from postgrest import APIError as PostgrestAPIError
from config import get_user_client
from services.auth_service import AuthError

logger = logging.getLogger(__name__)


def get_safety_review_queue(access_token: str) -> list[dict]:
    """Retrieve all pending safety review events in FIFO order (created_at ASC)."""
    try:
        try:
            from config import get_admin_client
            client = get_admin_client()
        except Exception:
            client = get_user_client(access_token)

        response = (
            client.table("events")
            .select("*, coordinator:coordinator_id!left(id, full_name, role)")
            .eq("safety_status", "pending")
            .order("created_at", desc=False)
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
        try:
            from config import get_admin_client
            client = get_admin_client()
        except Exception:
            client = get_user_client(access_token)

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
            m_status = (equip.get("maintenance_status") or "").lower()
            if m_status in ["maintenance", "damaged", "inoperable", "under_repair"]:
                flags.append({
                    "type": "EQUIPMENT_HAZARD",
                    "severity": "CRITICAL",
                    "message": f"Requested equipment '{equip.get('name', 'Item')}' is currently marked as '{m_status}'.",
                })

        # Flag 3: Accessibility Requirements Misalignment
        accessibility_req = (event.get("accessibility_requirements") or "").lower()
        venue_access = venue.get("accessibility") or {}
        is_accessible = venue_access.get("wheelchair_accessible", True) if isinstance(venue_access, dict) else True

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


def request_safety_check(event_id: str, access_token: str) -> dict:
    """Update event safety_status to pending for safety officer inspection."""
    try:
        try:
            from config import get_admin_client
            client = get_admin_client()
        except Exception:
            client = get_user_client(access_token)

        response = (
            client.table("events")
            .update({"safety_status": "pending"})
            .eq("id", event_id)
            .execute()
        )
        return {"message": "Safety review requested successfully", "data": response.data}
    except PostgrestAPIError as exc:
        raise AuthError(
            f"Failed to request safety check: {exc.message}",
            status_code=400,
        )