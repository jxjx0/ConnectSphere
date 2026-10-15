"""Data shapes and validation for event equipment requests."""

from uuid import UUID

from pydantic import BaseModel, Field, model_validator


class EquipmentRequestItemSubmit(BaseModel):
    equipment_id: UUID
    quantity: int = Field(gt=0)


class EquipmentRequestSubmit(BaseModel):
    event_id: UUID
    items: list[EquipmentRequestItemSubmit] = Field(min_length=1)

    @model_validator(mode="after")
    def validate_unique_equipment(self) -> "EquipmentRequestSubmit":
        equipment_ids = [item.equipment_id for item in self.items]
        if len(equipment_ids) != len(set(equipment_ids)):
            raise ValueError("Each equipment item can only be listed once.")
        return self
