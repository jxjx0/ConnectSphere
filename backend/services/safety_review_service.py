"""Service module for Safety Officer review queues and event safety details."""

from datetime import datetime
import logging
from postgrest import APIError as PostgrestAPIError

from config import get_user_client
from services.auth_service import AuthError
from services.notification_service import notify

logger = logging.getLogger(__name__)


def _get_client(access_token: str | None = None):
    """Utility helper to prefer service/admin client if configured, falling back to user client."""
    try:
        from config import get_admin_client
        return get_admin_client()
    except Exception:
        return get_user_client(access_token or "")


from datetime import datetime, time, timezone

def is_within_operating_hours(start_dt: datetime, end_dt: datetime, operating_hours: dict | None) -> bool:
    """Verify if requested start and end times fall within venue operating hours."""
    if not operating_hours or not isinstance(operating_hours, dict):
        return True

    open_str = operating_hours.get("open")
    close_str = operating_hours.get("close")
    if not open_str or not close_str:
        return True

    try:
        open_raw = str(open_str).strip()
        close_raw = str(close_str).strip()

        fmt_open = "%H:%M:%S" if len(open_raw) == 8 else "%H:%M"
        fmt_close = "%H:%M:%S" if len(close_raw) == 8 else "%H:%M"

        open_time = datetime.strptime(open_raw, fmt_open).time()
        close_time = datetime.strptime(close_raw, fmt_close).time()
    except Exception as exc:
        logger.warning(f"Failed to parse venue operating hours '{operating_hours}': {exc}")
        return True

    # Ensure naive datetime comparison or strip timezone offsets cleanly
    if isinstance(start_dt, datetime):
        # Convert timezone-aware datetimes to naive time
        start_time = start_dt.timetz().replace(tzinfo=None) if start_dt.tzinfo else start_dt.time()
    else:
        start_time = start_dt

    if isinstance(end_dt, datetime):
        end_time = end_dt.timetz().replace(tzinfo=None) if end_dt.tzinfo else end_dt.time()
    else:
        end_time = end_dt

    if start_time < open_time or end_time > close_time:
        return False

    return True

def get_safety_review_queue(access_token: str) -> list[dict]:
    """Retrieve all pending safety review events in FIFO order (created_at ASC)."""
    try:
        client = _get_client(access_token)
        response = (
            client.table("events")
            .select("*, coordinator:coordinator_id!left(id, full_name, role)")
            .eq("safety_status", "pending")
            .order("created_at", desc=False)
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

        # Flag 1: Capacity Exceeded for Selected Layout
        if layout_capacity > 0 and expected_attendance > layout_capacity:
            flags.append({
                "type": "CAPACITY_EXCEEDED",
                "severity": "HIGH",
                "message": f"Expected attendance ({expected_attendance}) exceeds capacity ({layout_capacity}) for layout '{requested_layout}'.",
            })

        # Flag 2: Operating Hours Violation
        if booking and isinstance(venue, dict):
            op_hours = venue.get("operating_hours")
            start_str = booking.get("start_at")
            end_str = booking.get("end_at")
            if op_hours and start_str and end_str:
                try:
                    start_dt = datetime.fromisoformat(start_str.replace("Z", "+00:00"))
                    end_dt = datetime.fromisoformat(end_str.replace("Z", "+00:00"))
                    if not is_within_operating_hours(start_dt, end_dt, op_hours):
                        flags.append({
                            "type": "OPERATING_HOURS_VIOLATION",
                            "severity": "HIGH",
                            "message": f"Event schedule ({start_dt.strftime('%H:%M')} - {end_dt.strftime('%H:%M')}) falls outside venue operating hours ({op_hours.get('open')} - {op_hours.get('close')}).",
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
    """Send an event to the Safety Officer once its venue and equipment are approved."""
    try:
        client = _get_client(access_token)

        event_res = (
            client.table("events")
            .select("id, status, safety_status")
            .eq("id", event_id)
            .execute()
        )
        if not event_res.data:
            raise AuthError("Event not found", status_code=404)
        event = event_res.data[0]

        if event.get("safety_status") in ("pending", "approved"):
            raise AuthError("A safety check has already been requested for this event.", status_code=409)

        blockers = _safety_check_blockers(client, event)
        if blockers:
            raise AuthError("This event is not ready for a safety check: " + "; ".join(blockers) + ".", status_code=409)

        response = (
            client.table("events")
            .update({"safety_status": "pending"})
            .eq("id", event_id)
            .execute()
        )
        return {"message": "Safety review requested successfully", "data": response.data}
    except AuthError:
        raise
    except PostgrestAPIError as exc:
        raise AuthError(f"Failed to request safety check: {exc.message}", status_code=400)


def submit_safety_decision(
    event_id: str,
    safety_officer_id: str,
    decision: str,  # 'approved' | 'rejected' | 'changes_requested'
    notes: str,
    rejection_or_change_reason: str | None = None,
    access_token: str | None = None,
) -> dict:
    """Record a Safety Officer's decision while updating ONLY safety_status on the events table."""
    if decision not in ("approved", "rejected", "changes_requested"):
        raise AuthError("Invalid decision outcome. Must be 'approved', 'rejected', or 'changes_requested'.", status_code=400)

    if decision in ("rejected", "changes_requested") and not (rejection_or_change_reason or "").strip():
        raise AuthError(f"A detailed reason is required when marking an event as {decision}.", status_code=400)

    try:
        client = _get_client(access_token)

        # 1. Fetch current event state
        event_res = (
            client.table("events")
            .select("id, name, status, safety_status, coordinator_id")
            .eq("id", event_id)
            .execute()
        )
        if not event_res.data:
            raise AuthError("Event not found.", status_code=404)
        event = event_res.data[0]

        if event.get("safety_status") != "pending":
            raise AuthError("This event is not currently awaiting an operational safety review.", status_code=409)

        # 2. Insert audit log record into event_safety_reviews
        log_payload = {
            "event_id": event_id,
            "safety_officer_id": safety_officer_id,
            "decision": decision.upper(),
            "notes": notes,
            "reason": rejection_or_change_reason,
        }
        client.table("event_safety_reviews").insert(log_payload).execute()

        coordinator_id = event.get("coordinator_id")
        event_name = event.get("name", "your event")

        # 3. Handle Decision Outcomes (ONLY update safety_status on events)
        if decision == "approved":
            event_update = {
                "safety_status": "approved",
                "safety_reviewed_by": safety_officer_id,
            }
            updated_res = client.table("events").update(event_update).eq("id", event_id).execute()

            if coordinator_id:
                notify(
                    user_id=coordinator_id,
                    notification_type="safety_review_approved",
                    title="Operational Safety Check Approved",
                    body=f"Safety Officer approved '{event_name}'.",
                    event_id=event_id,
                )
            return updated_res.data[0]

        if decision == "rejected":
            # Release venue bookings to REJECTED_BY_SAFETY and delete operational schedule blocks
            venue_bookings = (
                client.table("venue_bookings")
                .select("booking_id, venue_id")
                .eq("event_id", event_id)
                .execute()
            ).data or []

            for booking in venue_bookings:
                client.table("venue_bookings").update({
                    "status": "REJECTED_BY_SAFETY",
                    "rejection_reason": f"Safety Officer Rejection: {rejection_or_change_reason}",
                }).eq("booking_id", booking["booking_id"]).execute()

                client.table("venue_blocks").delete().eq("booking_id", booking["booking_id"]).execute()

            # Reject equipment requests
            equip_requests = (
                client.table("equipment_requests")
                .select("id")
                .eq("event_id", event_id)
                .execute()
            ).data or []

            for eq_req in equip_requests:
                client.table("equipment_requests").update({
                    "status": "Rejected",
                }).eq("id", eq_req["id"]).execute()

            event_update = {
                "safety_status": "rejected",
                "safety_reviewed_by": safety_officer_id,
            }
            updated_res = client.table("events").update(event_update).eq("id", event_id).execute()

            if coordinator_id:
                notify(
                    user_id=coordinator_id,
                    notification_type="safety_review_rejected",
                    title="Operational Safety Check Rejected",
                    body=f"Safety Officer rejected safety arrangements for '{event_name}'. Venue and equipment reservations have been released. Reason: {rejection_or_change_reason}",
                    event_id=event_id,
                )
            return updated_res.data[0]

        if decision == "changes_requested":
            event_update = {
                "safety_status": "changes_requested",
                "safety_reviewed_by": safety_officer_id,
            }
            updated_res = client.table("events").update(event_update).eq("id", event_id).execute()

            if coordinator_id:
                notify(
                    user_id=coordinator_id,
                    notification_type="safety_review_changes_requested",
                    title="Safety Changes Required for Event",
                    body=f"Safety Officer requested changes for '{event_name}'. Reason: {rejection_or_change_reason}",
                    event_id=event_id,
                )
            return updated_res.data[0]

    except AuthError:
        raise
    except PostgrestAPIError as exc:
        raise AuthError(f"Failed to submit safety review decision: {exc.message}", status_code=400)
    except Exception as exc:
        raise AuthError(f"Internal error processing safety decision: {str(exc)}", status_code=500)