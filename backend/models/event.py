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


class EventCategory(str, Enum):
    """The categories an Organiser may choose from.

    Kept in step with the events_category_valid constraint in
    database/events.sql, and with CATEGORY_LABELS in the frontend.

    The customer named "Event Categories" as a feature but never supplied a
    list, and maintaining one is a System Admin job that is out of scope for
    this release. This set is the team's assumption until the customer
    confirms it. OTHER lets an Organiser describe a category that is not
    here, in EventSubmitRequest.category_other.
    """

    CONFERENCE = "conference"
    WORKSHOP = "workshop"
    SEMINAR = "seminar"
    MEETING = "meeting"
    NETWORKING = "networking"
    PRODUCT_LAUNCH = "product_launch"
    TRAINING = "training"
    SOCIAL_EVENT = "social_event"
    CEREMONY = "ceremony"
    OTHER = "other"


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
    category: EventCategory
    category_other: str | None = Field(default=None, max_length=120)
    start_time: datetime
    end_time: datetime
    expected_attendance: int = Field(gt=0)
    location_preference: str | None = None
    layout_preference: str | None = None
    accessibility_requirements: str | None = None
    equipment_requirements: str | None = None

    @field_validator("name", "description", "purpose")
    @classmethod
    def strip_required_text(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("This field must not be blank")
        return stripped

    @field_validator(
        "category_other",
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
    def validate_category_other(self) -> "EventSubmitRequest":
        """Tie category_other to the 'Other' choice, both ways.

        Without the second half an Organiser could pick Conference and
        still send a category_other, leaving two categories on one row and
        no way to tell which one counts.
        """
        if self.category is EventCategory.OTHER and not self.category_other:
            raise ValueError(
                "Describe the category when choosing Other"
            )
        if self.category is not EventCategory.OTHER and self.category_other:
            raise ValueError(
                "Only choose a category description when the category is Other"
            )
        return self


class EventChangeRequestSubmit(BaseModel):
    """The proposed details in an Organiser's event change request."""

    name: str = Field(min_length=1, max_length=200)
    description: str = Field(min_length=1)
    reason_for_change: str = Field(min_length=1)
    purpose: str = Field(min_length=1)
    category: EventCategory
    category_other: str | None = Field(default=None, max_length=120)
    start_time: datetime
    end_time: datetime
    expected_attendance: int = Field(gt=0)
    location_preference: str | None
    layout_preference: str | None
    accessibility_requirements: str | None
    equipment_requirements: str | None

    @field_validator("name", "description", "reason_for_change", "purpose")
    @classmethod
    def strip_and_require_text(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("This field must not be blank")
        return stripped

    @field_validator("category_other")
    @classmethod
    def strip_category_other(cls, value: str | None) -> str | None:
        if value is None:
            return None
        stripped = value.strip()
        return stripped or None

    @field_validator(
        "location_preference", "layout_preference",
        "accessibility_requirements", "equipment_requirements",
        mode="before",
    )
    @classmethod
    def nil_means_no_requirement(cls, value: str) -> str | None:
        if not isinstance(value, str) or not value.strip():
            raise ValueError("This field must not be blank")
        stripped = value.strip()
        if stripped.casefold() == "nil":
            return None
        return stripped

    @model_validator(mode="after")
    def validate_change_request(self) -> "EventChangeRequestSubmit":
        if self.category is EventCategory.OTHER and not self.category_other:
            raise ValueError("Describe the category when choosing Other")
        if self.category is not EventCategory.OTHER and self.category_other:
            raise ValueError(
                "Only choose a category description when the category is Other"
            )
        if _as_utc(self.end_time) <= _as_utc(self.start_time):
            raise ValueError("End time must be after the start time")
        return self

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
    """A row of the `events` table.

    coordinator_name is not a column. The service fills it in from the
    profiles table so the Organiser sees a name rather than a uuid, and it
    stays None until a Coordinator has been assigned.
    """

    id: str
    organiser_id: str
    coordinator_id: str | None = None
    name: str
    description: str
    purpose: str
    category: EventCategory
    category_other: str | None = None
    start_time: datetime
    end_time: datetime
    expected_attendance: int
    location_preference: str | None = None
    layout_preference: str | None = None
    accessibility_requirements: str | None = None
    equipment_requirements: str | None = None
    status: EventStatus
    created_at: datetime | None = None
    coordinator_name: str | None = None
    has_pending_change_request: bool = False
