from postgrest import APIError as PostgrestAPIError

import config
from models.equipment import EquipmentCreate
from datetime import datetime
from services.auth_service import AuthError


def create_equipment(access_token: str, equipment_data: EquipmentCreate):
    # Uses the logged-in user's token for Row-Level Security (RLS)
    supabase = config.get_user_client(access_token)
    try:
        response = supabase.from_("equipment").insert({
            "name": equipment_data.name,
            "type": equipment_data.type,
            "maintenance_status": equipment_data.maintenance_status,
            "created_at": datetime.utcnow().isoformat()
        }).execute()

    except PostgrestAPIError as error:
        raise AuthError(f"Database error: {error.message}", status_code=400) from error

    if not response.data:
        raise AuthError("Failed to create equipment.", status_code=502)

    return response.data[0]

def get_all_equipment(access_token: str):
    supabase = config. get_user_client(access_token)
    response = supabase.table('equipment').select('*').execute()
    return response.data

def update_equipment(equipment_id, data, access_token=None):
    supabase = config.get_user_client(access_token=access_token)
    response = (
        supabase.table('equipment')
        .update(data)
        .eq('id', equipment_id)
        .execute()
    )
    return response.data