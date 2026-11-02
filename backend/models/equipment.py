from pydantic import BaseModel, Field, field_validator
from typing import Literal

class EquipmentCreate(BaseModel):
    name: str = Field(..., min_length=1, description="Name of the equipment")
    type: str = Field(
        ...,
        min_length=1,
        max_length=120,
        description="The kind of equipment this counts as, e.g. Projector",
    )
    maintenance_status: Literal['Functional', 'Under Repair', 'Decommissioned'] = Field(
        default='Functional', description="Maintenance status of the equipment"
    )

    @field_validator('type')
    @classmethod
    def strip_type(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("Enter the type of this equipment.")
        return stripped
