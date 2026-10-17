"""Equipment time bookings through Supabase."""

from postgrest import APIError as PostgrestAPIError

import config
from models.equipment_booking import EquipmentBookingCreate, EquipmentBookingRange
from services.auth_service import AuthError


def _database_error(error: PostgrestAPIError) -> AuthError:
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
    if error.code == "23503":
        return AuthError(
            "The equipment or equipment request was not found.",
            status_code=404,
        )
    if error.code in {"22007", "22008", "22P02", "23514"}:
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


def create_equipment_booking(
    access_token: str,
    booking: EquipmentBookingCreate,
) -> dict:
    """Book an item for a request; the database rejects overlapping bookings."""
    client = config.get_user_client(access_token)
    try:
        result = (
            client.table("equipment_bookings")
            .insert(
                {
                    "equipment_id": str(booking.equipment_id),
                    "request_id": str(booking.request_id),
                    "start_at": booking.start_at.isoformat(),
                    "end_at": booking.end_at.isoformat(),
                }
            )
            .execute()
        )
    except PostgrestAPIError as error:
        raise _database_error(error) from error

    if not result.data:
        raise AuthError("Equipment booking was not saved.", status_code=502)
    return result.data[0]


def delete_equipment_booking(access_token: str, booking_id: str) -> None:
    client = config.get_user_client(access_token)
    try:
        result = (
            client.table("equipment_bookings")
            .delete()
            .eq("id", booking_id)
            .execute()
        )
    except PostgrestAPIError as error:
        raise _database_error(error) from error

    if not result.data:
        raise AuthError("Equipment booking was not found.", status_code=404)
