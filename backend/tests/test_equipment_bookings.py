"""Tests for Technical Support equipment time bookings."""

from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from postgrest import APIError as PostgrestAPIError

import config
from models.equipment_booking import (
    EquipmentBookingCalendarRange,
    EquipmentBookingCreate,
    EquipmentBookingRange,
)
from models.profile import Profile, Role
from services import auth_service, equipment_booking_service
from services.auth_service import AuthError


TECH_SUPPORT = Profile(
    id="22222222-2222-2222-2222-222222222222",
    full_name="Technical Support",
    role=Role.TECH_SUPPORT,
)

COORDINATOR = Profile(
    id="11111111-1111-1111-1111-111111111111",
    full_name="Event Coordinator",
    role=Role.COORDINATOR,
)

EQUIPMENT_ID = "44444444-4444-4444-4444-444444444444"
REQUEST_ID = "55555555-5555-5555-5555-555555555555"
BOOKING_ID = "77777777-7777-7777-7777-777777777777"

VALID_BOOKING = {
    "equipment_id": EQUIPMENT_ID,
    "request_id": REQUEST_ID,
    "start_at": "2026-10-23T02:00:00+00:00",
    "end_at": "2026-10-23T04:00:00+00:00",
}

SAVED_BOOKING = {"id": BOOKING_ID, **VALID_BOOKING}

RANGE_QUERY = {
    "equipment_id": EQUIPMENT_ID,
    "from": "2026-10-01T00:00:00+08:00",
    "to": "2026-11-01T00:00:00+08:00",
}

CALENDAR_RANGE_QUERY = {
    "from": RANGE_QUERY["from"],
    "to": RANGE_QUERY["to"],
}


def authenticate_as(monkeypatch, profile):
    monkeypatch.setattr(auth_service, "get_user_id", lambda token: profile.id)
    monkeypatch.setattr(
        auth_service, "get_profile", lambda token, user_id: profile
    )


@pytest.fixture
def booking_database(monkeypatch):
    client = Mock()
    client_factory = Mock(return_value=client)
    monkeypatch.setattr(config, "get_user_client", client_factory)
    return client, client_factory


def table_query(data=None, error=None):
    query = Mock()
    for method in ("insert", "delete", "eq"):
        getattr(query, method).return_value = query
    if error:
        query.execute.side_effect = error
    else:
        query.execute.return_value = SimpleNamespace(data=data)
    return query


def test_technical_support_can_list_item_bookings(client, monkeypatch):
    authenticate_as(monkeypatch, TECH_SUPPORT)
    list_bookings = Mock(return_value=[SAVED_BOOKING])
    monkeypatch.setattr(
        equipment_booking_service, "list_equipment_bookings", list_bookings
    )

    response = client.get(
        "/equipment-bookings",
        query_string=RANGE_QUERY,
        headers={"Authorization": "Bearer tech-token"},
    )

    assert response.status_code == 200
    assert response.get_json()["bookings"] == [SAVED_BOOKING]
    assert list_bookings.call_args.args[0] == "tech-token"
    assert str(list_bookings.call_args.args[1].equipment_id) == EQUIPMENT_ID


def test_technical_support_can_list_shared_calendar(client, monkeypatch):
    authenticate_as(monkeypatch, TECH_SUPPORT)
    list_bookings = Mock(return_value=[SAVED_BOOKING])
    monkeypatch.setattr(
        equipment_booking_service, "list_all_equipment_bookings", list_bookings
    )

    response = client.get(
        "/equipment-bookings/calendar",
        query_string=CALENDAR_RANGE_QUERY,
        headers={"Authorization": "Bearer tech-token"},
    )

    assert response.status_code == 200
    assert response.get_json()["bookings"] == [SAVED_BOOKING]
    assert list_bookings.call_args.args[0] == "tech-token"
    assert isinstance(
        list_bookings.call_args.args[1], EquipmentBookingCalendarRange
    )


def test_shared_calendar_rejects_invalid_range(client, monkeypatch):
    authenticate_as(monkeypatch, TECH_SUPPORT)
    list_bookings = Mock(side_effect=AssertionError("must not reach the service"))
    monkeypatch.setattr(
        equipment_booking_service, "list_all_equipment_bookings", list_bookings
    )

    response = client.get(
        "/equipment-bookings/calendar",
        query_string={"from": RANGE_QUERY["from"], "to": RANGE_QUERY["from"]},
        headers={"Authorization": "Bearer tech-token"},
    )

    assert response.status_code == 400
    list_bookings.assert_not_called()


@pytest.mark.parametrize(
    "query",
    [
        {**RANGE_QUERY, "equipment_id": "not-a-uuid"},
        {**RANGE_QUERY, "from": "2026-10-01T00:00:00"},
        {**RANGE_QUERY, "to": RANGE_QUERY["from"]},
        {"equipment_id": EQUIPMENT_ID},
    ],
    ids=["bad-id", "naive-time", "empty-range", "missing-range"],
)
def test_listing_bookings_rejects_invalid_range(client, monkeypatch, query):
    authenticate_as(monkeypatch, TECH_SUPPORT)
    list_bookings = Mock(side_effect=AssertionError("must not reach the service"))
    monkeypatch.setattr(
        equipment_booking_service, "list_equipment_bookings", list_bookings
    )

    response = client.get(
        "/equipment-bookings",
        query_string=query,
        headers={"Authorization": "Bearer tech-token"},
    )

    assert response.status_code == 400
    list_bookings.assert_not_called()


def test_technical_support_can_book_equipment(client, monkeypatch):
    authenticate_as(monkeypatch, TECH_SUPPORT)
    create_booking = Mock(return_value=SAVED_BOOKING)
    monkeypatch.setattr(
        equipment_booking_service, "create_equipment_booking", create_booking
    )

    response = client.post(
        "/equipment-bookings",
        json=VALID_BOOKING,
        headers={"Authorization": "Bearer tech-token"},
    )

    assert response.status_code == 201
    assert response.get_json()["booking"] == SAVED_BOOKING
    assert create_booking.call_args.args[1] == EquipmentBookingCreate(**VALID_BOOKING)


@pytest.mark.parametrize(
    "payload",
    [
        {**VALID_BOOKING, "end_at": VALID_BOOKING["start_at"]},
        {**VALID_BOOKING, "start_at": "2026-10-23T02:00:00"},
        {key: value for key, value in VALID_BOOKING.items() if key != "request_id"},
        ["not", "an", "object"],
    ],
    ids=["end-not-after-start", "naive-time", "missing-request", "not-object"],
)
def test_booking_rejects_invalid_payload(client, monkeypatch, payload):
    authenticate_as(monkeypatch, TECH_SUPPORT)
    create_booking = Mock(side_effect=AssertionError("must not reach the service"))
    monkeypatch.setattr(
        equipment_booking_service, "create_equipment_booking", create_booking
    )

    response = client.post(
        "/equipment-bookings",
        json=payload,
        headers={"Authorization": "Bearer tech-token"},
    )

    assert response.status_code == 400
    create_booking.assert_not_called()


def test_technical_support_can_remove_booking(client, monkeypatch):
    authenticate_as(monkeypatch, TECH_SUPPORT)
    delete_booking = Mock()
    monkeypatch.setattr(
        equipment_booking_service, "delete_equipment_booking", delete_booking
    )

    response = client.delete(
        f"/equipment-bookings/{BOOKING_ID}",
        headers={"Authorization": "Bearer tech-token"},
    )

    assert response.status_code == 204
    delete_booking.assert_called_once_with("tech-token", BOOKING_ID)


@pytest.mark.parametrize(
    "method,path,kwargs",
    [
        ("get", "/equipment-bookings", {"query_string": RANGE_QUERY}),
        (
            "get",
            "/equipment-bookings/calendar",
            {"query_string": CALENDAR_RANGE_QUERY},
        ),
        ("post", "/equipment-bookings", {"json": VALID_BOOKING}),
        ("delete", f"/equipment-bookings/{BOOKING_ID}", {}),
    ],
    ids=["list", "shared-calendar", "create", "delete"],
)
def test_non_technical_support_cannot_manage_bookings(
    client, monkeypatch, method, path, kwargs
):
    authenticate_as(monkeypatch, COORDINATOR)
    for name in (
        "list_equipment_bookings",
        "list_all_equipment_bookings",
        "create_equipment_booking",
        "delete_equipment_booking",
    ):
        monkeypatch.setattr(
            equipment_booking_service,
            name,
            Mock(side_effect=AssertionError("must not reach the service")),
        )

    response = getattr(client, method)(
        path, headers={"Authorization": "Bearer coordinator-token"}, **kwargs
    )

    assert response.status_code == 403


def test_service_lists_bookings_through_rpc(booking_database):
    client, client_factory = booking_database
    rpc_query = Mock()
    rpc_query.execute.return_value = SimpleNamespace(data=[SAVED_BOOKING])
    client.rpc.return_value = rpc_query
    booking_range = EquipmentBookingRange(
        equipment_id=EQUIPMENT_ID,
        start=RANGE_QUERY["from"],
        end=RANGE_QUERY["to"],
    )

    result = equipment_booking_service.list_equipment_bookings(
        "tech-token", booking_range
    )

    client_factory.assert_called_once_with("tech-token")
    client.rpc.assert_called_once_with(
        "list_equipment_bookings",
        {
            "p_equipment_id": EQUIPMENT_ID,
            "p_from": "2026-10-01T00:00:00+08:00",
            "p_to": "2026-11-01T00:00:00+08:00",
        },
    )
    assert result == [SAVED_BOOKING]


def test_service_lists_shared_bookings_through_rpc(booking_database):
    client, client_factory = booking_database
    rpc_query = Mock()
    rpc_query.execute.return_value = SimpleNamespace(data=[SAVED_BOOKING])
    client.rpc.return_value = rpc_query
    booking_range = EquipmentBookingCalendarRange(
        start=CALENDAR_RANGE_QUERY["from"],
        end=CALENDAR_RANGE_QUERY["to"],
    )

    result = equipment_booking_service.list_all_equipment_bookings(
        "tech-token", booking_range
    )

    client_factory.assert_called_once_with("tech-token")
    client.rpc.assert_called_once_with(
        "list_all_equipment_bookings",
        {
            "p_from": "2026-10-01T00:00:00+08:00",
            "p_to": "2026-11-01T00:00:00+08:00",
        },
    )
    assert result == [SAVED_BOOKING]


def test_service_creates_booking_through_guarded_rpc(booking_database):
    client, _ = booking_database
    query = Mock()
    query.execute.return_value = SimpleNamespace(
        data={"outcome": "booked", "booking": SAVED_BOOKING}
    )
    client.rpc.return_value = query

    result = equipment_booking_service.create_equipment_booking(
        "tech-token", EquipmentBookingCreate(**VALID_BOOKING)
    )

    client.rpc.assert_called_once_with(
        "create_equipment_booking",
        {
            "p_equipment_id": EQUIPMENT_ID,
            "p_request_id": REQUEST_ID,
            "p_start_at": "2026-10-23T02:00:00+00:00",
            "p_end_at": "2026-10-23T04:00:00+00:00",
        },
    )
    assert result == SAVED_BOOKING


def test_service_notifies_coordinator_when_equipment_is_unavailable(
    booking_database, monkeypatch
):
    client, _ = booking_database
    coordinator_id = "11111111-1111-1111-1111-111111111111"
    event_id = "33333333-3333-3333-3333-333333333333"
    query = Mock()
    query.execute.return_value = SimpleNamespace(
        data={
            "outcome": "unavailable",
            "reason": "overlap",
            "coordinator_id": coordinator_id,
            "event_id": event_id,
            "event_name": "Planning Summit",
            "equipment_name": "Projector",
        }
    )
    client.rpc.return_value = query
    notify = Mock(return_value={"id": "notification-id"})
    monkeypatch.setattr(
        equipment_booking_service.notification_service, "notify", notify
    )

    with pytest.raises(AuthError) as caught:
        equipment_booking_service.create_equipment_booking(
            "tech-token", EquipmentBookingCreate(**VALID_BOOKING)
        )

    assert caught.value.status_code == 409
    assert caught.value.message == (
        "This equipment is already booked during Planning Summit's scheduled time. "
        "The Coordinator has been notified."
    )
    notify.assert_called_once_with(
        user_id=coordinator_id,
        notification_type="equipment_requirement_unavailable",
        title="Equipment is unavailable",
        body=(
            "Projector is already booked during Planning Summit's "
            "scheduled time. Please contact Technical Support about alternatives."
        ),
        event_id=event_id,
    )


def test_service_notifies_coordinator_when_equipment_is_not_functional(
    booking_database, monkeypatch
):
    client, _ = booking_database
    query = Mock()
    query.execute.return_value = SimpleNamespace(
        data={
            "outcome": "unavailable",
            "reason": "maintenance",
            "equipment_status": "Under Maintenance",
            "coordinator_id": "11111111-1111-1111-1111-111111111111",
            "event_id": "33333333-3333-3333-3333-333333333333",
            "event_name": "Planning Summit",
            "equipment_name": "Projector",
        }
    )
    client.rpc.return_value = query
    notify = Mock(return_value={"id": "notification-id"})
    monkeypatch.setattr(
        equipment_booking_service.notification_service, "notify", notify
    )

    with pytest.raises(AuthError) as caught:
        equipment_booking_service.create_equipment_booking(
            "tech-token", EquipmentBookingCreate(**VALID_BOOKING)
        )

    assert caught.value.status_code == 409
    assert caught.value.message == (
        "Projector is unavailable because it is Under Maintenance. "
        "The Coordinator has been notified."
    )
    notify.assert_called_once_with(
        user_id="11111111-1111-1111-1111-111111111111",
        notification_type="equipment_requirement_unavailable",
        title="Equipment is unavailable",
        body=(
            "Projector is Under Maintenance and cannot be allocated to Planning "
            "Summit. Please contact Technical Support about alternatives."
        ),
        event_id="33333333-3333-3333-3333-333333333333",
    )


@pytest.mark.parametrize(
    "code,status,message",
    [
        (
            "PGRST202",
            503,
            "The equipment booking database setup is missing or out of date. "
            "Apply the equipment booking migrations in the documented order, "
            "then retry.",
        ),
        ("23P01", 409, "This equipment is already booked for an overlapping time."),
        ("23503", 404, "The equipment or equipment request was not found."),
        ("42501", 403, "Only Technical Support can manage equipment bookings."),
        ("23514", 400, "The booking details are invalid. Check the times and try again."),
        ("08006", 502, "Unable to access equipment bookings."),
    ],
)
def test_service_maps_booking_database_errors(booking_database, code, status, message):
    client, _ = booking_database
    database_error = PostgrestAPIError(
        {"code": code, "message": "Private database detail"}
    )
    query = Mock()
    query.execute.side_effect = database_error
    client.rpc.return_value = query

    with pytest.raises(AuthError) as caught:
        equipment_booking_service.create_equipment_booking(
            "tech-token", EquipmentBookingCreate(**VALID_BOOKING)
        )

    assert caught.value.status_code == status
    assert caught.value.message == message
    assert caught.value.__cause__ is database_error


def test_service_deletes_booking(booking_database):
    client, _ = booking_database
    query = Mock()
    query.execute.return_value = SimpleNamespace(data=True)
    client.rpc.return_value = query

    equipment_booking_service.delete_equipment_booking("tech-token", BOOKING_ID)

    client.rpc.assert_called_once_with(
        "delete_equipment_booking", {"p_booking_id": BOOKING_ID}
    )


def test_service_reports_missing_booking_on_delete(booking_database):
    client, _ = booking_database
    query = Mock()
    query.execute.return_value = SimpleNamespace(data=False)
    client.rpc.return_value = query

    with pytest.raises(AuthError) as caught:
        equipment_booking_service.delete_equipment_booking("tech-token", BOOKING_ID)

    assert caught.value.status_code == 404
