"""Attendee event registration through Supabase.

Attendees cannot read events directly under row-level security, so both
reads and the registration itself go through database functions in
database/attendee_registrations.sql.
"""

from datetime import datetime

from postgrest import APIError as PostgrestAPIError
from supabase import AuthApiError

import config
from models.attendee_registration import (
    AttendeeRegistration,
    AttendeeRegistrationSubmit,
    PublishedEvent,
)
from services import notification_service
from services import venue_availability_service as availability
from services.auth_service import AuthError

EVENT_NOT_FOUND = (
    "This event was not found or is no longer open to attendees. "
    "Choose another event from the events list."
)
REGISTRATION_NOT_FOUND = "Registration was not found."
# Same wording as get_my_event in event_service.py.
ORGANISER_EVENT_NOT_FOUND = "Event request was not found."

# Message fragments raised by register_for_event, and the reply for each.
# Every reply tells the attendee what they can do next.
REGISTRATION_ERRORS = {
    "only a signed-in attendee": (
        "Only Attendees can register for events. Log in with an Attendee account.",
        403,
    ),
    "event was not found": (EVENT_NOT_FOUND, 404),
    "registration has not opened yet": (
        "Registration for this event has not opened yet. "
        "Come back once registration opens.",
        409,
    ),
    "registration has closed": (
        "Registration for this event has closed. "
        "Choose another event from the events list.",
        409,
    ),
    "account is already registered": (
        "You are already registered for this event. "
        "See My registrations for your details.",
        409,
    ),
    "account has no email address": (
        "Your account has no email address, so we cannot send your "
        "confirmation. Contact support to add one, then try again.",
        409,
    ),
    "event is full": (
        "This event is full, so no spots are left. "
        "Choose another event from the events list.",
        409,
    ),
}


def _registration_database_error(error: PostgrestAPIError) -> AuthError:
    """Translate PostgREST failures that are not one of our own messages."""
    if error.code in {
        "42P01", "42703", "PGRST202", "PGRST204", "PGRST205", "42883"
    }:
        return AuthError(
            "Event registration is not available yet. Apply "
            "database/attendee_registrations.sql, then refresh the API "
            "schema cache if needed.",
            status_code=503,
        )
    # The unique index catches a duplicate that slipped past the checks.
    if error.code == "23505":
        return AuthError(
            "You are already registered for this event. "
            "See My registrations for your details.",
            status_code=409,
        )
    # The event id is the only value that can fail to parse (not a uuid).
    if error.code == "22P02":
        return AuthError(EVENT_NOT_FOUND, status_code=404)
    if error.code in {"23502", "23514"}:
        return AuthError(
            "Registration details violate a database validation rule. "
            "Check your full name is filled in, then try again.",
            status_code=400,
        )
    if error.code in {"42501", "PGRST301"}:
        return AuthError(
            "You do not have permission to register for this event.",
            status_code=403,
        )
    return AuthError(
        "Unable to complete the registration. Please try again.", status_code=502
    )


def get_account_email(access_token: str) -> str | None:
    """The signed-in user's email, shown read-only on the registration form.

    Emails live in Supabase Auth, not in `profiles`. None if it cannot be
    read; the registration still uses the account email either way.
    """
    try:
        result = config.get_client().auth.get_user(access_token)
    except AuthApiError:
        return None
    return result.user.email if result and result.user else None


def _load_published_events(access_token: str, event_id: str | None) -> list[dict]:
    client = config.get_user_client(access_token)
    params = {"p_event_id": event_id} if event_id else {}
    try:
        result = client.rpc("list_published_events", params).execute()
    except PostgrestAPIError as error:
        raise _registration_database_error(error) from error
    return result.data or []


def list_published_events(access_token: str) -> list[PublishedEvent]:
    """Return every confirmed, published event, earliest first."""
    return [
        PublishedEvent(**row) for row in _load_published_events(access_token, None)
    ]


def get_published_event(access_token: str, event_id: str) -> PublishedEvent:
    """Return one confirmed, published event, or 404."""
    rows = _load_published_events(access_token, event_id)
    if not rows:
        raise AuthError(EVENT_NOT_FOUND, status_code=404)
    return PublishedEvent(**rows[0])


def _load_my_registrations(
    access_token: str, registration_id: str | None
) -> list[dict]:
    client = config.get_user_client(access_token)
    params = {"p_registration_id": registration_id} if registration_id else {}
    try:
        result = client.rpc("list_my_registrations", params).execute()
    except PostgrestAPIError as error:
        if error.code == "22P02":
            raise AuthError(REGISTRATION_NOT_FOUND, status_code=404) from error
        raise _registration_database_error(error) from error
    return result.data or []


def list_my_registrations(access_token: str) -> list[AttendeeRegistration]:
    """Return the signed-in attendee's registrations, newest first."""
    return [
        AttendeeRegistration(**row)
        for row in _load_my_registrations(access_token, None)
    ]


def get_my_registration(
    access_token: str, registration_id: str
) -> AttendeeRegistration:
    """Return one of the signed-in attendee's registrations, or 404."""
    rows = _load_my_registrations(access_token, registration_id)
    if not rows:
        raise AuthError(REGISTRATION_NOT_FOUND, status_code=404)
    return AttendeeRegistration(**rows[0])


def _registration_count_error(error: PostgrestAPIError) -> AuthError:
    """Translate failures of count_event_registrations for the Organiser."""
    if error.code in {"42883", "PGRST202"}:
        return AuthError(
            "Sign-up counts are not available yet. Apply "
            "database/attendee_registrations.sql, then refresh the API "
            "schema cache if needed.",
            status_code=503,
        )
    if error.code == "22P02":
        return AuthError(ORGANISER_EVENT_NOT_FOUND, status_code=404)
    if error.code in {"42501", "PGRST301"}:
        return AuthError(
            "You do not have permission to view sign-ups for this event.",
            status_code=403,
        )
    return AuthError(
        "Unable to load the number of sign-ups. Please try again.",
        status_code=502,
    )


def count_event_registrations(access_token: str, event_id: str) -> int:
    """How many attendees have registered for the Organiser's own event.

    Another Organiser's event comes back as 404, the same answer as one
    that does not exist.
    """
    client = config.get_user_client(access_token)
    try:
        result = client.rpc(
            "count_event_registrations", {"p_event_id": event_id}
        ).execute()
    except PostgrestAPIError as error:
        raise _registration_count_error(error) from error
    if result.data is None:
        raise AuthError(ORGANISER_EVENT_NOT_FOUND, status_code=404)
    return result.data


def register_for_event(
    access_token: str,
    event_id: str,
    request: AttendeeRegistrationSubmit,
) -> AttendeeRegistration:
    """Register the attendee and return the saved registration.

    The database function checks the registration window, duplicates and
    remaining spots while holding a lock on the event, so concurrent
    registrations cannot oversell it.
    """
    client = config.get_user_client(access_token)
    try:
        result = client.rpc(
            "register_for_event",
            {
                "p_event_id": event_id,
                "p_full_name": request.full_name,
                "p_contact_number": request.contact_number,
            },
        ).execute()
    except PostgrestAPIError as error:
        message = str(error).lower()
        for fragment, (reply, status_code) in REGISTRATION_ERRORS.items():
            if fragment in message:
                raise AuthError(reply, status_code=status_code) from error
        raise _registration_database_error(error) from error

    rows = _load_my_registrations(access_token, result.data)
    if not rows:
        raise AuthError(
            "You are registered, but the registration details could not be "
            "loaded. See My registrations for your details.",
            status_code=502,
        )
    return AttendeeRegistration(**rows[0])


def _local_label(value: datetime | None) -> str:
    """A time as Singapore attendees read it, e.g. '7 Dec 2026, 09:00'."""
    if value is None:
        return "To be announced"
    return value.astimezone(availability.VENUE_TIMEZONE).strftime("%d %b %Y, %H:%M")


def send_registration_confirmation(registration: AttendeeRegistration) -> bool:
    """Email the confirmation to the account email it was registered under.

    Returns whether it was sent. A failed email does not undo the
    registration, which is already saved.
    """
    body = (
        f"Hi {registration.full_name},\n\n"
        f"Your registration for {registration.event_name} is confirmed.\n\n"
        f"Starts: {_local_label(registration.event_start_time)}\n"
        f"Ends: {_local_label(registration.event_end_time)}\n\n"
        "Your details\n"
        f"Name: {registration.full_name}\n"
        f"Email: {registration.email}\n"
        f"Contact number: {registration.contact_number or 'Not given'}\n\n"
        f"Registration reference: {registration.id}\n\n"
        "See you there,\nConnectSphere"
    )
    return notification_service.try_send_email(
        registration.email,
        f"Registration confirmed: {registration.event_name}",
        body,
    )
