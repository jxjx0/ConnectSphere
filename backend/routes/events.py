"""Event request endpoints. Thin handlers: parse, call the service, return JSON."""

import logging
import traceback

from flask import Blueprint, g, jsonify, request
from pydantic import ValidationError

from models.event import (
    EventChangeRequestDecision,
    EventChangeRequestSubmit,
    EventClarificationRequest,
    EventClarificationResponse,
    EventDraftRequest,
    EventStatus,
    EventSubmitRequest,
)
from models.profile import Profile, Role
from routes.auth import require_auth
from services import auth_service, event_service, notification_service, overview_coordinator_events_service, event_assignment_service, safety_review_service
from services.auth_service import AuthError
from models.event import Event

events_bp = Blueprint("events", __name__, url_prefix="/events")

logger = logging.getLogger(__name__)


def _validation_messages(error: ValidationError) -> list[str]:
    """Turn Pydantic's error list into plain sentences for the frontend."""
    return [item["msg"].removeprefix("Value error, ") for item in error.errors()]


def _require_organiser() -> Profile:
    """Require the authenticated profile to have the organiser role.

    Returns the profile, for handlers that need the Organiser's name.
    """
    profile = auth_service.get_profile(g.access_token, g.user_id)
    if profile.role != Role.ORGANISER:
        raise AuthError(
            "Only Event Organisers can submit event requests.",
            status_code=403,
        )
    return profile


def _require_coordinator() -> Profile:
    """Require the authenticated profile to have the coordinator role.

    Returns the profile, for handlers that need the Coordinator's name.
    """
    profile = auth_service.get_profile(g.access_token, g.user_id)
    allowed_roles = [
        Role.COORDINATOR,
        getattr(Role, "EVENT_COORDINATOR_LEAD", "event_coordinator_lead"),
    ]
    if profile.role not in allowed_roles:
        raise AuthError(
            "Only Event Coordinators and Lead Coordinators can review event requests.",
            status_code=403,
        )
    return profile

def _require_safety_officer() -> Profile:
    """Require the authenticated profile to have the Safety Officer role."""
    profile = auth_service.get_profile(g.access_token, g.user_id)
    if profile.role != Role.SAFETY_OFFICER:
        raise AuthError(
            "Only Safety Officers are authorized to access safety review tasks.",
            status_code=403,
        )
    return profile



@events_bp.post("")
@require_auth
def submit_event():
    try:
        event_request = EventSubmitRequest(
            **(request.get_json(silent=True) or {})
        )
    except ValidationError as error:
        return jsonify({"errors": _validation_messages(error)}), 400

    _require_organiser()
    event = event_service.submit_event(g.access_token, g.user_id, event_request)
    return jsonify({"event": event.model_dump(mode="json")}), 201


@events_bp.get("")
@require_auth
def list_my_events():
    _require_organiser()
    events = event_service.list_my_events(g.access_token, g.user_id)
    return jsonify(
        {"events": [event.model_dump(mode="json") for event in events]}
    ), 200


@events_bp.get("/<event_id>")
@require_auth
def get_my_event(event_id):
    _require_organiser()
    event = event_service.get_my_event(g.access_token, g.user_id, event_id)
    return jsonify({"event": event.model_dump(mode="json")}), 200


@events_bp.get("/<event_id>/clarifications")
@require_auth
def list_my_event_clarifications(event_id):
    _require_organiser()
    clarifications = event_service.list_event_clarifications(
        g.access_token, event_id, organiser_id=g.user_id
    )
    return jsonify(
        {"clarifications": [item.model_dump(mode="json") for item in clarifications]}
    ), 200


@events_bp.post("/<event_id>/clarification-response")
@require_auth
def respond_to_event_clarification(event_id):
    try:
        clarification_response = EventClarificationResponse(
            **(request.get_json(silent=True) or {})
        )
    except ValidationError as error:
        return jsonify({"errors": _validation_messages(error)}), 400

    _require_organiser()
    clarification = event_service.respond_to_event_clarification(
        g.access_token, g.user_id, event_id, clarification_response
    )
    return jsonify({"clarification": clarification.model_dump(mode="json")}), 200


@events_bp.get("/review")
@require_auth
def list_assigned_events():
    _require_coordinator()
    events = event_service.list_assigned_events(
        g.access_token, g.user_id
    )
    return jsonify(
        {"events": [event.model_dump(mode="json") for event in events]}
        # {"events": events}
    ), 200


@events_bp.get("/review/<event_id>")
@require_auth
def get_assigned_event(event_id):
    _require_coordinator()
    event = event_service.get_assigned_event(
        g.access_token, g.user_id, event_id
    )
    organiser = event_service.get_event_organiser(
        g.access_token, event.organiser_id
    )
    return jsonify(
        {
            "event": event.model_dump(mode="json"),
            "organiser": organiser.model_dump(mode="json") if organiser else None,
            "change_request": (
                event.change_request.model_dump(mode="json")
                if event.change_request else None
            ),
        }
    ), 200


def _review_change_request(event_id, decision):
    rejection = None
    if decision == "reject":
        try:
            rejection = EventChangeRequestDecision(
                **(request.get_json(silent=True) or {})
            )
        except ValidationError as error:
            return jsonify({"errors": _validation_messages(error)}), 400

    event, change_request = event_service.review_assigned_change_request(
        g.access_token,
        g.user_id,
        event_id,
        decision,
        rejection,
    )
    approved = decision == "approve"
    notification_service.notify(
        change_request.organiser_id,
        "event_change_approved" if approved else "event_change_rejected",
        "Event change request approved" if approved else "Event change request rejected",
        (
            f"The proposed changes to '{change_request.name}' have been "
            "approved and applied."
            if approved
            else f"The proposed changes to '{change_request.name}' were rejected. "
            f"Reason: {change_request.rejection_reason}"
        ),
        change_request.event_id,
    )
    event = event.model_copy(
        update={
            "change_request": change_request,
            "has_pending_change_request": False,
        }
    )
    return jsonify(
        {
            "event": event.model_dump(mode="json"),
            "change_request": change_request.model_dump(mode="json"),
        }
    ), 200


@events_bp.post("/review/<event_id>/change-request/approve")
@require_auth
def approve_assigned_change_request(event_id):
    _require_coordinator()
    return _review_change_request(event_id, "approve")


@events_bp.post("/review/<event_id>/change-request/reject")
@require_auth
def reject_assigned_change_request(event_id):
    _require_coordinator()
    return _review_change_request(event_id, "reject")


@events_bp.get("/review/<event_id>/clarifications")
@require_auth
def list_assigned_event_clarifications(event_id):
    _require_coordinator()
    clarifications = event_service.list_event_clarifications(
        g.access_token, event_id, coordinator_id=g.user_id
    )
    return jsonify(
        {"clarifications": [item.model_dump(mode="json") for item in clarifications]}
    ), 200


@events_bp.post("/review/<event_id>/clarification")
@require_auth
def request_event_clarification(event_id):
    try:
        clarification_request = EventClarificationRequest(
            **(request.get_json(silent=True) or {})
        )
    except ValidationError as error:
        return jsonify({"errors": _validation_messages(error)}), 400

    coordinator = _require_coordinator()
    clarification = event_service.request_event_clarification(
        g.access_token, g.user_id, event_id, clarification_request
    )
    _notify_clarification_requested(coordinator, clarification)
    return jsonify({"clarification": clarification.model_dump(mode="json")}), 201


def _notify_clarification_requested(coordinator, clarification) -> None:
    """Tell the Organiser their event needs clarification (T7-160).

    Runs only after the clarification is saved. Looking up the event name
    can fail too, and like notify() itself that must not undo the saved
    clarification, so a failed lookup is logged and no notification is sent.
    """
    try:
        event = event_service.get_assigned_event(
            g.access_token, g.user_id, clarification.event_id
        )
    except AuthError:
        logger.exception(
            "Clarification %s was saved but its notification failed",
            clarification.id,
        )
        return

    notification_service.notify(
        clarification.organiser_id,
        "clarification_requested",
        "Clarification requested",
        (
            f"{coordinator.full_name} has requested clarification on "
            f"'{event.name}'. Your event is now Awaiting Clarification and "
            f"needs your response. Notes: {clarification.coordinator_notes}"
        ),
        clarification.event_id,
    )


@events_bp.post("/review/<event_id>/approve")
@require_auth
def approve_assigned_event(event_id):
    _require_coordinator()
    event = event_service.decide_assigned_event(
        g.access_token, g.user_id, event_id, EventStatus.PLANNING
    )
    return jsonify({"event": event.model_dump(mode="json")}), 200


@events_bp.post("/review/<event_id>/reject")
@require_auth
def reject_assigned_event(event_id):
    _require_coordinator()
    event = event_service.decide_assigned_event(
        g.access_token, g.user_id, event_id, EventStatus.REJECTED
    )
    return jsonify({"event": event.model_dump(mode="json")}), 200


@events_bp.post("/<event_id>/change-requests")
@require_auth
def submit_event_change_request(event_id):
    try:
        change_request = EventChangeRequestSubmit(
            **(request.get_json(silent=True) or {})
        )
    except ValidationError as error:
        return jsonify({"errors": _validation_messages(error)}), 400

    organiser = _require_organiser()
    event_service.submit_event_change_request(
        g.access_token, g.user_id, event_id, change_request
    )
    _notify_change_request_submitted(organiser, event_id, change_request)
    return jsonify({"message": "Change request submitted."}), 201


def _notify_change_request_submitted(organiser, event_id, change_request) -> None:
    """Tell the event's Coordinator a change request needs review (T7-164).

    Runs only after the change request is saved. A failed event lookup is
    logged rather than raised, so it cannot undo the saved change request.
    """
    try:
        event = event_service.get_my_event(g.access_token, g.user_id, event_id)
    except AuthError:
        logger.exception(
            "Change request for event %s was saved but its notification failed",
            event_id,
        )
        return

    # Every event should have a Coordinator by the time it can be changed,
    # but there is no one to notify if it does not.
    if not event.coordinator_id:
        return

    notification_service.notify(
        event.coordinator_id,
        "change_request_submitted",
        "Change request submitted",
        (
            f"{organiser.full_name} has submitted a change request for "
            f"'{event.name}'. Reason: {change_request.reason_for_change}"
        ),
        event_id,
    )


# --- Draft event requests (T7-37) ------------------------------------------
# Flask matches the fixed path /events/drafts before /events/<event_id>, so
# "drafts" is never mistaken for an event id.


@events_bp.post("/drafts")
@require_auth
def create_draft():
    try:
        draft_request = EventDraftRequest(
            **(request.get_json(silent=True) or {})
        )
    except ValidationError as error:
        return jsonify({"errors": _validation_messages(error)}), 400

    _require_organiser()
    draft = event_service.create_draft(g.access_token, g.user_id, draft_request)
    return jsonify({"event": draft.model_dump(mode="json")}), 201


@events_bp.get("/drafts")
@require_auth
def list_my_drafts():
    _require_organiser()
    drafts = event_service.list_my_drafts(g.access_token, g.user_id)
    return jsonify(
        {"events": [draft.model_dump(mode="json") for draft in drafts]}
    ), 200


@events_bp.get("/drafts/<draft_id>")
@require_auth
def get_my_draft(draft_id):
    _require_organiser()
    draft = event_service.get_my_draft(g.access_token, g.user_id, draft_id)
    return jsonify({"event": draft.model_dump(mode="json")}), 200


@events_bp.put("/drafts/<draft_id>")
@require_auth
def update_draft(draft_id):
    try:
        draft_request = EventDraftRequest(
            **(request.get_json(silent=True) or {})
        )
    except ValidationError as error:
        return jsonify({"errors": _validation_messages(error)}), 400

    _require_organiser()
    draft = event_service.update_draft(
        g.access_token, g.user_id, draft_id, draft_request
    )
    return jsonify({"event": draft.model_dump(mode="json")}), 200


@events_bp.post("/drafts/<draft_id>/submit")
@require_auth
def submit_draft(draft_id):
    # The same checks as a brand new request: a draft is only submitted
    # once it is complete.
    try:
        event_request = EventSubmitRequest(
            **(request.get_json(silent=True) or {})
        )
    except ValidationError as error:
        return jsonify({"errors": _validation_messages(error)}), 400

    _require_organiser()
    event = event_service.submit_draft(
        g.access_token, g.user_id, draft_id, event_request
    )
    return jsonify({"event": event.model_dump(mode="json")}), 200


@events_bp.delete("/drafts/<draft_id>")
@require_auth
def delete_draft(draft_id):
    _require_organiser()
    event_service.delete_draft(g.access_token, g.user_id, draft_id)
    return "", 204


@events_bp.get("/coordinators")
@require_auth
def get_coordinators():
    """Fetch all staff members with role='coordinator'."""
    try:
        coordinators = auth_service.get_coordinators(access_token=g.access_token)
        return jsonify({"coordinators": coordinators}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 400

@events_bp.get("/review/<event_id>/history")
@require_auth
def get_event_history(event_id):
    """Fetch activity history / audit trail for an event."""
    try:
        logs = event_service.get_event_activity_logs(
            event_id, access_token=g.access_token
        )
        return jsonify({"logs": logs}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@events_bp.post("/review/<event_id>/reassign")
@require_auth
def reassign_event(event_id):
    """Assign or reassign an event's coordinator, with an audit log entry."""
    data = request.get_json() or {}
    new_coordinator_id = data.get("new_coordinator_id")
    reason = data.get("reason", "").strip()

    if not new_coordinator_id:
        return jsonify({"error": "Please select a coordinator to reassign to."}), 400

    try:
        updated_event = event_assignment_service.assign_or_reassign_event(
            event_id=event_id,
            new_coordinator_id=new_coordinator_id,
            changed_by_id=g.user_id,
            reason=reason or None,
        )
        return jsonify({"event": updated_event}), 200
    except AuthError:
        raise
    except Exception as e:
        return jsonify({"error": str(e)}), 400
    

@events_bp.get("/lead-overview")
@require_auth
def get_lead_overview():
    try:
        raw_events = overview_coordinator_events_service.get_lead_coordinator_events(
            access_token=g.access_token
        )
        formatted_events = Event.format_lead_overview(raw_events)
        return jsonify(formatted_events), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 400
    

@events_bp.get("/unassigned-queue")
@require_auth
def get_unassigned_queue():
    """Fetch unassigned events queue for Lead Coordinators."""
    _require_coordinator()
    try:
        queue = event_assignment_service.get_unassigned_events_queue(
            access_token=g.access_token
        )
        return jsonify(queue), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@events_bp.get("/safety/queue")
@require_auth
def get_safety_queue():
    """Endpoint for Safety Officers to get FIFO ordered pending events."""
    try:
        _require_safety_officer()
        queue = safety_review_service.get_safety_review_queue(g.access_token)
        return jsonify({"queue": queue}), 200
    except AuthError as exc:
        return jsonify({"error": exc.message}), exc.status_code
    except Exception as exc:
        logger.error(f"Error in /events/safety/queue: {traceback.format_exc()}")
        return jsonify({"error": "Unable to load the safety queue."}), 500


@events_bp.get("/safety/review/<event_id>")
@require_auth
def get_safety_review_details(event_id):
    """Endpoint for inspecting event, layout, equipment, and safety flags."""
    try:
        _require_safety_officer()
        details = safety_review_service.get_safety_event_details(event_id, g.access_token)
        return jsonify(details), 200
    except AuthError as exc:
        return jsonify({"error": exc.message}), exc.status_code
    except Exception as exc:
        logger.error(f"Error in /events/safety/review/{event_id}: {traceback.format_exc()}")
        return jsonify({"error": "Unable to load this safety review."}), 500


@events_bp.post("/<event_id>/request-safety-check")
@require_auth
def request_safety_check(event_id):
    """Endpoint for coordinators to submit an event to the safety queue."""
    try:
        res = safety_review_service.request_safety_check(event_id, g.access_token)
        return jsonify(res), 200
    except AuthError as exc:
        return jsonify({"error": exc.message}), exc.status_code
    except Exception as exc:
        logger.error(f"Error requesting safety check for {event_id}: {traceback.format_exc()}")
        return jsonify({"error": "Unable to request a safety check."}), 500