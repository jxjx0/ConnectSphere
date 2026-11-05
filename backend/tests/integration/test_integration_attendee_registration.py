"""Attendee registration, on a real database."""

from datetime import datetime, timedelta, timezone

from integration_helpers import move_event, submit_event

from models.attendee_registration import AttendeeRegistrationSubmit
from services import attendee_registration_service


def test_attendee_registration_is_saved_with_their_account_email(make_user, admin):
    attendee = make_user("attendee")
    event = submit_event(make_user("organiser"))
    now = datetime.now(timezone.utc)
    move_event(
        admin,
        event.id,
        status="confirmed",
        attendee_capacity=100,
        registration_opens_at=(now - timedelta(days=1)).isoformat(),
        registration_closes_at=(now + timedelta(days=10)).isoformat(),
        published_at=now.isoformat(),
    )

    attendee_registration_service.register_for_event(
        attendee.token,
        event.id,
        AttendeeRegistrationSubmit(full_name="Test Attendee"),
    )

    rows = (
        admin.table("event_registrations").select("*").eq("event_id", event.id).execute().data
    )
    assert [(row["attendee_id"], row["email"]) for row in rows] == [
        (attendee.id, attendee.email)
    ]
