"""Data shapes and validation for venue profiles."""

from datetime import time
from typing import Any

from pydantic import BaseModel, Field, field_validator, model_validator


class VenueLayout(BaseModel):
    """A supported venue layout and its maximum capacity."""

    name: str = Field(min_length=1, max_length=120)
    capacity: int = Field(gt=0)

    @field_validator("name")
    @classmethod
    def strip_name(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("layout name must not be blank")
        return stripped


class OperatingHours(BaseModel):
    """The venue's same-day opening and closing times."""

    open: str
    close: str

    @model_validator(mode="after")
    def validate_times(self) -> "OperatingHours":
        if (
            len(self.open) != 5
            or len(self.close) != 5
            or self.open[2] != ":"
            or self.close[2] != ":"
        ):
            raise ValueError("operating hours must use HH:MM values")

        try:
            opening = time.fromisoformat(self.open)
            closing = time.fromisoformat(self.close)
        except ValueError as error:
            raise ValueError("operating hours must use HH:MM values") from error

        if opening >= closing:
            raise ValueError("operating hours close time must be after open time")
        return self


class VenueCreateRequest(BaseModel):
    """The body of POST /venues."""

    name: str = Field(min_length=1, max_length=200)
    location: str | None = None
    capacity: int = Field(gt=0)
    facilities: Any = None
    accessibility: list[str] | None = None
    layouts: list[VenueLayout] = Field(min_length=1)
    operating_hours: OperatingHours

    @field_validator("name")
    @classmethod
    def strip_name(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("venue name must not be blank")
        return stripped

    @field_validator("location")
    @classmethod
    def strip_location(cls, value: str | None) -> str | None:
        if value is None:
            return None
        stripped = value.strip()
        return stripped or None

    @field_validator("accessibility")
    @classmethod
    def validate_accessibility(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return None
        stripped = [feature.strip() for feature in value]
        if any(not feature for feature in stripped):
            raise ValueError("accessibility features must not be blank")
        return stripped

    @model_validator(mode="after")
    def validate_unique_layouts(self) -> "VenueCreateRequest":
        names = [layout.name.casefold() for layout in self.layouts]
        if len(names) != len(set(names)):
            raise ValueError("layout names must be unique")
        return self

class VenueUpdateRequest(VenueCreateRequest):
    """The body of PUT /venues/<venue_id>."""


class Venue(BaseModel):
    """A row returned from the public.venues table."""

    id: str
    name: str
    location: str | None = None
    capacity: int
    facilities: Any = None
    accessibility: list[str] | None = None
    layouts: list[VenueLayout]
    operating_hours: OperatingHours
