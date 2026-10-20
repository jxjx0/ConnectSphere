"""Tentative hold writes, shared occupancy and expiry notification delivery."""

from httpx import HTTPError
from postgrest import APIError as PostgrestAPIError
from pydantic import ValidationError

import config
from models.venue_hold import CreatedVenueHold
from services.venue_availability_service import VENUE_TIMEZONE
from services.auth_service import AuthError
from services.notification_service import notify


def _database_error(error):
    if error.code in {"22023", "23514", "22P02"}:
        return AuthError("Check the event, hold period and expiry. Expiry must be before the venue is needed.", status_code=400)
    if error.code == "23P01":
        return AuthError("This venue is unavailable during the hold period, including setup and turnaround.", status_code=409)
    if error.code == "42501":
        return AuthError("You do not have permission to manage this hold.", status_code=403)
    return AuthError("Unable to manage the venue hold. Please try again.", status_code=502)


def list_hold_events(access_token):
    try:
        data = config.get_user_client(access_token).rpc("get_venue_hold_events").execute().data
        if not isinstance(data, list) or any(not all(row.get(key) for key in ("id", "name")) for row in data):
            raise ValueError("invalid event choices")
        return data
    except PostgrestAPIError as error:
        raise _database_error(error) from error
    except (HTTPError, ValueError, TypeError, AttributeError) as error:
        raise AuthError("Unable to load events for a hold.", status_code=502) from error


def create_hold(access_token, venue_id, request):
    try:
        data = config.get_user_client(access_token).rpc("create_venue_tentative_hold", {
            "p_venue_id": venue_id, **{f"p_{key}": value for key, value in request.model_dump(mode="json").items()},
        }).execute().data
    except PostgrestAPIError as error:
        raise _database_error(error) from error
    except HTTPError as error:
        raise AuthError("Hold creation unconfirmed. Refresh the calendar before trying again.", status_code=502) from error
    try:
        stored = CreatedVenueHold.model_validate(data)
        data = stored.model_dump(mode="json")
        expiry = stored.expires_at
        if expiry.utcoffset() is None:
            raise ValueError("expiry needs a timezone")
    except (ValidationError, ValueError, TypeError) as error:
        raise AuthError("Hold creation unconfirmed. Refresh the calendar before trying again.", status_code=502) from error
    notification = notify(
        user_id=data["coordinator_id"], notification_type="venue_hold_created",
        title="Venue held temporarily",
        body=(f"{data['venue_name']} is held for {data['event_name']}. "
              f"Confirm the booking before {expiry.astimezone(VENUE_TIMEZONE).strftime('%d %b %Y, %H:%M')} "
              "(Singapore time), when the hold expires."),
        event_id=data["event_id"],
    )
    return {"hold": {key: value for key, value in data.items() if key != "coordinator_id"},
            "notification_status": "saved" if notification is not None else "failed"}


def process_expired_holds(client=None):
    """Run from the supplied CLI on a schedule; reads never send notifications.

    Leases prevent concurrent runners claiming the same hold. Failed sends retry
    after the lease; delivery across a process crash is at least once.
    """
    client = client if client is not None else config.get_admin_client()
    records = client.rpc("claim_expired_venue_holds").execute().data
    if not isinstance(records, list):
        raise AuthError("Unable to process expired holds.", status_code=502)
    sent = 0
    for hold in records:
        if not hold["coordinator_id"]:
            continue
        saved = notify(
            user_id=hold["coordinator_id"], notification_type="venue_hold_expired",
            title="Venue hold expired",
            body=(f"The hold on {hold['venue_name']} for {hold['event_name']} expired"
                  + (" before the booking was confirmed." if hold.get("completed_booking_id")
                     else ". Please check availability before requesting this venue.")),
            event_id=hold["event_id"],
        )
        if saved is not None:
            client.rpc("acknowledge_venue_hold_expiry", {
                "p_hold_id": hold["hold_id"], "p_claim": hold["expiry_claimed_at"],
            }).execute()
            sent += 1
    return sent
