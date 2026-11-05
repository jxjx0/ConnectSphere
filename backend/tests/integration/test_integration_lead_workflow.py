"""The Lead Coordinator's views and assignment, on a real database."""

from integration_helpers import event_row, move_event, submit_event

from models.event import Event
from services import (
    auth_service,
    event_assignment_service,
    overview_coordinator_events_service,
)


def test_lead_can_load_coordinators_for_the_dropdown(make_user):
    lead = make_user("event_coordinator_lead")
    coordinator = make_user("coordinator")
    organiser = make_user("organiser")

    # Uses the Lead's own token, so row-level security decides what comes back.
    ids = [row["id"] for row in auth_service.get_coordinators(lead.token)]

    assert coordinator.id in ids
    assert organiser.id not in ids


def test_lead_overview_query_works_on_the_real_tables(make_user, admin):
    lead = make_user("event_coordinator_lead")
    coordinator = make_user("coordinator")
    event = submit_event(make_user("organiser"))
    move_event(admin, event.id, coordinator_id=coordinator.id, status="planning")

    rows = overview_coordinator_events_service.get_lead_coordinator_events(lead.token)

    overview = {row["id"]: row for row in Event.format_lead_overview(rows)}
    assert overview[event.id]["coordinator_name"] == "Test coordinator"
    assert len(overview[event.id]["sessions"]) == 1


def test_assignment_saves_the_coordinator_and_the_audit_log(make_user, admin):
    lead = make_user("event_coordinator_lead")
    coordinator = make_user("coordinator")
    event = submit_event(make_user("organiser"))

    event_assignment_service.assign_or_reassign_event(event.id, coordinator.id, lead.id)

    assert event_row(admin, event.id)["coordinator_id"] == coordinator.id
    logs = (
        admin.table("event_activity_logs").select("*").eq("event_id", event.id).execute().data
    )
    assert len(logs) == 1
    assert logs[0]["action_type"] == "ASSIGNMENT"
    assert logs[0]["new_coordinator_id"] == coordinator.id
    assert logs[0]["changed_by_id"] == lead.id
