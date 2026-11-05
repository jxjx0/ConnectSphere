"""Shared test data for the integration tests."""

from datetime import datetime, timedelta, timezone
from uuid import uuid4

from models.event import EventSubmitRequest
from services import event_service

SINGAPORE = timezone(timedelta(hours=8))


def session_times():
    """10:00 to 12:00 Singapore time, 30 days from now, inside venue opening hours."""
    day = datetime.now(SINGAPORE) + timedelta(days=30)
    start = day.replace(hour=10, minute=0, second=0, microsecond=0)
    return start, start + timedelta(hours=2)


def event_request():
    start, end = session_times()
    return EventSubmitRequest(
        name="Integration Test Summit",
        description="A summit used by the integration tests.",
        purpose="Testing",
        category="conference",
        accessibility_requirements="Step-free access",
        sessions=[
            {
                "name": "Main programme",
                "start_time": start.isoformat(),
                "end_time": end.isoformat(),
                "expected_attendance": 120,
                "location_preference": "Central",
                "layout_preference": "Theatre",
                "equipment_requirements": "Two projectors",
            }
        ],
    )


def submit_event(organiser):
    """Create an event through the real service, as an organiser would."""
    return event_service.submit_event(organiser.token, organiser.id, event_request())


def move_event(admin, event_id, **fields):
    """Put an event in the state a test starts from, such as assigned or confirmed."""
    admin.table("events").update(fields).eq("id", event_id).execute()


def event_row(admin, event_id):
    return admin.table("events").select("*").eq("id", event_id).execute().data[0]


def session_row(admin, event_id):
    return (
        admin.table("event_sessions").select("*").eq("event_id", event_id).execute().data[0]
    )


def create_venue(admin):
    """A venue that fits the test session, with a unique name."""
    return (
        admin.table("venues")
        .insert(
            {
                "name": f"Test Venue {uuid4().hex}",
                "location": "1 Test Road",
                "capacity": 200,
                "layouts": [{"name": "Theatre", "capacity": 200}],
                "operating_hours": {"open": "08:00", "close": "20:00"},
                "setup_time_minutes": 15,
                "turnaround_time_minutes": 15,
            }
        )
        .execute()
        .data[0]
    )
