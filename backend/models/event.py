"""Data shapes and validation for event requests."""

from datetime import datetime, timezone
from enum import Enum

from pydantic import BaseModel, Field, field_validator, model_validator


# Venue booking statuses that no longer hold a venue.
SETTLED_VENUE_BOOKING_STATUSES = ("CANCELLED", "REJECTED", "REJECTED_BY_SAFETY")


class EventStatus(str, Enum):
    """Every status an event row may hold.

    Kept in step with the events_status_valid constraint in
    database/events.sql. Submitting a request (T7-45) always produces
    UNDER_REVIEW; a Coordinator approving one moves it to PLANNING.
    """

    DRAFT = "draft"
    UNDER_REVIEW = "under_review"
    REJECTED = "rejected"
    PLANNING = "planning"
    CONFIRMED = "confirmed"
    COMPLETED = "completed"
    CHANGE_REQUESTED = "change_requested"
    AWAITING_CLARIFICATION = "awaiting_clarification"
    AWAITING_SAFETY_CHECK = "awaiting_safety_check"


class EventClarificationRequest(BaseModel):
    notes: str = Field(min_length=1, max_length=5000)

    @field_validator("notes")
    @classmethod
    def strip_notes(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("Clarification notes must not be blank")
        return stripped


class EventClarificationResponse(BaseModel):
    response: str = Field(min_length=1, max_length=5000)

    @field_validator("response")
    @classmethod
    def strip_response(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("Your response must not be blank")
        return stripped


class EventClarification(BaseModel):
    id: str
    event_id: str
    organiser_id: str
    coordinator_id: str
    coordinator_notes: str
    previous_status: EventStatus | None = None
    organiser_response: str | None = None
    requested_at: datetime
    responded_at: datetime | None = None


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


class EventSessionSubmit(BaseModel):
    """One session of a submitted event request (T7-273).

    Each session is a block of time with its own space and equipment needs,
    e.g. "Main programme" and "Breakout A" at the same time in different
    rooms. Sessions may overlap. The Organiser describes needs in free text;
    the Coordinator books the actual venue and equipment for each session.
    """

    name: str = Field(min_length=1, max_length=200)
    start_time: datetime
    end_time: datetime
    expected_attendance: int = Field(gt=0)
    location_preference: str | None = None
    layout_preference: str | None = None
    equipment_requirements: str | None = None

    @field_validator("name")
    @classmethod
    def strip_name(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("Give every session a name")
        return stripped

    @field_validator(
        "location_preference", "layout_preference", "equipment_requirements"
    )
    @classmethod
    def strip_optional_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        stripped = value.strip()
        return stripped or None

    @model_validator(mode="after")
    def validate_session_times(self) -> "EventSessionSubmit":
        """Reject backwards session times and sessions that have already started.

        The session name leads each message, so the Organiser can tell which
        session of several needs fixing.
        """
        if _as_utc(self.end_time) <= _as_utc(self.start_time):
            raise ValueError(f"{self.name}: End time must be after the start time")
        if _as_utc(self.start_time) <= datetime.now(timezone.utc):
            raise ValueError(f"{self.name}: Start time must be in the future")
        return self


class EventSession(BaseModel):
    """A row of the `event_sessions` table.

    The details are optional because a draft's sessions may be incomplete.
    """

    id: str
    event_id: str
    name: str | None = None
    start_time: datetime | None = None
    end_time: datetime | None = None
    expected_attendance: int | None = None
    location_preference: str | None = None
    layout_preference: str | None = None
    equipment_requirements: str | None = None
    created_at: datetime | None = None


class EventSubmitRequest(BaseModel):
    """The body of POST /events and POST /events/drafts/<id>/submit.

    The Organiser describes what they need in free text. They do not pick a
    venue or specific equipment -- the Coordinator and Technical Support do
    that later, so there are no venue or equipment ids here.

    Times, attendance and space and equipment needs belong to each session
    (section 9.1 of the scope doc). Accessibility stays event-level.
    """

    name: str = Field(min_length=1, max_length=200)
    description: str = Field(min_length=1)
    purpose: str = Field(min_length=1)
    category: EventCategory
    category_other: str | None = Field(default=None, max_length=120)
    accessibility_requirements: str | None = None
    sessions: list[EventSessionSubmit]

    @field_validator("name", "description", "purpose")
    @classmethod
    def strip_required_text(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("This field must not be blank")
        return stripped

    @field_validator("sessions")
    @classmethod
    def require_a_session(
        cls, value: list[EventSessionSubmit]
    ) -> list[EventSessionSubmit]:
        if not value:
            raise ValueError("Add at least one session")
        return value

    @field_validator("category_other", "accessibility_requirements")
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


class EventSessionDraft(BaseModel):
    """One session of a draft (T7-275): every field may still be empty.

    Whatever has been filled in is checked, so a draft never holds a session
    that could not be submitted later. "Start time must be in the future" is
    left to submission, as for the rest of a draft.
    """

    name: str | None = Field(default=None, max_length=200)
    start_time: datetime | None = None
    end_time: datetime | None = None
    expected_attendance: int | None = Field(default=None, gt=0)
    location_preference: str | None = None
    layout_preference: str | None = None
    equipment_requirements: str | None = None

    @field_validator(
        "name",
        "location_preference",
        "layout_preference",
        "equipment_requirements",
    )
    @classmethod
    def strip_optional_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        stripped = value.strip()
        return stripped or None

    @field_validator(
        "start_time", "end_time", "expected_attendance", mode="before"
    )
    @classmethod
    def empty_means_not_filled_in(cls, value):
        """An untouched form input arrives as "", which means not filled in."""
        if isinstance(value, str) and not value.strip():
            return None
        return value

    @model_validator(mode="after")
    def validate_filled_in_times(self) -> "EventSessionDraft":
        if (
            self.start_time
            and self.end_time
            and _as_utc(self.end_time) <= _as_utc(self.start_time)
        ):
            label = self.name or "A session"
            raise ValueError(f"{label}: End time must be after the start time")
        return self


class EventDraftRequest(BaseModel):
    """The body of POST /events/drafts and PUT /events/drafts/<id>.

    A draft may be incomplete, so only name is required, and it may have no
    sessions yet. Whatever has been filled in is still checked, so a draft
    never holds data that could not be submitted later.
    """

    name: str = Field(min_length=1, max_length=200)
    description: str | None = None
    purpose: str | None = None
    category: EventCategory | None = None
    category_other: str | None = Field(default=None, max_length=120)
    accessibility_requirements: str | None = None
    sessions: list[EventSessionDraft] = []

    @field_validator("name")
    @classmethod
    def strip_name(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("Give the draft a name before saving it")
        return stripped

    @field_validator(
        "description",
        "purpose",
        "category_other",
        "accessibility_requirements",
    )
    @classmethod
    def strip_optional_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        stripped = value.strip()
        return stripped or None

    @field_validator("category", mode="before")
    @classmethod
    def empty_means_not_filled_in(cls, value):
        """An untouched form input arrives as "", which means not filled in."""
        if isinstance(value, str) and not value.strip():
            return None
        return value

    @model_validator(mode="after")
    def validate_filled_in_fields(self) -> "EventDraftRequest":
        if self.category_other and self.category is not EventCategory.OTHER:
            raise ValueError(
                "Only choose a category description when the category is Other"
            )
        return self


class EventChangeRequestSessionSubmit(BaseModel):
    """One session in an Organiser's proposed change (T7-280).

    session_id names the existing session being kept or edited, so only its
    own arrangements are affected; no session_id means a new session
    (scope doc 9.1). The database checks that edited sessions have not
    already started, since that needs their current values.
    """

    session_id: str | None = None
    name: str = Field(min_length=1, max_length=200)
    start_time: datetime
    end_time: datetime
    expected_attendance: int = Field(gt=0)
    location_preference: str | None = None
    layout_preference: str | None = None
    equipment_requirements: str | None = None

    @field_validator("name")
    @classmethod
    def strip_name(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("Give every session a name")
        return stripped

    @field_validator(
        "location_preference", "layout_preference", "equipment_requirements"
    )
    @classmethod
    def strip_optional_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        stripped = value.strip()
        return stripped or None

    @model_validator(mode="after")
    def validate_session_times(self) -> "EventChangeRequestSessionSubmit":
        if _as_utc(self.end_time) <= _as_utc(self.start_time):
            raise ValueError(f"{self.name}: End time must be after the start time")
        # A kept session may have started already; the database decides
        # whether it changed.
        if self.session_id is None and _as_utc(self.start_time) <= datetime.now(timezone.utc):
            raise ValueError(f"{self.name}: Start time must be in the future")
        return self


class EventChangeRequestSubmit(BaseModel):
    """The body of POST /events/<id>/change-requests.

    The whole event in one request: its details plus every session it
    should have afterwards. Existing sessions left out are removed.
    """

    name: str = Field(min_length=1, max_length=200)
    description: str = Field(min_length=1)
    reason_for_change: str = Field(min_length=1)
    purpose: str = Field(min_length=1)
    category: EventCategory
    category_other: str | None = Field(default=None, max_length=120)
    accessibility_requirements: str | None = None
    sessions: list[EventChangeRequestSessionSubmit]

    @field_validator("name", "description", "reason_for_change", "purpose")
    @classmethod
    def strip_and_require_text(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("This field must not be blank")
        return stripped

    @field_validator("category_other", "accessibility_requirements")
    @classmethod
    def strip_optional_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        stripped = value.strip()
        return stripped or None

    @field_validator("sessions")
    @classmethod
    def require_a_session(
        cls, value: list[EventChangeRequestSessionSubmit]
    ) -> list[EventChangeRequestSessionSubmit]:
        if not value:
            raise ValueError("Keep at least one session")
        kept = [session.session_id for session in value if session.session_id]
        if len(kept) != len(set(kept)):
            raise ValueError("Each session can only be listed once")
        return value

    @model_validator(mode="after")
    def validate_change_request(self) -> "EventChangeRequestSubmit":
        if self.category is EventCategory.OTHER and not self.category_other:
            raise ValueError("Describe the category when choosing Other")
        if self.category is not EventCategory.OTHER and self.category_other:
            raise ValueError(
                "Only choose a category description when the category is Other"
            )
        return self


class EventChangeRequestApproval(BaseModel):
    """The body of POST /events/review/<id>/change-request/approve (T7-281).

    The pending venue bookings of moved or removed sessions that the
    Coordinator chose to cancel. Unticked ones stay pending.
    """

    cancel_booking_ids: list[str] = Field(default_factory=list)


class EventChangeRequestDecision(BaseModel):
    """A Coordinator's required reason for rejecting a proposed change."""

    reason: str = Field(min_length=1, max_length=2000)

    @field_validator("reason")
    @classmethod
    def strip_reason(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("Give a reason for rejecting this change request")
        return stripped


class EventChangeRequestSession(BaseModel):
    """A row of `event_change_request_sessions`: one proposed session.

    session_id is the existing session it keeps or edits, or None for a new
    session.
    """

    id: str
    session_id: str | None = None
    name: str
    start_time: datetime
    end_time: datetime
    expected_attendance: int
    location_preference: str | None = None
    layout_preference: str | None = None
    equipment_requirements: str | None = None


class EventChangeRequest(BaseModel):
    """A saved proposed event change and its Coordinator review outcome."""

    id: str
    event_id: str
    organiser_id: str
    event_status_before_request: EventStatus
    name: str
    description: str
    reason_for_change: str
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
    status: str
    created_at: datetime | None = None
    reviewed_at: datetime | None = None
    rejection_reason: str | None = None
    # The proposed sessions (T7-280). start_time, end_time and
    # expected_attendance above are their overall span and largest session.
    sessions: list[EventChangeRequestSession] = []


class Event(BaseModel):
    """A row of the `events` table.

    coordinator_name is not a column. The service fills it in from the
    profiles table so the Organiser sees a name rather than a uuid, and it
    stays None until a Coordinator has been assigned.

    The details are optional because a draft may be incomplete. The
    database guarantees they are all present on any event that is not a
    draft (events_complete_unless_draft).

    start_time, end_time and expected_attendance are kept up to date by the
    database from the event's sessions: earliest start, latest end and
    largest session attendance. sessions is filled in by the service.
    """

    id: str
    organiser_id: str
    coordinator_id: str | None = None
    name: str
    description: str | None = None
    purpose: str | None = None
    category: EventCategory | None = None
    category_other: str | None = None
    start_time: datetime | None = None
    end_time: datetime | None = None
    expected_attendance: int | None = None
    location_preference: str | None = None
    layout_preference: str | None = None
    accessibility_requirements: str | None = None
    equipment_requirements: str | None = None
    status: EventStatus
    safety_status: str = "not_requested"
    created_at: datetime | None = None
    updated_at: datetime | None = None
    registration_opens_at: datetime | None = None
    registration_closes_at: datetime | None = None
    attendee_capacity: int | None = None
    published_at: datetime | None = None
    coordinator_name: str | None = None
    has_pending_change_request: bool = False
    change_request: EventChangeRequest | None = None
    sessions: list[EventSession] = []

    @classmethod
    def format_lead_overview(cls, raw_events):
        """
        Sanitizes, validates, and formats raw event dicts for the
        Event Coordinator Lead overview dashboard.
        Excludes completed and rejected status events.
        """
        if not isinstance(raw_events, list):
            return []

        formatted_events = []
        for evt in raw_events:
            if not evt or evt.get("status") in ["completed", "rejected"]:
                continue

            # One line per session's venue (T7-278). Cancelled and rejected
            # bookings hold no venue, so they are left out.
            live_bookings = sorted(
                (
                    booking for booking in evt.get("venue_bookings") or []
                    if booking.get("status") not in SETTLED_VENUE_BOOKING_STATUSES
                ),
                key=lambda booking: (booking.get("session") or {}).get("start_time") or "",
            )
            venues = [
                {
                    "session_name": (booking.get("session") or {}).get("name") or "Removed session",
                    "venue_name": (booking.get("venue") or {}).get("name") or "Unknown venue",
                    "status": booking.get("status"),
                }
                for booking in live_bookings
            ]

            coordinator = evt.get("coordinator") or {}

            formatted_events.append({
                "id": evt.get("id"),
                "name": evt.get("name", "Untitled Event"),
                "start_time": str(evt.get("start_time")) if evt.get("start_time") else None,
                "end_time": str(evt.get("end_time")) if evt.get("end_time") else None,
                "status": evt.get("status"),
                "equipment_requirements": evt.get("equipment_requirements") or "No specific equipment requested.",
                "venues": venues,
                "coordinator_id": evt.get("coordinator_id"),
                "coordinator_name": coordinator.get("full_name", "Unassigned"),
                "expected_attendance": evt.get("expected_attendance", 0),
                "sessions": evt.get("sessions") or [],
            })

        return formatted_events


class EventRegistrationRequest(BaseModel):
    """The body of PUT /events/<id>/registration.

    publish asks for the event to be posted for attendee registration as
    well as saved. The database decides whether the event may be published
    and checks the rules that need the event's current values: registration
    not yet closed, closing before the event starts, and capacity within the
    approved venue.
    """

    registration_opens_at: datetime
    registration_closes_at: datetime
    attendee_capacity: int = Field(gt=0)
    publish: bool = False

    @model_validator(mode="after")
    def validate_registration_period(self) -> "EventRegistrationRequest":
        if _as_utc(self.registration_closes_at) <= _as_utc(self.registration_opens_at):
            raise ValueError("Registration must close after it opens")
        return self


class EventArrangement(BaseModel):
    """A venue booking or equipment request of the Organiser's own event.

    kind is "venue" or "equipment". The venue fields are only filled in for
    venue bookings.
    """

    kind: str
    session_id: str | None = None
    status: str
    venue_name: str | None = None
    venue_location: str | None = None
    venue_capacity: int | None = None


class EventReviewSummary(BaseModel):
    """The fields needed to render the Coordinator's review list.

    sessions holds each session's id, name, times and equipment needs: the
    list shows how many there are, and the equipment request form uses them
    to pick a session (T7-279).
    """

    id: str
    name: str
    start_time: datetime
    end_time: datetime
    expected_attendance: int | None = None
    status: EventStatus
    safety_status: str = "not_requested"
    equipment_requirements: str | None = None
    venue_bookings: list[dict] = Field(default_factory=list)
    equipment_requests: list[dict] = Field(default_factory=list)
    sessions: list[dict] = Field(default_factory=list)


class EventOrganiser(BaseModel):
    """The Organiser's contact details, shown to their event's Coordinator."""

    full_name: str | None = None
    contact_number: str | None = None
    organization: str | None = None