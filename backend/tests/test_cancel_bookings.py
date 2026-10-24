"""Tests for a Coordinator cancelling a venue booking or equipment request (T7-282).

The rules themselves (Planning only, before the session starts, live
statuses only) live in the database functions cancel_venue_booking and
cancel_equipment_request. These tests check that the routes and services
pass the request on, turn database errors into clear messages, and notify
the right staff.
"""

from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from postgrest import APIError as PostgrestAPIError

import config
from models.equipment_request import EquipmentRequestCancel
from models.profile import Profile, Role
from models.venue_booking import VenueBookingCancelRequest
from services import auth_service, equipment_request_service, venue_booking_service
from services.auth_service import AuthError

COORDINATOR = Profile(id="coord-1", full_name="Event Coordinator", role=Role.COORDINATOR)
VENUE_STAFF = Profile(id="staff-1", full_name="Venue Staff", role=Role.VENUE_STAFF)
HEADERS = {"Authorization": "Bearer coordinator-token"}

CANCELLED_BOOKING = {
    "booking_id": "booking-1",
    "event_id": "evt-1",
    "status": "CANCELLED",
    "cancellation_reason": "Session moved to the afternoon",
    "event_name": "Tech Summit",
    "session_name": "Breakout A",
    "venue_name": "Hall A",
}

CANCELLED_REQUEST = {
    "id": "request-1",
    "event_id": "evt-1",
    "status": "Cancelled",
    "cancellation_reason": "No longer needed",
    "event_name": "Tech Summit",
    "session_name": "Breakout A",
}


def authenticate_as(monkeypatch, profile):
    monkeypatch.setattr(auth_service, "get_user_id", lambda token: profile.id)
    monkeypatch.setattr(auth_service, "get_profile", lambda token, user_id: profile)


@pytest.fixture
def database(monkeypatch):
    """A user client whose rpc() returns `database.result`, or raises `database.error`."""
    client = Mock()
    database = SimpleNamespace(client=client, result=None, error=None)

    def execute():
        if database.error:
            raise database.error
        return SimpleNamespace(data=database.result)

    client.rpc.return_value.execute.side_effect = execute
    monkeypatch.setattr(config, "get_user_client", lambda token: client)
    return database


@pytest.fixture
def role_notifications(monkeypatch):
    sent = []

    def record(role, notification_type, title, body, event_id=None):
        sent.append({"role": role, "type": notification_type, "body": body, "event_id": event_id})

    monkeypatch.setattr(venue_booking_service, "notify_role", record)
    monkeypatch.setattr(equipment_request_service.notification_service, "notify_role", record)
    return sent


def database_error(code, message="database refused"):
    return PostgrestAPIError({"code": code, "message": message})


# --- Routes ----------------------------------------------------------------

def test_coordinator_can_cancel_a_venue_booking(client, monkeypatch):
    authenticate_as(monkeypatch, COORDINATOR)
    cancel = Mock(return_value=CANCELLED_BOOKING)
    monkeypatch.setattr(venue_booking_service, "cancel_venue_booking", cancel)

    response = client.patch(
        "/venues/bookings/booking-1/cancel",
        json={"reason": "  Session moved to the afternoon  "},
        headers=HEADERS,
    )

    assert response.status_code == 200
    assert response.get_json()["booking"] == CANCELLED_BOOKING
    assert cancel.call_args.kwargs["booking_id"] == "booking-1"
    assert cancel.call_args.kwargs["cancellation"].reason == "Session moved to the afternoon"


def test_only_coordinators_can_cancel_a_venue_booking(client, monkeypatch):
    authenticate_as(monkeypatch, VENUE_STAFF)
    cancel = Mock()
    monkeypatch.setattr(venue_booking_service, "cancel_venue_booking", cancel)

    response = client.patch("/venues/bookings/booking-1/cancel", json={"reason": "x"}, headers=HEADERS)

    assert response.status_code == 403
    cancel.assert_not_called()


@pytest.mark.parametrize("payload", [{}, {"reason": ""}, {"reason": "   "}])
def test_cancelling_a_venue_booking_needs_a_reason(client, monkeypatch, payload):
    authenticate_as(monkeypatch, COORDINATOR)

    response = client.patch("/venues/bookings/booking-1/cancel", json=payload, headers=HEADERS)

    assert response.status_code == 400


def test_coordinator_can_cancel_an_equipment_request(client, monkeypatch):
    authenticate_as(monkeypatch, COORDINATOR)
    cancel = Mock(return_value=CANCELLED_REQUEST)
    monkeypatch.setattr(equipment_request_service, "cancel_equipment_request", cancel)

    response = client.patch(
        "/equipment-requests/request-1/cancel",
        json={"reason": "No longer needed"},
        headers=HEADERS,
    )

    assert response.status_code == 200
    assert response.get_json()["request"] == CANCELLED_REQUEST
    assert cancel.call_args.args[1] == "request-1"
    assert cancel.call_args.args[2].reason == "No longer needed"


def test_only_coordinators_can_cancel_an_equipment_request(client, monkeypatch):
    authenticate_as(monkeypatch, VENUE_STAFF)
    cancel = Mock()
    monkeypatch.setattr(equipment_request_service, "cancel_equipment_request", cancel)

    response = client.patch("/equipment-requests/request-1/cancel", json={"reason": "x"}, headers=HEADERS)

    assert response.status_code == 403
    cancel.assert_not_called()


def test_cancelling_an_equipment_request_needs_a_reason(client, monkeypatch):
    authenticate_as(monkeypatch, COORDINATOR)

    response = client.patch("/equipment-requests/request-1/cancel", json={"reason": " "}, headers=HEADERS)

    assert response.status_code == 400


# --- Venue booking service --------------------------------------------------

def test_venue_cancel_calls_the_database_function(database, role_notifications):
    database.result = CANCELLED_BOOKING

    result = venue_booking_service.cancel_venue_booking(
        "token", "booking-1", VenueBookingCancelRequest(reason="Session moved to the afternoon"),
    )

    database.client.rpc.assert_called_once_with(
        "cancel_venue_booking",
        {"p_booking_id": "booking-1", "p_reason": "Session moved to the afternoon"},
    )
    assert result == CANCELLED_BOOKING


def test_venue_staff_are_told_about_the_cancelled_booking(database, role_notifications):
    database.result = CANCELLED_BOOKING

    venue_booking_service.cancel_venue_booking("token", "booking-1", VenueBookingCancelRequest(reason="x"))

    (notification,) = role_notifications
    assert notification["role"] == "venue_staff"
    assert notification["type"] == "venue_booking_cancelled"
    assert notification["event_id"] == "evt-1"
    for detail in ("Hall A", "Tech Summit", "Breakout A", "Session moved to the afternoon"):
        assert detail in notification["body"]


@pytest.mark.parametrize("code,status", [
    ("42501", 403),
    ("P0002", 404),
    ("22023", 400),
    ("P0001", 409),
    ("XX000", 502),
])
def test_venue_cancel_database_errors_are_explained(database, role_notifications, code, status):
    database.error = database_error(code, "Bookings can only be cancelled while the event is in Planning.")

    with pytest.raises(AuthError) as caught:
        venue_booking_service.cancel_venue_booking("token", "booking-1", VenueBookingCancelRequest(reason="x"))

    assert caught.value.status_code == status
    assert role_notifications == []


def test_venue_cancel_shows_the_database_reason_when_refused(database):
    database.error = database_error("P0001", "Bookings can only be cancelled while the event is in Planning.")

    with pytest.raises(AuthError) as caught:
        venue_booking_service.cancel_venue_booking("token", "booking-1", VenueBookingCancelRequest(reason="x"))

    assert "while the event is in Planning" in caught.value.message


# --- Equipment request service ----------------------------------------------

def test_equipment_cancel_calls_the_database_function(database, role_notifications):
    database.result = CANCELLED_REQUEST

    result = equipment_request_service.cancel_equipment_request(
        "token", "request-1", EquipmentRequestCancel(reason="No longer needed"),
    )

    database.client.rpc.assert_called_once_with(
        "cancel_equipment_request",
        {"p_request_id": "request-1", "p_reason": "No longer needed"},
    )
    assert result == CANCELLED_REQUEST


def test_technical_support_is_told_about_the_cancelled_request(database, role_notifications):
    database.result = CANCELLED_REQUEST

    equipment_request_service.cancel_equipment_request("token", "request-1", EquipmentRequestCancel(reason="x"))

    (notification,) = role_notifications
    assert notification["role"] == "tech_support"
    assert notification["type"] == "equipment_request_cancelled"
    assert notification["event_id"] == "evt-1"
    for detail in ("Tech Summit", "Breakout A", "released", "No longer needed"):
        assert detail in notification["body"]


@pytest.mark.parametrize("code,status", [
    ("42501", 403),
    ("P0002", 404),
    ("22023", 400),
    ("P0001", 409),
    ("XX000", 502),
])
def test_equipment_cancel_database_errors_are_explained(database, role_notifications, code, status):
    database.error = database_error(code)

    with pytest.raises(AuthError) as caught:
        equipment_request_service.cancel_equipment_request("token", "request-1", EquipmentRequestCancel(reason="x"))

    assert caught.value.status_code == status
    assert role_notifications == []


def test_an_unexpected_cancel_result_is_reported(database, role_notifications):
    database.result = {"id": "request-1", "status": "Approved"}

    with pytest.raises(AuthError) as caught:
        equipment_request_service.cancel_equipment_request("token", "request-1", EquipmentRequestCancel(reason="x"))

    assert caught.value.status_code == 502
    assert role_notifications == []
