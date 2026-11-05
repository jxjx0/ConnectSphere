"""Submitting events and who can read them, on a real database."""

from integration_helpers import event_row, submit_event

import config


def test_submitted_event_and_its_session_are_saved(make_user, admin):
    organiser = make_user("organiser")

    event = submit_event(organiser)

    saved = event_row(admin, event.id)
    assert saved["organiser_id"] == organiser.id
    assert saved["status"] == "under_review"
    sessions = (
        admin.table("event_sessions").select("*").eq("event_id", event.id).execute().data
    )
    assert [session["name"] for session in sessions] == ["Main programme"]


def test_organiser_cannot_read_another_organisers_event(make_user):
    owner = make_user("organiser")
    other = make_user("organiser")
    event = submit_event(owner)

    # Queried directly because list_my_events also filters by organiser, and
    # would pass even if the row-level security rule were broken.
    client = config.get_user_client(other.token)
    assert client.table("events").select("id").eq("id", event.id).execute().data == []

    # The owner must still see it, or the check above would prove nothing.
    client = config.get_user_client(owner.token)
    assert client.table("events").select("id").eq("id", event.id).execute().data != []
