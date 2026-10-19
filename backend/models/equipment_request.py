"""Data shapes and validation for event equipment requests."""

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field, model_validator


class EquipmentRequestItemSubmit(BaseModel):
    equipment_id: UUID
    quantity: int = Field(gt=0)


class EquipmentRequestSubmit(BaseModel):
    event_id: UUID
    request_details: str = Field(min_length=1, max_length=2000)
    items: list[EquipmentRequestItemSubmit] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_request_details(self) -> "EquipmentRequestSubmit":
        self.request_details = self.request_details.strip()
        if not self.request_details:
            raise ValueError("Describe the equipment needed for this event.")
        return self

    @model_validator(mode="after")
    def validate_unique_equipment(self) -> "EquipmentRequestSubmit":
        equipment_ids = [item.equipment_id for item in self.items]
        if len(equipment_ids) != len(set(equipment_ids)):
            raise ValueError("Each equipment item can only be listed once.")
        return self


class EquipmentRequestReview(BaseModel):
    decision: Literal["Approved", "Rejected"]
