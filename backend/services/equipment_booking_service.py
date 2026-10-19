"""Equipment time bookings through Supabase."""

from postgrest import APIError as PostgrestAPIError

import config
from models.equipment_booking import (
    EquipmentBookingCalendarRange,
    EquipmentBookingCreate,
    EquipmentBookingRange,
)
from services import notification_service
from services.auth_service import AuthError
from services.safety_review_service import check_and_update_safety_status


def _database_error(error: PostgrestAPIError) -> AuthError:
    if error.code in {"PGRST202", "PGRST205"}:
        return AuthError(
            "The equipment booking database setup is missing or out of date. "
            "Apply the equipment booking migrations in the documented order, "
            "then retry.",
            status_code=503,
        )
    if error.code == "42501":
        return AuthError(
            "Only Technical Support can manage equipment bookings.",
            status_code=403,
        )
    if error.code == "23P01":
        return AuthError(
            "This equipment is already booked for an overlapping time.",
            status_code=409,
        )
    if error.code == "P0001":
        return AuthError(
            "This request or equipment item has already been processed.",
            status_code=409,
        )
    if error.code == "23503":
        return AuthError(
            "The equipment or equipment request was not found.",
            status_code=404,
        )
    if error.code in {"22007", "22008", "22023", "22P02", "23514"}:
        return AuthError(
            "The booking details are invalid. Check the times and try again.",
            status_code=400,
        )
    return AuthError("Unable to access equipment bookings.", status_code=502)


def list_equipment_bookings(
    access_token: str,
    booking_range: EquipmentBookingRange,
) -> list[dict]:
    """List one item's bookings that overlap the given range."""
    client = config.get_user_client(access_token)
    try:
        result = client.rpc(
            "list_equipment_bookings",
            {
                "p_equipment_id": str(booking_range.equipment_id),
                "p_from": booking_range.start.isoformat(),
                "p_to": booking_range.end.isoformat(),
            },
        ).execute()
    except PostgrestAPIError as error:
        raise _database_error(error) from error

    if not isinstance(result.data, list):
        raise AuthError("Unable to load equipment bookings.", status_code=502)
    return result.data


def list_all_equipment_bookings(
    access_token: str,
    booking_range: EquipmentBookingCalendarRange,
) -> list[dict]:
    """List every equipment reservation in a calendar range."""
    client = config.get_user_client(access_token)
    try:
        result = client.rpc(
            "list_all_equipment_bookings",
            {
                "p_from": booking_range.start.isoformat(),
                "p_to": booking_range.end.isoformat(),
            },
        ).execute()
    except PostgrestAPIError as error:
        raise _database_error(error) from error

    if not isinstance(result.data, list):
        raise AuthError("Unable to load the equipment booking calendar.", status_code=502)
    return result.data


def create_equipment_booking(
    access_token: str,
    booking: EquipmentBookingCreate,
) -> dict:
    """Book a requested item for its event and report any schedule conflict."""
    client = config.get_user_client(access_token)
    try:
        result = client.rpc(
            "create_equipment_booking",
            {
                "p_equipment_id": str(booking.equipment_id),
                "p_request_id": str(booking.request_id),
                "p_start_at": booking.start_at.isoformat(),
                "p_end_at": booking.end_at.isoformat(),
            },
        ).execute()
    except PostgrestAPIError as error:
        raise _database_error(error) from error

    outcome = result.data
    if not isinstance(outcome, dict):
        raise AuthError("Equipment booking was not saved.", status_code=502)
    if outcome.get("outcome") == "unavailable":
        reason = outcome.get("reason")
        equipment_name = outcome.get("equipment_name", "Requested equipment")
        event_name = outcome.get("event_name", "your event")
        if reason == "maintenance":
            notification_body = (
                f"{equipment_name} is {outcome.get('equipment_status', 'unavailable')} "
                f"and cannot be allocated to {event_name}. Please contact Technical "
                "Support about alternatives."
            )
            unavailable_message = (
                f"{equipment_name} is unavailable because it is "
                f"{outcome.get('equipment_status', 'not functional')}."
            )
        elif reason == "overlap":
            notification_body = (
                f"{equipment_name} is already booked during {event_name}'s "
                "scheduled time. Please contact Technical Support about alternatives."
            )
            unavailable_message = (
                f"This equipment is already booked during {event_name}'s "
                "scheduled time."
            )
        else:
            raise AuthError(
                "Equipment availability could not be determined.",
                status_code=502,
            )

        notification = notification_service.notify(
            user_id=outcome["coordinator_id"],
            notification_type="equipment_requirement_unavailable",
            title="Equipment is unavailable",
            body=notification_body,
            event_id=outcome["event_id"],
        )
        detail = (
            "The Coordinator has been notified."
            if notification is not None
            else "The Coordinator could not be notified."
        )
        raise AuthError(
            f"{unavailable_message} {detail}",
            status_code=409,
        )
    if outcome.get("outcome") != "booked" or not isinstance(
        outcome.get("booking"), dict
    ):
        raise AuthError("Equipment booking was not saved.", status_code=502)
    


def delete_equipment_booking(access_token: str, booking_id: str) -> None:
    client = config.get_user_client(access_token)
    try:
        result = client.rpc(
            "delete_equipment_booking",
            {"p_booking_id": booking_id},
        ).execute()
    except PostgrestAPIError as error:
        raise _database_error(error) from error

    if result.data is not True:
        raise AuthError("Equipment booking was not found.", status_code=404)
