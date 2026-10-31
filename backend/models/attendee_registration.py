"""Data shapes and validation for attendees registering for events."""

import re
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, field_validator

# Mirrored in frontend/src/attendeeRegistration.js.
PHONE_PATTERN = re.compile(r"^[0-9+()\-\s]{6,30}$")


def _required_text(value: str, label: str, max_length: int) -> str:
    stripped = value.strip()
    if not stripped:
        raise ValueError(f"{label} is required")
    if len(stripped) > max_length:
        raise ValueError(f"{label} must be {max_length} characters or fewer")
    return stripped


class AttendeeRegistrationSubmit(BaseModel):
    """The body of POST /attendee/events/<id>/registrations.

    full_name defaults to blank so a missing name gets the same "is
    required" message as an empty one. The contact number is optional; a
    blank one is saved as none. There is no email: the database always uses
    the account's own email address.
    """

    model_config = ConfigDict(validate_default=True)

    full_name: str = ""
    contact_number: str | None = None

    @field_validator("full_name")
    @classmethod
    def validate_full_name(cls, value: str) -> str:
        return _required_text(value, "Full name", 120)

    @field_validator("contact_number")
    @classmethod
    def validate_contact_number(cls, value: str | None) -> str | None:
        contact_number = (value or "").strip()
        if not contact_number:
            return None
        if not PHONE_PATTERN.match(contact_number):
            raise ValueError("Contact number must be a valid phone number")
        return contact_number


class AttendeeRegistration(BaseModel):
    """A row of the list_my_registrations database function.

    The registration itself, plus the name, times and status of the event
    it is for.
    """

    id: str
    event_id: str
    attendee_id: str
    full_name: str
    email: str
    contact_number: str | None = None
    created_at: datetime | None = None
    event_name: str
    event_start_time: datetime | None = None
    event_end_time: datetime | None = None
    event_status: str
    status: Literal["registered", "withdrawn"] = "registered"
    withdrawn_at: datetime | None = None
    can_withdraw: bool = False


class PublishedEventSession(BaseModel):
    """A session of a published event, with its approved venue if any."""

    id: str
    name: str | None = None
    start_time: datetime | None = None
    end_time: datetime | None = None
    venue_name: str | None = None
    venue_location: str | None = None


class PublishedEvent(BaseModel):
    """A confirmed, published event as an attendee sees it.

    A row of the list_published_events database function. spots_left is
    attendee_capacity minus the registrations so far; is_registered says
    whether the signed-in attendee has already registered.
    """

    id: str
    name: str
    status: str = "confirmed"
    description: str | None = None
    purpose: str | None = None
    category: str | None = None
    category_other: str | None = None
    start_time: datetime | None = None
    end_time: datetime | None = None
    accessibility_requirements: str | None = None
    registration_opens_at: datetime | None = None
    registration_closes_at: datetime | None = None
    attendee_capacity: int | None = None
    spots_left: int | None = None
    is_registered: bool = False
    sessions: list[PublishedEventSession] = []
