"""Equipment time booking endpoints for Technical Support."""

from flask import Blueprint, g, jsonify, request
from pydantic import ValidationError

from models.equipment_booking import EquipmentBookingCreate, EquipmentBookingRange
from models.profile import Role
from routes.auth import require_auth
from services import auth_service, equipment_booking_service
from services.auth_service import AuthError

equipment_bookings_bp = Blueprint("equipment_bookings", __name__)


def _validation_messages(error: ValidationError) -> list[str]:
    return [item["msg"].removeprefix("Value error, ") for item in error.errors()]


def _require_tech_support() -> None:
    if auth_service.get_profile(g.access_token, g.user_id).role != Role.TECH_SUPPORT:
        raise AuthError(
            "Only Technical Support can manage equipment bookings.",
            status_code=403,
        )


@equipment_bookings_bp.get("/equipment-bookings")
@require_auth
def list_equipment_bookings():
    try:
        booking_range = EquipmentBookingRange(
            equipment_id=request.args.get("equipment_id"),
            start=request.args.get("from"),
            end=request.args.get("to"),
        )
    except ValidationError as error:
        return jsonify({"errors": _validation_messages(error)}), 400

    _require_tech_support()
    bookings = equipment_booking_service.list_equipment_bookings(
        g.access_token,
        booking_range,
    )
    return jsonify({"bookings": bookings}), 200


@equipment_bookings_bp.post("/equipment-bookings")
@require_auth
def create_equipment_booking():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"errors": ["Equipment booking must be a JSON object."]}), 400

    try:
        booking = EquipmentBookingCreate(**payload)
    except ValidationError as error:
        return jsonify({"errors": _validation_messages(error)}), 400

    _require_tech_support()
    saved_booking = equipment_booking_service.create_equipment_booking(
        g.access_token,
        booking,
    )
    return jsonify({"booking": saved_booking}), 201


@equipment_bookings_bp.delete("/equipment-bookings/<booking_id>")
@require_auth
def delete_equipment_booking(booking_id):
    _require_tech_support()
    equipment_booking_service.delete_equipment_booking(g.access_token, booking_id)
    return "", 204
