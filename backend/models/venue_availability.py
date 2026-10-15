"""Read-only calendar contracts; missing sources are not verified empty."""

from datetime import datetime, timezone
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field, field_validator

from models.venue_search import OccupiedPeriod


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


class AvailabilitySources(BaseModel):
    operational_blocks: Literal["verified"] = "verified"
    confirmed_bookings: Literal["unavailable"] = "unavailable"
    tentative_holds: Literal["unavailable"] = "unavailable"
    hold_expiry: Literal["unavailable"] = "unavailable"
    venue_buffers: Literal["unavailable"] = "unavailable"


class VenueAvailabilityResponse(OccupiedPeriod):
    venue: dict[str, str]
    verification_status: Literal["partial"] = "partial"
    sources: AvailabilitySources = Field(default_factory=AvailabilitySources)
    items: list[OperationalBlockItem]
