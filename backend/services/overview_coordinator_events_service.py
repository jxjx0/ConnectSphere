from postgrest import APIError as PostgrestAPIError
from httpx import HTTPError
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
                clarifications:event_clarifications (
                    status
                ),
                change_requests:event_change_requests (
                    status
                ),
                cancellation_requests:event_cancellation_requests (
                    status
                ),
                venue_bookings (
                    status,
                    venue:venues (
                        name
                    ),
                    session:event_sessions (
                        name,
                        start_time
                    )
                )
            """)
            .not_.in_("status", ["completed", "rejected", "draft"])
            .order("start_time", desc=False)
            .execute()
        )
    except PostgrestAPIError as error:
        if error.code in {"42501", "PGRST301"}:
            raise AuthError("You do not have permission to view the Lead overview.", status_code=403) from error
        raise AuthError("Unable to load the Lead overview. Please try again.", status_code=502) from error
    except HTTPError as error:
        raise AuthError("Unable to load the Lead overview. Please try again.", status_code=502) from error

    return response.data or []
