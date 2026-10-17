"""Equipment request persistence through Supabase."""

from postgrest import APIError as PostgrestAPIError

import config
from models.equipment_request import EquipmentRequestReview, EquipmentRequestSubmit
from services import notification_service
from services.auth_service import AuthError

_REQUEST_SELECT = (
    "*, "
    "event:events(id,name,start_time,end_time), "
    "items:equipment_request_items("
    "id,equipment_id,quantity,equipment:equipment(id,name,type))"
)


def _database_error(error: PostgrestAPIError) -> AuthError:
    if error.code == "42501":
        return AuthError(
            "You do not have permission to perform this equipment request action.",
            status_code=403,
        )
    if error.code == "P0002":
        return AuthError(
            "The event was not found, is not assigned to you, or is not eligible for an equipment request.",
            status_code=404,
        )
    if error.code == "P0001":
        return AuthError(
            "This equipment request has already been reviewed.",
            status_code=409,
        )
    if error.code in {"22023", "22P02", "23503", "23505", "23514"}:
        return AuthError(
            "The event or equipment details are invalid. Check the request and try again.",
            status_code=400,
        )
    return AuthError("Unable to access equipment requests.", status_code=502)


def submit_equipment_request(
    access_token: str,
    coordinator_id: str,
    equipment_request: EquipmentRequestSubmit,
) -> dict:
    """Atomically save a request and all requested item quantities."""
    client = config.get_user_client(access_token)
    try:
        result = client.rpc(
            "submit_equipment_request",
            {
                "p_event_id": str(equipment_request.event_id),
                "p_items": [
                    item.model_dump(mode="json")
                    for item in equipment_request.items
                ],
            },
        ).execute()
    except PostgrestAPIError as error:
        raise _database_error(error) from error

    request_id = result.data
    if isinstance(request_id, list) and request_id:
        request_id = request_id[0]
    if not request_id:
        raise AuthError("Equipment request was not saved.", status_code=502)

    return {
        "id": str(request_id),
        "event_id": str(equipment_request.event_id),
        "coordinator_id": coordinator_id,
        "status": "Pending Technical Approval",
        "items": [
            {
                "equipment_id": str(item.equipment_id),
                "quantity": item.quantity,
            }
            for item in equipment_request.items
        ],
    }


def list_equipment_requests(access_token: str) -> list[dict]:
    """List requests visible to the caller under the table's RLS policies."""
    client = config.get_user_client(access_token)
    try:
        result = (
            client.table("equipment_requests")
            .select(_REQUEST_SELECT)
            .order("created_at", desc=True)
            .execute()
        )
    except PostgrestAPIError as error:
        raise _database_error(error) from error
    return result.data


def list_tech_support_equipment_requests(access_token: str) -> list[dict]:
    """List requests enriched with organiser, booking, and availability data."""
    client = config.get_user_client(access_token)
    try:
        result = client.rpc("list_equipment_request_review_queue").execute()
    except PostgrestAPIError as error:
        raise _database_error(error) from error

    if not isinstance(result.data, list):
        raise AuthError("Unable to load equipment requests.", status_code=502)
    return result.data


def review_equipment_request(
    access_token: str,
    request_id: str,
    review: EquipmentRequestReview,
) -> dict:
    """Atomically approve and reserve available equipment, or reject a request."""
    client = config.get_user_client(access_token)
    try:
        result = client.rpc(
            "review_equipment_request",
            {
                "p_request_id": request_id,
                "p_decision": review.decision,
            },
        ).execute()
    except PostgrestAPIError as error:
        if error.code == "P0002":
            raise AuthError(
                "Equipment request was not found.",
                status_code=404,
            ) from error
        if error.code == "22023":
            raise AuthError(
                "The equipment request does not contain valid items to review.",
                status_code=400,
            ) from error
        raise _database_error(error) from error

    outcome = result.data
    if not isinstance(outcome, dict):
        raise AuthError("Unable to review the equipment request.", status_code=502)

    if outcome.get("outcome") == "unavailable":
        if not outcome.get("coordinator_id") or not outcome.get("event_id"):
            raise AuthError(
                "Equipment is unavailable, but its Coordinator could not be identified.",
                status_code=502,
            )
        event_name = outcome.get("event_name") or "the event"
        notification = notification_service.notify(
            user_id=outcome["coordinator_id"],
            notification_type="equipment_requirement_unavailable",
            title="Equipment is unavailable",
            body=(
                f"Some requested equipment for {event_name} is unavailable "
                "during the event's scheduled time. The request remains pending."
            ),
            event_id=outcome["event_id"],
        )
        if notification is None:
            message = (
                "The requested equipment is unavailable. The request remains "
                "pending, but the Coordinator could not be notified."
            )
        else:
            message = (
                "The requested equipment is unavailable. The request remains "
                "pending and the Coordinator has been notified."
            )
        raise AuthError(message, status_code=409)

    if outcome.get("outcome") != "reviewed" or not isinstance(
        outcome.get("request"), dict
    ):
        raise AuthError("Unable to review the equipment request.", status_code=502)
    return outcome["request"]
