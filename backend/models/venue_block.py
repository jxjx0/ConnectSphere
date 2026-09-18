"""Data shapes and validation for venue blocks."""

from datetime import datetime

from pydantic import BaseModel, Field, field_validator, model_validator


class VenueBlockCreateRequest(BaseModel):
    """The body of POST /venues/{venue_id}/blocks."""

    start_at: datetime
    end_at: datetime
    block_reason: str = Field(min_length=1, max_length=500)

    @field_validator("block_reason")
    @classmethod
    def strip_reason(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("block reason must not be blank")
        return stripped

    @model_validator(mode="after")
    def validate_times(self) -> "VenueBlockCreateRequest":
        if self.start_at >= self.end_at:
            raise ValueError("block end time must be after start time")
        return self
