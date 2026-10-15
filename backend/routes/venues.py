"""Venue catalogue endpoints."""

from flask import Blueprint, g, jsonify, request
from pydantic import ValidationError

from models.profile import Role
from models.venue import VenueCreateRequest, VenueUpdateRequest
from models.venue_block import VenueBlockCreateRequest
from models.venue_search import VenueSearchRequest
from models.venue_availability import VenueAvailabilityRequest
from routes.auth import require_auth
from services import auth_service, venue_service, venue_block_service
from services.auth_service import AuthError
from services import venue_search_service
from services import venue_availability_service

venues_bp = Blueprint("venues", __name__, url_prefix="/venues")


@venues_bp.get("/<venue_id>/availability")
@require_auth
def get_venue_availability(venue_id):
    profile = auth_service.get_profile(g.access_token, g.user_id)
    if profile.role not in {Role.VENUE_STAFF, Role.COORDINATOR}:
        raise AuthError("Only Venue Staff and Event Coordinators can view venue availability.", status_code=403)
    try:
        availability_request = VenueAvailabilityRequest(
            venue_id=venue_id, start_at=request.args.get("start_at"),
            end_at=request.args.get("end_at"),
        )
    except ValidationError as error:
        return jsonify({"errors": _validation_messages(error)}), 400
    result = venue_availability_service.get_venue_availability(g.access_token, availability_request)
    return jsonify(result.model_dump(mode="json")), 200


@venues_bp.post("/search")
@require_auth
def search_venues():
    profile = auth_service.get_profile(g.access_token, g.user_id)
    if profile.role != Role.COORDINATOR:
        raise AuthError("Only Event Coordinators can search venues.", status_code=403)
    try:
        search_request = VenueSearchRequest.model_validate(request.get_json(silent=True))
    except ValidationError as error:
        return jsonify({"errors": _validation_messages(error)}), 400
    return jsonify(venue_search_service.search_venues(g.access_token, search_request)), 200


def _validation_messages(error: ValidationError) -> list[str]:
    """Turn Pydantic's error list into plain sentences for the frontend."""
    return [item["msg"].removeprefix("Value error, ") for item in error.errors()]


def _require_venue_staff(message: str = "Only Venue Staff can create venues.") -> None:
    """Require the authenticated profile to have the venue_staff role."""
    profile = auth_service.get_profile(g.access_token, g.user_id)
    if profile.role != Role.VENUE_STAFF:
        raise AuthError(
            message,
            status_code=403,
        )


@venues_bp.post("")
@require_auth
def create_venue():
    try:
        venue_request = VenueCreateRequest(
            **(request.get_json(silent=True) or {})
        )
    except ValidationError as error:
        return jsonify({"errors": _validation_messages(error)}), 400

    _require_venue_staff()
    venue = venue_service.create_venue(g.access_token, venue_request)
    return jsonify({"venue": venue.model_dump(mode="json")}), 201


@venues_bp.put("/<venue_id>")
@require_auth
def update_venue(venue_id):
    try:
        venue_request = VenueUpdateRequest(
            **(request.get_json(silent=True) or {})
        )
    except ValidationError as error:
        return jsonify({"errors": _validation_messages(error)}), 400

    _require_venue_staff()
    venue = venue_service.update_venue(
        g.access_token,
        venue_id,
        venue_request,
    )
    return jsonify({"venue": venue.model_dump(mode="json")}), 200


@venues_bp.get("/<venue_id>/history")
@require_auth
def get_venue_history(venue_id):
    _require_venue_staff()
    history = venue_service.get_venue_history(g.access_token, venue_id)
    return jsonify(
        {"history": [record.model_dump(mode="json") for record in history]}
    ), 200


@venues_bp.post("/<venue_id>/blocks")
@require_auth
def create_venue_block(venue_id):
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"errors": ["Venue block request must be a JSON object."]}), 400

    try:
        block_request = VenueBlockCreateRequest(**payload)
    except ValidationError as error:
        return jsonify({"errors": _validation_messages(error)}), 400

    _require_venue_staff("Only Venue Staff can block venues.")

    outcome = venue_block_service.create_venue_block_outcome(
        access_token=g.access_token,
        venue_id=venue_id,
        request=block_request,
        block_issuer=g.user_id,
    )

    return jsonify(outcome), 201

@venues_bp.get("")
@require_auth
def list_venues():
    venues = venue_service.list_venues(g.access_token)
    return jsonify(
        {"venues": [venue.model_dump(mode="json") for venue in venues]}
    ), 200
