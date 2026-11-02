"""Event equipment request endpoints."""

from uuid import UUID

from flask import Blueprint, g, jsonify, request
from pydantic import ValidationError

from models.equipment_request import (
    EquipmentRequestCancel,
    EquipmentRequestReview,
    EquipmentRequestSubmit,
)
from models.profile import Role
from routes.auth import require_auth
from services import auth_service, equipment_request_service
from services.auth_service import AuthError

equipment_requests_bp = Blueprint("equipment_requests", __name__)


def _validation_messages(error: ValidationError) -> list[str]:
    return [item["msg"].removeprefix("Value error, ") for item in error.errors()]


def _get_role() -> Role:
    return auth_service.get_profile(g.access_token, g.user_id).role


@equipment_requests_bp.post("/equipment-requests")
@require_auth
def submit_equipment_request():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"errors": ["Equipment request must be a JSON object."]}), 400

    try:
        equipment_request = EquipmentRequestSubmit(**payload)
    except ValidationError as error:
        return jsonify({"errors": _validation_messages(error)}), 400

    if _get_role() != Role.COORDINATOR:
        raise AuthError(
            "Only Event Coordinators can submit equipment requests.",
            status_code=403,
        )

    saved_request = equipment_request_service.submit_equipment_request(
        g.access_token,
        g.user_id,
        equipment_request,
    )
    return jsonify({"request": saved_request}), 201


@equipment_requests_bp.get("/equipment-requests")
@require_auth
def list_equipment_requests():
    role = _get_role()
    if role not in (Role.COORDINATOR, Role.TECH_SUPPORT):
        raise AuthError(
            "Only Event Coordinators and Technical Support can view equipment requests.",
            status_code=403,
        )

    if role == Role.TECH_SUPPORT:
        requests = equipment_request_service.list_tech_support_equipment_requests(
            g.access_token
        )
        return jsonify({"requests": requests}), 200

    # A Coordinator's event page asks for just that event's request.
    event_id = request.args.get("event_id")
    if event_id is None:
        requests = equipment_request_service.list_equipment_requests(g.access_token)
    else:
        try:
            event_id = str(UUID(event_id))
        except ValueError:
            return jsonify({"errors": ["event_id must be a valid ID."]}), 400
        requests = equipment_request_service.list_equipment_requests(
            g.access_token, event_id
        )
    return jsonify({"requests": requests}), 200


@equipment_requests_bp.patch("/equipment-requests/<request_id>/review")
@require_auth
def review_equipment_request(request_id):
    if _get_role() != Role.TECH_SUPPORT:
        raise AuthError(
            "Only Technical Support can review equipment requests.",
            status_code=403,
        )

    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"errors": ["Equipment review must be a JSON object."]}), 400

    try:
        review = EquipmentRequestReview(**payload)
    except ValidationError as error:
        return jsonify({"errors": _validation_messages(error)}), 400

    updated_request = equipment_request_service.review_equipment_request(
        g.access_token,
        request_id,
        review,
    )
    return jsonify({"request": updated_request}), 200


@equipment_requests_bp.post(
    "/equipment-requests/<request_id>/lines/<line_id>/notify-unavailable"
)
@require_auth
def notify_equipment_line_unavailable(request_id, line_id):
    if _get_role() != Role.TECH_SUPPORT:
        raise AuthError(
            "Only Technical Support can report unavailable equipment.",
            status_code=403,
        )
    try:
        request_id, line_id = str(UUID(request_id)), str(UUID(line_id))
    except ValueError:
        return jsonify({"errors": ["The request and line must be valid IDs."]}), 400

    equipment_request_service.notify_line_unavailable(g.access_token, request_id, line_id)
    return "", 204


@equipment_requests_bp.patch("/equipment-requests/<request_id>/cancel")
@require_auth
def cancel_equipment_request(request_id):
    """Allow the event's Coordinator to cancel one of its requests (T7-282)."""
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"errors": ["Cancellation must be a JSON object."]}), 400

    try:
        cancellation = EquipmentRequestCancel(**payload)
    except ValidationError as error:
        return jsonify({"errors": _validation_messages(error)}), 400

    if _get_role() != Role.COORDINATOR:
        raise AuthError(
            "Only Event Coordinators can cancel equipment requests.",
            status_code=403,
        )

    cancelled = equipment_request_service.cancel_equipment_request(
        g.access_token,
        request_id,
        cancellation,
    )
    return jsonify({"request": cancelled}), 200
