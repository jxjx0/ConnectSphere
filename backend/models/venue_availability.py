"""Read-only calendar contracts; missing sources are not verified empty."""

from datetime import datetime, timezone
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field, field_validator

from models.venue_search import OccupiedPeriod
from models.venue_hold import ReservationItem


class VenueAvailabilityRequest(OccupiedPeriod):
    venue_id: UUID

    @field_validator("start_at", "end_at")
    @classmethod
    def normalize_timezone(cls, value: datetime) -> datetime:
        if value.utcoffset() is None:
            raise ValueError("availability timestamps must include a timezone offset")
        return value.astimezone(timezone.utc)


class OperationalBlockItem(OccupiedPeriod):
    id: UUID
    type: Literal["operational_block"] = "operational_block"
    reason: str = Field(min_length=1)
    source_booking_id: UUID | None = Field(default=None, exclude=True)


class ApprovedVenueBooking(OccupiedPeriod):
    """Staff-only occupancy projection with the event's current Coordinator."""

    booking_id: str = Field(min_length=1)
    venue_id: str = Field(min_length=1)
    venue_name: str = Field(min_length=1)
    event_id: str | None = None
    event_name: str | None = None
    coordinator_id: str | None = Field(default=None, min_length=1)
    status: Literal["APPROVED"]
    setup_time_minutes: int = Field(strict=True, ge=0, le=2147483647)
    turnaround_time_minutes: int = Field(strict=True, ge=0, le=2147483647)


class AvailabilitySources(BaseModel):
    operational_blocks: Literal["verified"] = "verified"
    confirmed_bookings: Literal["verified", "unavailable"] = "unavailable"
    tentative_holds: Literal["verified", "unavailable"] = "unavailable"
    hold_expiry: Literal["verified", "unavailable"] = "unavailable"
    venue_buffers: Literal["verified", "unavailable"] = "unavailable"


class VenueAvailabilityResponse(OccupiedPeriod):
    venue: dict[str, str]
    verification_status: Literal["verified", "partial"] = "partial"
    sources: AvailabilitySources = Field(default_factory=AvailabilitySources)
    items: list[OperationalBlockItem | ReservationItem]
