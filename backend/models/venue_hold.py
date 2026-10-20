"""Tentative holds reserve event time; occupancy adds current venue buffers."""

from datetime import datetime, timezone
from uuid import UUID

from pydantic import Field, field_validator, model_validator

from models.venue_search import OccupiedPeriod


class VenueHoldCreateRequest(OccupiedPeriod):
    event_id: UUID
    expires_at: datetime

    @field_validator("start_at", "end_at", "expires_at")
    @classmethod
    def require_timezone(cls, value):
        if value.utcoffset() is None:
            raise ValueError("hold timestamps must include a timezone offset")
        return value.astimezone(timezone.utc)

    @model_validator(mode="after")
    def validate_expiry(self):
        if not datetime.now(timezone.utc) < self.expires_at <= self.start_at:
            raise ValueError("expiry must be in the future and no later than the hold start")
        return self


class LegacyReservationBlock(OccupiedPeriod):
    id: UUID
    reason: str = Field(min_length=1)


class ReservationItem(OccupiedPeriod):
    id: UUID
    venue_id: str = Field(min_length=1)
    type: str
    reason: str = Field(min_length=1)
    expires_at: datetime | None = None
    event_start_at: datetime | None = None
    event_end_at: datetime | None = None
    legacy_blocks: list[LegacyReservationBlock] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_kind(self):
        if self.type not in {"confirmed_booking", "tentative_hold"}:
            raise ValueError("unknown reservation type")
        if self.type == "tentative_hold" and (
            self.expires_at is None or self.expires_at.utcoffset() is None
        ):
            raise ValueError("tentative holds require an explicit expiry")
        return self


class CreatedVenueHold(OccupiedPeriod):
    hold_id: UUID
    venue_id: UUID
    event_id: UUID
    coordinator_id: UUID
    event_name: str = Field(min_length=1)
    venue_name: str = Field(min_length=1)
    expires_at: datetime
