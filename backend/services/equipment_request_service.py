"""Equipment request persistence through Supabase."""

from postgrest import APIError as PostgrestAPIError

import config
from models.equipment_request import EquipmentRequestSubmit
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
            "The event was not found or is not assigned to you.",
            status_code=404,
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

    return get_equipment_request(client, str(request_id), coordinator_id)


def get_equipment_request(client, request_id: str, coordinator_id: str) -> dict:
    """Load the newly submitted request with its event and equipment details."""
    try:
        result = (
            client.table("equipment_requests")
            .select(_REQUEST_SELECT)
            .eq("id", request_id)
            .eq("coordinator_id", coordinator_id)
            .execute()
        )
    except PostgrestAPIError as error:
        raise _database_error(error) from error

    if not result.data:
        raise AuthError("Equipment request was not found.", status_code=404)
    return result.data[0]


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
