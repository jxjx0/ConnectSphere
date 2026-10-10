"""Search contracts, separate from venue configuration and booking writes."""

import re
from datetime import date as Date, datetime, time, timedelta, timezone

from pydantic import BaseModel, Field, field_validator, model_validator


class VenueSearchRequest(BaseModel):
    date: Date | None = None
    end_date: Date | None = None
    start_time: str | None = None
    end_time: str | None = None
    expected_attendance: int | None = Field(default=None, strict=True, gt=0)
    required_layout: str | None = Field(default=None, max_length=120)
    required_accessibility: str | None = None
    required_facility: str | None = None
    # Minutes east of UTC, supplied from the browser for the selected date.
    timezone_offset_minutes: int = Field(default=0, strict=True, ge=-840, le=840)
    end_timezone_offset_minutes: int | None = Field(default=None, strict=True, ge=-840, le=840)

    @field_validator("date", "end_date", "start_time", "end_time", "expected_attendance", "required_layout", "required_accessibility", "required_facility", mode="before")
    @classmethod
    def normalize_empty_filter(cls, value):
        if isinstance(value, str):
            return value.strip() or None
        return value

    @field_validator("date", "end_date", mode="before")
    @classmethod
    def validate_date(cls, value):
        if isinstance(value, str):
            value = value.strip() or None
        if value is None:
            return value
        if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            raise ValueError("date must use YYYY-MM-DD")
        return value

    @field_validator("start_time", "end_time")
    @classmethod
    def validate_time(cls, value: str | None) -> str | None:
        if value is None:
            return value
        if not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", value):
            raise ValueError("search times must use valid HH:MM values")
        return value

    @model_validator(mode="after")
    def validate_period(self):
        values = (self.date, self.start_time, self.end_time)
        if (any(value is not None for value in values) or self.end_date is not None) and not all(value is not None for value in values):
            raise ValueError("provide date, start time and end time together to check availability")
        if self.date is not None and self.period()[1] <= self.period()[0]:
            raise ValueError("end time must be after start time")
        return self

    def period(self) -> tuple[datetime, datetime] | None:
        if self.date is None:
            return None
        offset = timezone(timedelta(minutes=self.timezone_offset_minutes))
        end_offset = timezone(timedelta(minutes=(self.end_timezone_offset_minutes
                              if self.end_timezone_offset_minutes is not None else self.timezone_offset_minutes)))
        return (
            datetime.combine(self.date, time.fromisoformat(self.start_time), offset),
            datetime.combine(self.end_date or self.date, time.fromisoformat(self.end_time), end_offset),
        )


class OccupiedPeriod(BaseModel):
    """An effective occupied interval supplied by the booking read adapter."""

    start_at: datetime
    end_at: datetime

    @model_validator(mode="after")
    def validate_period(self):
        if self.start_at.utcoffset() is None or self.end_at.utcoffset() is None:
            raise ValueError("occupied periods require explicit timezones")
        if self.end_at <= self.start_at:
            raise ValueError("occupied period end must be after start")
        return self
