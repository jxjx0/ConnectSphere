"""Booking HTTP validation, role boundaries and service argument wiring."""

from unittest.mock import Mock

import pytest

from models.profile import Profile, Role
from services import venue_booking_service as bookings
from services.auth_service import AuthError
from test_events import authenticate_as


HEADERS = {"Authorization": "Bearer caller-token"}
BOOKING = {
    "event_id": "event-1", "session_id": "session-1", "room_layout": "  Theatre  ",
    "start_at": "2099-11-07T10:00:00+08:00", "end_at": "2099-11-07T12:00:00+08:00",
}


@pytest.fixture
def booking_services(monkeypatch):
    create = Mock(return_value={"booking_id": "booking-1", "status": "PENDING_VENUE_APPROVAL"})
    review = Mock(return_value={"booking_id": "booking-1", "status": "APPROVED"})
    monkeypatch.setattr(bookings, "create_venue_booking", create)
    monkeypatch.setattr(bookings, "review_venue_booking", review)
    return create, review


@pytest.mark.parametrize("operation,allowed_role", [("create", Role.COORDINATOR), ("review", Role.VENUE_STAFF)])
@pytest.mark.parametrize("role", list(Role))
def test_booking_endpoints_require_the_correct_role(client, monkeypatch, booking_services, operation, allowed_role, role):
    authenticate_as(monkeypatch, Profile(id="caller", full_name="Caller", role=role))
    create, review = booking_services
    if operation == "create":
        response = client.post("/venues/venue-1/bookings", json=BOOKING, headers=HEADERS)
        service = create
    else:
        response = client.patch("/venues/bookings/booking-1/review", json={"status": "APPROVED"}, headers=HEADERS)
        service = review
    assert response.status_code == ((201 if operation == "create" else 200) if role == allowed_role else 403)
    assert service.call_count == int(role == allowed_role)
    if role == allowed_role:
        assert response.get_json()["booking"] == service.return_value
        assert service.call_args.kwargs["access_token"] == "caller-token"
        if operation == "create":
            arguments = service.call_args.kwargs
            assert arguments["venue_id"] == "venue-1"
            assert arguments["coordinator_id"] == "caller"
            assert arguments["request"].session_id == "session-1"
            assert arguments["request"].room_layout == "Theatre"
            assert arguments["request"].start_at.isoformat() == "2099-11-07T02:00:00+00:00"
        else:
            assert service.call_args.kwargs["booking_id"] == "booking-1"
            assert service.call_args.kwargs["reviewer_id"] == "caller"
            assert service.call_args.kwargs["review"].status == "APPROVED"


@pytest.mark.parametrize("operation", ["create", "review"])
@pytest.mark.parametrize("payload", [None, [], "invalid", {}, {"status": "REJECTED"}])
def test_invalid_booking_payload_does_not_reach_services(client, monkeypatch, booking_services, operation, payload):
    role = Role.COORDINATOR if operation == "create" else Role.VENUE_STAFF
    authenticate_as(monkeypatch, Profile(id="caller", full_name="Caller", role=role))
    if operation == "create":
        response = client.post("/venues/venue-1/bookings", json=payload, headers=HEADERS)
    else:
        response = client.patch("/venues/bookings/booking-1/review", json=payload, headers=HEADERS)
    assert response.status_code == 400
    assert response.get_json()["errors"]
    for service in booking_services:
        service.assert_not_called()


@pytest.mark.parametrize("change,message", [
    ({"start_at": "2099-11-07T10:00:00"}, "timezone"),
    ({"room_layout": "  "}, "layout must not be blank"),
    ({"end_at": BOOKING["start_at"]}, "end time must be after start"),
    ({"session_id": None}, "choose which session"),
])
def test_booking_invalid_times_layout_and_session_return_validation_messages(client, monkeypatch, booking_services, change, message):
    authenticate_as(monkeypatch, Profile(id="caller", full_name="Caller", role=Role.COORDINATOR))
    response = client.post("/venues/venue-1/bookings", json={**BOOKING, **change}, headers=HEADERS)
    assert response.status_code == 400
    assert any(message in error for error in response.get_json()["errors"])
    booking_services[0].assert_not_called()


def test_rejection_passes_its_reason_and_reviewer_to_service(client, monkeypatch, booking_services):
    authenticate_as(monkeypatch, Profile(id="staff", full_name="Staff", role=Role.VENUE_STAFF))
    booking_services[1].return_value = {"booking_id": "booking-1", "status": "REJECTED"}
    response = client.patch("/venues/bookings/booking-1/review", json={
        "status": "REJECTED", "rejection_reason": "Venue is being repaired",
    }, headers=HEADERS)
    assert response.status_code == 200
    assert response.get_json()["booking"]["status"] == "REJECTED"
    assert booking_services[1].call_args.kwargs["review"].rejection_reason == "Venue is being repaired"
    assert booking_services[1].call_args.kwargs["reviewer_id"] == "staff"


@pytest.mark.parametrize("operation", ["create", "review"])
def test_booking_endpoints_reject_missing_token_before_service_call(client, booking_services, operation):
    response = (client.post("/venues/venue-1/bookings", json=BOOKING) if operation == "create" else
                client.patch("/venues/bookings/booking-1/review", json={"status": "APPROVED"}))
    assert response.status_code == 401
    for service in booking_services:
        service.assert_not_called()


@pytest.mark.parametrize("operation", ["create", "review"])
@pytest.mark.parametrize("status", [403, 404, 409, 502])
def test_booking_service_errors_reach_caller_without_success_response(client, monkeypatch, booking_services, operation, status):
    role = Role.COORDINATOR if operation == "create" else Role.VENUE_STAFF
    authenticate_as(monkeypatch, Profile(id="caller", full_name="Caller", role=role))
    service = booking_services[0 if operation == "create" else 1]
    service.side_effect = AuthError("Booking could not be saved", status_code=status)
    response = (client.post("/venues/venue-1/bookings", json=BOOKING, headers=HEADERS) if operation == "create" else
                client.patch("/venues/bookings/booking-1/review", json={"status": "APPROVED"}, headers=HEADERS))
    assert response.status_code == status
    assert response.get_json() == {"error": "Booking could not be saved"}


@pytest.mark.parametrize("payload", [None, [], "invalid"])
def test_cancellation_requires_a_json_object(client, monkeypatch, payload):
    authenticate_as(monkeypatch, Profile(id="caller", full_name="Caller", role=Role.COORDINATOR))
    cancel = Mock()
    monkeypatch.setattr(bookings, "cancel_venue_booking", cancel)
    response = client.patch("/venues/bookings/booking-1/cancel", json=payload, headers=HEADERS)
    assert response.status_code == 400
    assert response.get_json() == {"errors": ["Cancellation must be a JSON object."]}
    cancel.assert_not_called()
