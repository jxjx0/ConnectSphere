"""Data shapes and validation for event equipment requests."""

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field, field_validator, model_validator


class EquipmentRequestLineSubmit(BaseModel):
    """How many of a kind of equipment a session needs.

    item_name is matched to equipment.type, so it may also name
    something not in the catalogue yet.
    """

    item_name: str = Field(min_length=1, max_length=120)
    quantity: int = Field(ge=1, le=100)
    specifics: str | None = Field(default=None, max_length=500)

    @field_validator("item_name")
    @classmethod
    def strip_item_name(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("Choose or enter the equipment needed.")
        return stripped

    @field_validator("specifics")
    @classmethod
    def strip_specifics(cls, value: str | None) -> str | None:
        return (value or "").strip() or None


class EquipmentRequestSubmit(BaseModel):
    # One request per session: the equipment is booked for that session's
    # own start and end (T7-279).
    event_id: UUID
    session_id: UUID
    lines: list[EquipmentRequestLineSubmit] = Field(min_length=1, max_length=30)

    @model_validator(mode="after")
    def validate_unique_equipment(self) -> "EquipmentRequestSubmit":
        names = [line.item_name.casefold() for line in self.lines]
        if len(names) != len(set(names)):
            raise ValueError("Each kind of equipment can only be listed once.")
        return self


class EquipmentRequestReview(BaseModel):
    decision: Literal["Approved", "Rejected"]


class EquipmentRequestCancel(BaseModel):
    """The body of PATCH /equipment-requests/{request_id}/cancel (T7-282)."""

    reason: str = Field(min_length=1, max_length=500)

    @field_validator("reason")
    @classmethod
    def strip_reason(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("Give a reason for cancelling this equipment request.")
        return stripped
