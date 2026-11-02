"""Equipment request persistence through Supabase."""

from postgrest import APIError as PostgrestAPIError

import config
from models.equipment_request import (
    EquipmentRequestCancel,
    EquipmentRequestReview,
    EquipmentRequestSubmit,
)
from models.profile import Role
from services import notification_service
from services.auth_service import AuthError

_REQUEST_SELECT = (
    "*, "
    "event:events(id,name,start_time,end_time), "
    "session:event_sessions(id,name,start_time,end_time,equipment_requirements), "
    "items:equipment_request_items("
    "id,equipment_id,quantity,equipment:equipment(id,name,type)), "
    "lines:equipment_request_lines(id,item_name,quantity,specifics), "
    "equipment_bookings(id,equipment_id,line_id,start_at,end_at,"
    "equipment:equipment(id,name))"
)


def _database_error(error: PostgrestAPIError) -> AuthError:
    if error.code == "EQ001":
        # Written for the user, e.g. "Allocate all the requested equipment..."
        return AuthError(error.message, status_code=409)
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
    """Atomically save what the session needs, one line per kind of equipment."""
    client = config.get_user_client(access_token)
    try:
        result = client.rpc(
            "submit_equipment_request_lines",
            {
                "p_event_id": str(equipment_request.event_id),
                "p_session_id": str(equipment_request.session_id),
                "p_lines": [
                    line.model_dump(mode="json")
                    for line in equipment_request.lines
                ],
            },
        ).execute()
    except PostgrestAPIError as error:
        if error.code == "P0001":
            raise AuthError(
                "An equipment request has already been submitted for this session.",
                status_code=409,
            ) from error
        raise _database_error(error) from error

    request_id = result.data
    if isinstance(request_id, list) and request_id:
        request_id = request_id[0]
    if not request_id:
        raise AuthError("Equipment request was not saved.", status_code=502)

    return {
        "id": str(request_id),
        "event_id": str(equipment_request.event_id),
        "session_id": str(equipment_request.session_id),
        "coordinator_id": coordinator_id,
        "status": "Pending Technical Approval",
        "lines": [
            line.model_dump(mode="json")
            for line in equipment_request.lines
        ],
    }


def list_equipment_requests(
    access_token: str,
    event_id: str | None = None,
) -> list[dict]:
    """List requests visible to the caller under the table's RLS policies."""
    client = config.get_user_client(access_token)
    try:
        query = client.table("equipment_requests").select(_REQUEST_SELECT)
        if event_id is not None:
            query = query.eq("event_id", event_id)
        result = query.order("created_at", desc=True).execute()
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
    """Record a decision. Approval needs equipment; a rejection tells the Coordinator why."""
    client = config.get_user_client(access_token)
    if review.decision == "Approved":
        _require_allocated_equipment(client, request_id)
    params = {"p_request_id": request_id, "p_decision": review.decision}
    if review.rejection_reason:
        params["p_rejection_reason"] = review.rejection_reason
    try:
        result = client.rpc("review_equipment_request", params).execute()
    except PostgrestAPIError as error:
        if error.code == "P0002":
            raise AuthError(
                "Equipment request was not found.",
                status_code=404,
            ) from error
        if error.code == "22023":
            raise AuthError(
                "The review decision is invalid.",
                status_code=400,
            ) from error
        if error.code == "P0001":
            raise AuthError(
                "This equipment request has already been reviewed.",
                status_code=409,
            ) from error
        raise _database_error(error) from error

    reviewed_request = result.data
    if not isinstance(reviewed_request, dict) or not reviewed_request.get("status"):
        raise AuthError("Unable to review the equipment request.", status_code=502)
    if review.decision == "Rejected" and reviewed_request.get("coordinator_id"):
        session = (
            f" ({reviewed_request['session_name']})"
            if reviewed_request.get("session_name")
            else ""
        )
        notification_service.notify(
            user_id=reviewed_request["coordinator_id"],
            notification_type="equipment_request_rejected",
            title="Equipment request rejected",
            body=(
                f"The equipment request for '{reviewed_request.get('event_name') or 'your event'}'"
                f"{session} was rejected. Reason: {review.rejection_reason}"
            ),
            event_id=reviewed_request.get("event_id"),
        )
    return reviewed_request


def cancel_equipment_request(
    access_token: str,
    request_id: str,
    cancellation: EquipmentRequestCancel,
) -> dict:
    """Cancel one request and free the items reserved for it (T7-282).

    The database function checks the Coordinator, the event status, the
    request status and the session start, and removes the request's
    equipment bookings, all in one transaction.
    """
    client = config.get_user_client(access_token)
    try:
        result = client.rpc(
            "cancel_equipment_request",
            {"p_request_id": request_id, "p_reason": cancellation.reason},
        ).execute()
    except PostgrestAPIError as error:
        if error.code == "42501":
            raise AuthError(
                "Only Event Coordinators can cancel equipment requests.",
                status_code=403,
            ) from error
        if error.code in {"P0002", "22P02"}:
            raise AuthError(
                "Equipment request was not found for an event assigned to you.",
                status_code=404,
            ) from error
        if error.code == "22023":
            raise AuthError(
                "Give a reason for cancelling this equipment request.",
                status_code=400,
            ) from error
        if error.code == "P0001":
            # Written for the Coordinator, e.g. "only while the event is in Planning".
            raise AuthError(error.message, status_code=409) from error
        raise _database_error(error) from error

    cancelled = result.data
    if not isinstance(cancelled, dict) or cancelled.get("status") != "Cancelled":
        raise AuthError("Unable to cancel the equipment request.", status_code=502)

    session = f" ({cancelled['session_name']})" if cancelled.get("session_name") else ""
    notification_service.notify_role(
        Role.TECH_SUPPORT.value,
        "equipment_request_cancelled",
        "Equipment request cancelled",
        f"The equipment request for '{cancelled.get('event_name') or 'an event'}'"
        f"{session} was cancelled by the Coordinator. Any equipment reserved "
        f"for it has been released. Reason: {cancelled.get('cancellation_reason')}",
        cancelled.get("event_id"),
    )
    return cancelled


def notify_line_unavailable(access_token: str, request_id: str, line_id: str) -> None:
    """Tell the Coordinator that a requested item cannot be supplied.

    For something with no item in the catalogue, which the booking function
    cannot report because there is nothing to try booking.
    """
    client = config.get_user_client(access_token)
    try:
        lines = (
            client.table("equipment_request_lines")
            .select("item_name, request:equipment_requests(status,coordinator_id,event_id)")
            .eq("id", line_id)
            .eq("request_id", request_id)
            .execute()
        ).data
    except PostgrestAPIError as error:
        raise _database_error(error) from error
    if not lines or not lines[0].get("request"):
        raise AuthError("That equipment request was not found.", status_code=404)

    line = lines[0]
    equipment_request = line["request"]
    if equipment_request["status"] != "Pending Technical Approval":
        raise AuthError("This equipment request has already been reviewed.", status_code=409)

    try:
        events = (
            client.table("events")
            .select("name")
            .eq("id", equipment_request["event_id"])
            .execute()
        ).data
    except PostgrestAPIError:
        events = []
    event_name = events[0]["name"] if events else "your event"

    notification = notification_service.notify(
        user_id=equipment_request["coordinator_id"],
        notification_type="equipment_requirement_unavailable",
        title="Equipment is unavailable",
        body=(
            f"Technical Support cannot supply {line['item_name']} for {event_name}. "
            "Please contact Technical Support about alternatives."
        ),
        event_id=equipment_request["event_id"],
    )
    if notification is None:
        raise AuthError("The Coordinator could not be notified.", status_code=502)


def _require_allocated_equipment(client, request_id: str) -> None:
    """Refuse approval until Technical Support has allocated at least one item.

    The review database function checks a request's lines, but one from before
    lines has none, so it could otherwise be approved holding no equipment.
    """
    try:
        bookings = (
            client.table("equipment_bookings")
            .select("id")
            .eq("request_id", request_id)
            .limit(1)
            .execute()
        )
    except PostgrestAPIError as error:
        raise _database_error(error) from error
    if not bookings.data:
        raise AuthError(
            "Allocate at least one item of equipment before approving this request.",
            status_code=409,
        )
