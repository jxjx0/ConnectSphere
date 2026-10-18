"""Data shapes and validation for venue bookings and staff review."""

from datetime import datetime, timezone
from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator, model_validator


class VenueBookingCreateRequest(BaseModel):
    """The body of POST /venues/{venue_id}/bookings."""

    event_id: Optional[str] = None
    room_layout: str = Field(min_length=1, max_length=100)
    start_at: datetime
    end_at: datetime

    @field_validator("start_at", "end_at")
    @classmethod
    def require_timezone(cls, value: datetime) -> datetime:
        if value.utcoffset() is None:
            raise ValueError("booking timestamps must include a timezone offset")
        return value.astimezone(timezone.utc)

    @field_validator("room_layout")
    @classmethod
    def strip_layout(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("room layout must not be blank")
        return stripped

    @model_validator(mode="after")
    def validate_times(self) -> "VenueBookingCreateRequest":
        if self.start_at >= self.end_at:
            raise ValueError("booking end time must be after start time")
        return self


class VenueBookingReviewRequest(BaseModel):
    """The body of PATCH /venues/bookings/{booking_id}/review."""

    status: Literal["APPROVED", "REJECTED"]
    rejection_reason: Optional[str] = Field(default=None, max_length=500)

    @model_validator(mode="after")
    def validate_rejection(self) -> "VenueBookingReviewRequest":
        if self.status == "REJECTED" and not (self.rejection_reason or "").strip():
            raise ValueError("a reason must be provided when rejecting a booking request")
        return self