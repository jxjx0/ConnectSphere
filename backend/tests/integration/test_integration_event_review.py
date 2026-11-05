"""Coordinator decisions and organiser change requests, on a real database."""

from integration_helpers import move_event, event_row, session_row, session_times, submit_event

from models.event import EventChangeRequestSubmit, EventStatus
from services import event_service


def test_coordinator_approval_moves_the_event_to_planning(make_user, admin):
    coordinator = make_user("coordinator")
    event = submit_event(make_user("organiser"))
    move_event(admin, event.id, coordinator_id=coordinator.id)

    event_service.decide_assigned_event(
        coordinator.token, coordinator.id, event.id, EventStatus.PLANNING
    )

    assert event_row(admin, event.id)["status"] == "planning"


def test_organiser_can_read_their_proposed_change_sessions(make_user, admin):
    organiser = make_user("organiser")
    event = submit_event(organiser)
    session = session_row(admin, event.id)
    start, end = session_times()

    event_service.submit_event_change_request(
        organiser.token,
        organiser.id,
        event.id,
        EventChangeRequestSubmit(
            name="Integration Test Summit",
            description="A summit used by the integration tests.",
            reason_for_change="More people are coming.",
            purpose="Testing",
            category="conference",
            accessibility_requirements="Step-free access",
            sessions=[
                {
                    "session_id": session["id"],
                    "name": "Main programme",
                    "start_time": start,
                    "end_time": end,
                    "expected_attendance": 150,
                }
            ],
        ),
    )

    # Reads the nested proposal sessions with the organiser's own token.
    loaded = event_service.get_my_event(organiser.token, organiser.id, event.id)
    assert [item.expected_attendance for item in loaded.change_request.sessions] == [150]
