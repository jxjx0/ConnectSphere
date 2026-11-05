import logging

from httpx import HTTPError
from postgrest import APIError as PostgrestAPIError

import config
from services.auth_service import AuthError
from services.notification_service import notify

logger = logging.getLogger(__name__)



def get_unassigned_events_queue(access_token: str = None):
    """
    Fetches unassigned events queue.
    Conditions:
    1. coordinator_id IS NULL
    2. status IS NOT 'draft' (only submitted/under review events)
    3. status IS NOT 'rejected' or 'completed'
    4. Ordered FIFO (created_at ASC)
    """
    try:
        supabase = config.get_admin_client()
        response = (
            supabase.from_("events")
            .select(
                "id, name, description, purpose, category, "
                "start_time, end_time, expected_attendance, "
                "location_preference, layout_preference, accessibility_requirements, "
                "equipment_requirements, status, coordinator_id, created_at, "
                # Only the ids: the queue shows how many sessions there are.
                "sessions:event_sessions(id)"
            )
            .is_("coordinator_id", "null")
            .neq("status", "draft")
            .not_.in_("status", ["completed", "rejected"])
            .order("created_at", desc=False)
            .execute()
        )
        return response.data or []
    except PostgrestAPIError as error:
        if error.code in {"42501", "PGRST301"}:
            raise AuthError("You do not have permission to view unassigned events.", status_code=403) from error
        raise AuthError("Unable to load unassigned events. Please try again.", status_code=502) from error
    except HTTPError as error:
        raise AuthError("Unable to load unassigned events. Please try again.", status_code=502) from error


def assign_or_reassign_event(
    event_id: str,
    new_coordinator_id: str,
    changed_by_id: str,
    reason: str = None
):
    """
    Handles initial assignment or reassignment of an event.
    Logs audit records to event_activity_logs and triggers notify() email calls.
    """
    supabase = config.get_admin_client()

    try:
        # 1. Fetch event
        event_res = supabase.from_("events").select("*").eq("id", event_id).execute()
        if not event_res.data:
            raise AuthError("Event not found.", status_code=404)

        event = event_res.data[0]
        if event.get("status") in ["completed", "rejected"]:
            raise AuthError("Cannot assign or reassign an event that is completed or rejected.", status_code=400)

        previous_coordinator_id = event.get("coordinator_id")
        is_reassignment = previous_coordinator_id is not None
        action_type = "REASSIGNMENT" if is_reassignment else "ASSIGNMENT"

        # 2. Update coordinator_id on event
        update_res = (
            supabase.from_("events")
            .update({"coordinator_id": new_coordinator_id})
            .eq("id", event_id)
            .execute()
        )

        if not update_res.data:
            raise AuthError("Failed to update event coordinator.", status_code=500)

        # 3. Log to event_activity_logs with exact matching column schema
        log_entry = {
            "event_id": event_id,
            "previous_coordinator_id": previous_coordinator_id,
            "new_coordinator_id": new_coordinator_id,
            "changed_by_id": changed_by_id,
            "action_type": action_type,
            "reason": reason or ("Manual reassignment" if is_reassignment else "Initial queue assignment"),
        }
        supabase.from_("event_activity_logs").insert(log_entry).execute()
    except PostgrestAPIError as error:
        logger.exception("Unable to save the event assignment")
        if error.code in {"42501", "PGRST301"}:
            raise AuthError("You do not have permission to assign this event.", status_code=403) from error
        if error.code in {"22P02", "23502", "23503", "23514"}:
            raise AuthError("Check the event assignment details and selected coordinator.", status_code=400) from error
        raise AuthError("Unable to save the event assignment. Please try again.", status_code=502) from error
    except HTTPError as error:
        raise AuthError("Unable to save the event assignment. Please try again.", status_code=502) from error

    # 4. Trigger Email & In-App Notifications using notify()
    event_name = event.get("name", "an event")

    # Notify newly assigned coordinator
    notify(
        user_id=new_coordinator_id,
        notification_type="event_reassigned" if is_reassignment else "event_assigned",
        title="New Event Assignment",
        body=f"You have been assigned to manage the event '{event_name}'.",
        event_id=event_id,
    )

    # If reassigning, notify the previous coordinator as well
    if is_reassignment and previous_coordinator_id != new_coordinator_id:
        notify(
            user_id=previous_coordinator_id,
            notification_type="event_reassigned",
            title="Event Unassigned",
            body=f"You have been unassigned from event '{event_name}'.",
            event_id=event_id,
        )

    return update_res.data[0]