from postgrest import APIError as PostgrestAPIError
from services.auth_service import AuthError
import config

def get_lead_coordinator_events(access_token: str):
    supabase = config.get_admin_client()
    try:
        response = (
            supabase.from_("events")
            .select("""
                id,
                name,
                start_time,
                end_time,
                status,
                expected_attendance,
                equipment_requirements,
                coordinator_id,
                coordinator:profiles!coordinator_id (
                    id,
                    full_name
                ),
                sessions:event_sessions (
                    id
                ),
                venue_bookings (
                    venue_id,
                    venue:venues (
                        id,
                        name,
                        location
                    )
                )
            """)
            .not_.in_("status", ["completed", "rejected", "draft"])
            .order("start_time", desc=False)
            .execute()
        )
    except PostgrestAPIError as error:
        raise AuthError(f"Database error: {error.message}", status_code=400) from error

    return response.data or []