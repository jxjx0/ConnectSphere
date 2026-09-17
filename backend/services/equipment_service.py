from config import get_client
from models.equipment import EquipmentCreate
from datetime import datetime

def create_equipment(equipment_data: EquipmentCreate):
    supabase = get_client()

    # Insert the equipment into the Supabase table
    response = supabase.from_("equipment").insert({
        "name": equipment_data.name,
        "type": equipment_data.type,
        "maintenance_status": equipment_data.maintenance_status,
        "created_at": datetime.utcnow().isoformat()
    }).execute()

    if response.error:
        raise Exception(f"Failed to create equipment: {response.error.message}")

    # Return the created equipment object
    return response.data[0]