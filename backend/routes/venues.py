"""Venue catalogue endpoints."""

from flask import Blueprint, g, jsonify, request
from pydantic import ValidationError

from models.profile import Role
from models.venue import VenueCreateRequest, VenueUpdateRequest
from models.venue_block import VenueBlockCreateRequest
from routes.auth import require_auth
from services import auth_service, venue_service, venue_block_service
from services.auth_service import AuthError

venues_bp = Blueprint("venues", __name__, url_prefix="/venues")


def _validation_messages(error: ValidationError) -> list[str]:
    """Turn Pydantic's error list into plain sentences for the frontend."""
    return [item["msg"].removeprefix("Value error, ") for item in error.errors()]


def _require_venue_staff() -> None:
    """Require the authenticated profile to have the venue_staff role."""
    profile = auth_service.get_profile(g.access_token, g.user_id)
    if profile.role != Role.VENUE_STAFF:
        raise AuthError(
            "Only Venue Staff can create venues.",
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


@venues_bp.post("/<venue_id>/blocks")
@require_auth
def create_venue_block(venue_id):
    try:
        block_request = VenueBlockCreateRequest(
            **(request.get_json(silent=True) or {})
        )
    except ValidationError as error:
        return jsonify({"errors": _validation_messages(error)}), 400

    _require_venue_staff()

    block = venue_block_service.create_venue_block(
        access_token=g.access_token,
        venue_id=venue_id,
        request=block_request,
        block_issuer=g.user_id,
    )

    return jsonify({"block": block}), 201

@venues_bp.get("")
@require_auth
def list_venues():
    venues = venue_service.list_venues(g.access_token)
    return jsonify(
        {"venues": [venue.model_dump(mode="json") for venue in venues]}
    ), 200
