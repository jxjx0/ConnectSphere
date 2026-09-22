"""Event request endpoints. Thin handlers: parse, call the service, return JSON."""

from flask import Blueprint, g, jsonify, request
from pydantic import ValidationError

from models.event import EventSubmitRequest
from models.profile import Role
from routes.auth import require_auth
from services import auth_service, event_service
from services.auth_service import AuthError

events_bp = Blueprint("events", __name__, url_prefix="/events")


def _validation_messages(error: ValidationError) -> list[str]:
    """Turn Pydantic's error list into plain sentences for the frontend."""
    return [item["msg"].removeprefix("Value error, ") for item in error.errors()]


def _require_organiser() -> None:
    """Require the authenticated profile to have the organiser role."""
    profile = auth_service.get_profile(g.access_token, g.user_id)
    if profile.role != Role.ORGANISER:
        raise AuthError(
            "Only Event Organisers can submit event requests.",
            status_code=403,
        )


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

