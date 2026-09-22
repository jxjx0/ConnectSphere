"""Data shapes and validation for event requests."""

from datetime import datetime, timezone
from enum import Enum

from pydantic import BaseModel, Field, field_validator, model_validator


class EventStatus(str, Enum):
    """Every status an event row may hold.

    Kept in step with the events_status_valid constraint in
    database/events.sql. Submitting a request (T7-45) always produces
    SUBMITTED; the other values belong to later stories.
    """

    DRAFT = "draft"
    SUBMITTED = "submitted"
    UNDER_REVIEW = "under_review"
    AWAITING_CLARIFICATION = "awaiting_clarification"
    CHANGE_REQUESTED = "change_requested"
    PLANNING = "planning"
    CONFIRMED = "confirmed"
    COMPLETED = "completed"
    REJECTED = "rejected"
    CANCELLED = "cancelled"


def _as_utc(value: datetime) -> datetime:
    """Treat a datetime with no timezone as UTC.

    The browser's datetime-local input has no timezone, so a request can
    arrive either way. Comparing an aware datetime with a naive one raises
    a TypeError, so everything is normalised before it is compared.
    """
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


class EventSubmitRequest(BaseModel):
    """The body of POST /events.

    The Organiser describes what they need in free text. They do not pick a
    venue or specific equipment -- the Coordinator and Technical Support do
    that later, so there are no venue or equipment ids here.
    """

    name: str = Field(min_length=1, max_length=200)
    description: str = Field(min_length=1)
    purpose: str = Field(min_length=1)
    category: str = Field(min_length=1, max_length=120)
    start_time: datetime
    end_time: datetime
    expected_attendance: int = Field(gt=0)
    location_preference: str | None = None
    layout_preference: str | None = None
    accessibility_requirements: str | None = None
    equipment_requirements: str | None = None

    @field_validator("name", "description", "purpose", "category")
    @classmethod
    def strip_required_text(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("This field must not be blank")
        return stripped

    @field_validator(
        "location_preference",
        "layout_preference",
        "accessibility_requirements",
        "equipment_requirements",
    )
    @classmethod
    def strip_optional_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        stripped = value.strip()
        return stripped or None

    @model_validator(mode="after")
    def validate_event_times(self) -> "EventSubmitRequest":
        """Check the event runs forwards, and has not already happened.

        This is the whole of the date checking for this story. An event
        request names no venue, so there is nothing yet for a date to
        clash with -- availability is only meaningful once the Coordinator
        requests a specific venue.
        """
        if _as_utc(self.end_time) <= _as_utc(self.start_time):
            raise ValueError("End time must be after the start time")
        if _as_utc(self.start_time) <= datetime.now(timezone.utc):
            raise ValueError("Start time must be in the future")
        return self


class Event(BaseModel):
    """A row of the `events` table."""

    id: str
    organiser_id: str
    coordinator_id: str | None = None
    name: str
    description: str
    purpose: str
    category: str
    start_time: datetime
    end_time: datetime
    expected_attendance: int
    location_preference: str | None = None
    layout_preference: str | None = None
    accessibility_requirements: str | None = None
    equipment_requirements: str | None = None
    status: EventStatus
    created_at: datetime | None = None
