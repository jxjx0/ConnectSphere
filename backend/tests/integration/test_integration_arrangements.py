"""Venue, equipment and safety workflows, on a real database."""

from integration_helpers import create_venue, event_row, move_event, session_row, submit_event

from models.equipment_request import EquipmentRequestReview, EquipmentRequestSubmit
from models.venue_booking import VenueBookingCreateRequest, VenueBookingReviewRequest
from services import equipment_request_service, safety_review_service, venue_booking_service


def _planning_event(make_user, admin):
    coordinator = make_user("coordinator")
    event = submit_event(make_user("organiser"))
    move_event(admin, event.id, coordinator_id=coordinator.id, status="planning")
    return event, coordinator


def test_venue_staff_approval_saves_the_booking_and_blocks_the_calendar(make_user, admin):
    event, coordinator = _planning_event(make_user, admin)
    staff = make_user("venue_staff")
    venue = create_venue(admin)
    session = session_row(admin, event.id)

    booking = venue_booking_service.create_venue_booking(
        coordinator.token,
        venue["id"],
        VenueBookingCreateRequest(
            event_id=event.id,
            session_id=session["id"],
            room_layout="Theatre",
            start_at=session["start_time"],
            end_at=session["end_time"],
        ),
        coordinator.id,
    )

    venue_booking_service.review_venue_booking(
        staff.token,
        booking["booking_id"],
        staff.id,
        VenueBookingReviewRequest(status="APPROVED"),
    )

    saved = (
        admin.table("venue_bookings")
        .select("*")
        .eq("booking_id", booking["booking_id"])
        .execute()
        .data[0]
    )
    assert saved["status"] == "APPROVED"
    assert saved["reviewed_by"] == staff.id
    blocks = (
        admin.table("venue_blocks")
        .select("*")
        .eq("booking_id", booking["booking_id"])
        .execute()
        .data
    )
    assert len(blocks) == 1


def test_tech_support_rejection_saves_the_reason_and_request_lines(make_user, admin):
    event, coordinator = _planning_event(make_user, admin)
    tech_support = make_user("tech_support")
    session = session_row(admin, event.id)

    request = equipment_request_service.submit_equipment_request(
        coordinator.token,
        coordinator.id,
        EquipmentRequestSubmit(
            event_id=event.id,
            session_id=session["id"],
            lines=[{"item_name": "Projector", "quantity": 2}],
        ),
    )

    equipment_request_service.review_equipment_request(
        tech_support.token,
        request["id"],
        EquipmentRequestReview(decision="Rejected", rejection_reason="None available"),
    )

    saved = admin.table("equipment_requests").select("*").eq("id", request["id"]).execute().data[0]
    assert saved["status"] == "Rejected"
    assert saved["rejection_reason"] == "None available"
    lines = (
        admin.table("equipment_request_lines")
        .select("*")
        .eq("request_id", request["id"])
        .execute()
        .data
    )
    assert [(line["item_name"], line["quantity"]) for line in lines] == [("Projector", 2)]


def test_safety_approval_saves_the_decision_and_confirms_the_event(make_user, admin):
    event, _ = _planning_event(make_user, admin)
    officer = make_user("safety_officer")
    move_event(admin, event.id, status="awaiting_safety_check")

    safety_review_service.submit_safety_decision(
        event.id, officer.id, "approved", "Looks safe", access_token=officer.token
    )

    assert event_row(admin, event.id)["status"] == "confirmed"
    reviews = (
        admin.table("event_safety_reviews").select("*").eq("event_id", event.id).execute().data
    )
    assert [(review["decision"], review["safety_officer_id"]) for review in reviews] == [
        ("APPROVED", officer.id)
    ]
