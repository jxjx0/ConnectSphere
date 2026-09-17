from pydantic import BaseModel, Field
from typing import Literal

class EquipmentCreate(BaseModel):
    name: str = Field(..., min_length=1, description="Name of the equipment")
    type: Literal['Audio', 'Visual', 'Staging'] = Field(..., description="Type of the equipment")
    maintenance_status: Literal['Functional', 'Under Repair', 'Decommissioned'] = Field(
        default='Functional', description="Maintenance status of the equipment"
    )