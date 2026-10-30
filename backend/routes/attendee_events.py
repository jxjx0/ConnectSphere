"""Attendee event endpoints. Thin handlers: parse, call the service, return JSON."""

from flask import Blueprint, g, jsonify, request
from pydantic import ValidationError

from models.attendee_registration import AttendeeRegistrationSubmit
from models.profile import Role
from routes.auth import require_auth
from services import attendee_registration_service, auth_service
from services.auth_service import AuthError

attendee_events_bp = Blueprint("attendee_events", __name__, url_prefix="/attendee")


def _validation_messages(error: ValidationError) -> list[str]:
    """Turn Pydantic's error list into plain sentences for the frontend."""
    return [item["msg"].removeprefix("Value error, ") for item in error.errors()]


def _require_attendee(action: str) -> None:
    """Require the authenticated profile to have the attendee role."""
    profile = auth_service.get_profile(g.access_token, g.user_id)
    if profile.role != Role.ATTENDEE:
        raise AuthError(f"Only Attendees can {action}.", status_code=403)


@attendee_events_bp.get("/events")
@require_auth
def list_published_events():
    _require_attendee("browse events open for registration")
    events = attendee_registration_service.list_published_events(g.access_token)
    return jsonify(
        {"events": [event.model_dump(mode="json") for event in events]}
    ), 200


@attendee_events_bp.get("/events/<event_id>")
@require_auth
def get_published_event(event_id):
    _require_attendee("view events open for registration")
    event = attendee_registration_service.get_published_event(
        g.access_token, event_id
    )
    return jsonify(
        {
            "event": event.model_dump(mode="json"),
            "account_email": attendee_registration_service.get_account_email(
                g.access_token
            ),
        }
    ), 200


@attendee_events_bp.post("/events/<event_id>/registrations")
@require_auth
def register_for_event(event_id):
    try:
        details = AttendeeRegistrationSubmit(**(request.get_json(silent=True) or {}))
    except ValidationError as error:
        return jsonify({"errors": _validation_messages(error)}), 400

    _require_attendee("register for events")
    registration = attendee_registration_service.register_for_event(
        g.access_token, event_id, details
    )
    email_sent = attendee_registration_service.send_registration_confirmation(
        registration
    )
    return jsonify(
        {
            "registration": registration.model_dump(mode="json"),
            "email_sent": email_sent,
        }
    ), 201


@attendee_events_bp.get("/registrations")
@require_auth
def list_my_registrations():
    _require_attendee("view their event registrations")
    registrations = attendee_registration_service.list_my_registrations(
        g.access_token
    )
    return jsonify(
        {"registrations": [item.model_dump(mode="json") for item in registrations]}
    ), 200


@attendee_events_bp.get("/registrations/<registration_id>")
@require_auth
def get_my_registration(registration_id):
    _require_attendee("view their event registrations")
    registration = attendee_registration_service.get_my_registration(
        g.access_token, registration_id
    )
    return jsonify({"registration": registration.model_dump(mode="json")}), 200
