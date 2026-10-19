"""Tests for submitting and listing equipment requests."""

from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from postgrest import APIError as PostgrestAPIError

import config
from models.equipment_request import EquipmentRequestReview, EquipmentRequestSubmit
from models.profile import Profile, Role
from routes import equipment
from services import auth_service, equipment_request_service
from services.auth_service import AuthError


COORDINATOR = Profile(
    id="11111111-1111-1111-1111-111111111111",
    full_name="Event Coordinator",
    role=Role.COORDINATOR,
)

TECH_SUPPORT = Profile(
    id="22222222-2222-2222-2222-222222222222",
    full_name="Technical Support",
    role=Role.TECH_SUPPORT,
)

ATTENDEE = Profile(
    id="66666666-6666-6666-6666-666666666666",
    full_name="Event Attendee",
    role=Role.ATTENDEE,
)

VALID_REQUEST = {
    "event_id": "33333333-3333-3333-3333-333333333333",
    "request_details": "Two projectors and a wireless microphone",
    "items": [
        {
            "equipment_id": "44444444-4444-4444-4444-444444444444",
            "quantity": 2,
        }
    ],
}

SAVED_REQUEST = {
    "id": "55555555-5555-5555-5555-555555555555",
    "event_id": VALID_REQUEST["event_id"],
    "coordinator_id": COORDINATOR.id,
    "status": "Pending Technical Approval",
    "request_details": VALID_REQUEST["request_details"],
    "event": {
        "id": VALID_REQUEST["event_id"],
        "name": "Community Conference",
        "start_time": "2027-04-03T09:00:00+00:00",
        "end_time": "2027-04-03T17:00:00+00:00",
    },
    "items": [
        {
            "equipment_id": VALID_REQUEST["items"][0]["equipment_id"],
            "quantity": 2,
            "equipment": {"name": "Projector", "type": "Visual"},
        }
    ],
}

REQUEST_SELECT = (
    "*, event:events(id,name,start_time,end_time), "
    "items:equipment_request_items("
    "id,equipment_id,quantity,equipment:equipment(id,name,type)), "
    "equipment_bookings(id,equipment_id,start_at,end_at,equipment:equipment(id,name))"
)


def authenticate_as(monkeypatch, profile):
    monkeypatch.setattr(auth_service, "get_user_id", lambda token: profile.id)
    monkeypatch.setattr(
        auth_service, "get_profile", lambda token, user_id: profile
    )


def query_returning(rows):
    query = Mock()
    for method in ("select", "eq", "order"):
        getattr(query, method).return_value = query
    query.execute.return_value = SimpleNamespace(data=rows)
    return query


@pytest.fixture
def equipment_request():
    return EquipmentRequestSubmit(**VALID_REQUEST)


@pytest.fixture
def equipment_request_database(monkeypatch):
    client = Mock()
    client_factory = Mock(return_value=client)
    monkeypatch.setattr(config, "get_user_client", client_factory)
    return client, client_factory


def test_coordinator_can_submit_equipment_request(client, monkeypatch):
    authenticate_as(monkeypatch, COORDINATOR)
    submit = Mock(return_value=SAVED_REQUEST)
    monkeypatch.setattr(
        equipment_request_service, "submit_equipment_request", submit
    )

    response = client.post(
        "/equipment-requests",
        json=VALID_REQUEST,
        headers={"Authorization": "Bearer coordinator-token"},
    )

    assert response.status_code == 201
    assert response.get_json()["request"] == SAVED_REQUEST
    submit.assert_called_once()
    assert submit.call_args.args[1] == COORDINATOR.id
    assert submit.call_args.args[2].request_details == VALID_REQUEST["request_details"]


def test_submission_allows_free_text_request_without_catalog_items(client, monkeypatch):
    authenticate_as(monkeypatch, COORDINATOR)
    submit = Mock(return_value=SAVED_REQUEST)
    monkeypatch.setattr(
        equipment_request_service, "submit_equipment_request", submit
    )

    response = client.post(
        "/equipment-requests",
        json={**VALID_REQUEST, "items": []},
        headers={"Authorization": "Bearer coordinator-token"},
    )

    assert response.status_code == 201
    submit.assert_called_once()
    assert submit.call_args.args[2].items == []


@pytest.mark.parametrize("request_details", ["", "   ", None])
def test_submission_requires_nonblank_request_details(
    client, monkeypatch, request_details
):
    authenticate_as(monkeypatch, COORDINATOR)
    submit = Mock(side_effect=AssertionError("invalid request must not be saved"))
    monkeypatch.setattr(
        equipment_request_service, "submit_equipment_request", submit
    )

    response = client.post(
        "/equipment-requests",
        json={**VALID_REQUEST, "request_details": request_details},
        headers={"Authorization": "Bearer coordinator-token"},
    )

    assert response.status_code == 400, response.get_json()
    submit.assert_not_called()


def test_submission_rejects_non_positive_quantities(client, monkeypatch):
    authenticate_as(monkeypatch, COORDINATOR)
    submit = Mock(side_effect=AssertionError("invalid request must not be saved"))
    monkeypatch.setattr(
        equipment_request_service, "submit_equipment_request", submit
    )

    payload = {
        **VALID_REQUEST,
        "items": [{**VALID_REQUEST["items"][0], "quantity": 0}],
    }
    response = client.post(
        "/equipment-requests",
        json=payload,
        headers={"Authorization": "Bearer coordinator-token"},
    )

    assert response.status_code == 400
    submit.assert_not_called()


def test_submission_rejects_duplicate_equipment_items(client, monkeypatch):
    authenticate_as(monkeypatch, COORDINATOR)
    submit = Mock(side_effect=AssertionError("invalid request must not be saved"))
    monkeypatch.setattr(
        equipment_request_service, "submit_equipment_request", submit
    )

    response = client.post(
        "/equipment-requests",
        json={**VALID_REQUEST, "items": VALID_REQUEST["items"] * 2},
        headers={"Authorization": "Bearer coordinator-token"},
    )

    assert response.status_code == 400
    submit.assert_not_called()


def test_submission_rejects_non_object_json(client, monkeypatch):
    authenticate_as(monkeypatch, COORDINATOR)
    submit = Mock(side_effect=AssertionError("invalid request must not be saved"))
    monkeypatch.setattr(
        equipment_request_service, "submit_equipment_request", submit
    )

    response = client.post(
        "/equipment-requests",
        json=["not", "an", "object"],
        headers={"Authorization": "Bearer coordinator-token"},
    )

    assert response.status_code == 400
    submit.assert_not_called()


def test_non_coordinator_cannot_submit_equipment_request(client, monkeypatch):
    authenticate_as(monkeypatch, TECH_SUPPORT)
    submit = Mock(side_effect=AssertionError("staff cannot submit requests"))
    monkeypatch.setattr(
        equipment_request_service, "submit_equipment_request", submit
    )

    response = client.post(
        "/equipment-requests",
        json=VALID_REQUEST,
        headers={"Authorization": "Bearer tech-token"},
    )

    assert response.status_code == 403
    submit.assert_not_called()


def test_technical_support_can_view_equipment_requests(client, monkeypatch):
    authenticate_as(monkeypatch, TECH_SUPPORT)
    list_requests = Mock(return_value=[SAVED_REQUEST])
    monkeypatch.setattr(
        equipment_request_service,
        "list_tech_support_equipment_requests",
        list_requests,
    )

    response = client.get(
        "/equipment-requests",
        headers={"Authorization": "Bearer tech-token"},
    )

    assert response.status_code == 200
    assert response.get_json()["requests"] == [SAVED_REQUEST]
    list_requests.assert_called_once_with("tech-token")


def test_technical_support_can_review_equipment_request(client, monkeypatch):
    authenticate_as(monkeypatch, TECH_SUPPORT)
    review_request = Mock(return_value={"id": SAVED_REQUEST["id"], "status": "Approved"})
    monkeypatch.setattr(
        equipment_request_service, "review_equipment_request", review_request
    )

    response = client.patch(
        f"/equipment-requests/{SAVED_REQUEST['id']}/review",
        json={"decision": "Approved"},
        headers={"Authorization": "Bearer test-token"},
    )

    assert response.status_code == 200
    assert response.get_json()["request"]["status"] == "Approved"
    review_request.assert_called_once()
    assert review_request.call_args.args[0] == "test-token"
    assert review_request.call_args.args[1] == SAVED_REQUEST["id"]
    assert review_request.call_args.args[2] == EquipmentRequestReview(
        decision="Approved"
    )


@pytest.mark.parametrize("profile", [COORDINATOR, ATTENDEE])
def test_non_technical_support_cannot_review_equipment_request(
    client, monkeypatch, profile
):
    authenticate_as(monkeypatch, profile)
    review_request = Mock(
        side_effect=AssertionError("only Technical Support may review")
    )
    monkeypatch.setattr(
        equipment_request_service, "review_equipment_request", review_request
    )

    response = client.patch(
        f"/equipment-requests/{SAVED_REQUEST['id']}/review",
        json={"decision": "Approved"},
        headers={"Authorization": "Bearer test-token"},
    )

    assert response.status_code == 403
    review_request.assert_not_called()


def test_review_rejects_invalid_decision(client, monkeypatch):
    authenticate_as(monkeypatch, TECH_SUPPORT)
    review_request = Mock(
        side_effect=AssertionError("invalid review must not reach the service")
    )
    monkeypatch.setattr(
        equipment_request_service, "review_equipment_request", review_request
    )

    response = client.patch(
        f"/equipment-requests/{SAVED_REQUEST['id']}/review",
        json={"decision": "Maybe"},
        headers={"Authorization": "Bearer test-token"},
    )

    assert response.status_code == 400
    review_request.assert_not_called()


def test_attendee_cannot_view_equipment_requests(client, monkeypatch):
    authenticate_as(monkeypatch, ATTENDEE)
    list_requests = Mock(
        side_effect=AssertionError("attendee must not reach the service")
    )
    monkeypatch.setattr(
        equipment_request_service, "list_equipment_requests", list_requests
    )

    response = client.get(
        "/equipment-requests",
        headers={"Authorization": "Bearer attendee-token"},
    )

    assert response.status_code == 403
    assert response.get_json()["error"]
    list_requests.assert_not_called()


def test_coordinator_can_list_one_events_equipment_request(client, monkeypatch):
    authenticate_as(monkeypatch, COORDINATOR)
    list_requests = Mock(return_value=[SAVED_REQUEST])
    monkeypatch.setattr(
        equipment_request_service, "list_equipment_requests", list_requests
    )

    response = client.get(
        f"/equipment-requests?event_id={VALID_REQUEST['event_id']}",
        headers={"Authorization": "Bearer coordinator-token"},
    )

    assert response.status_code == 200
    assert response.get_json()["requests"] == [SAVED_REQUEST]
    list_requests.assert_called_once_with(
        "coordinator-token", VALID_REQUEST["event_id"]
    )


def test_equipment_request_list_rejects_invalid_event_id(client, monkeypatch):
    authenticate_as(monkeypatch, COORDINATOR)
    list_requests = Mock(side_effect=AssertionError("invalid ID must not be queried"))
    monkeypatch.setattr(
        equipment_request_service, "list_equipment_requests", list_requests
    )

    response = client.get(
        "/equipment-requests?event_id=not-an-id",
        headers={"Authorization": "Bearer coordinator-token"},
    )

    assert response.status_code == 400
    list_requests.assert_not_called()


def test_equipment_catalog_is_registered_at_its_frontend_api_path(
    client, monkeypatch
):
    monkeypatch.setattr(auth_service, "get_user_id", lambda token: COORDINATOR.id)
    monkeypatch.setattr(equipment, "get_all_equipment", lambda token: [])

    response = client.get(
        "/api/equipment",
        headers={"Authorization": "Bearer coordinator-token"},
    )

    assert response.status_code == 200
    assert response.get_json() == []


@pytest.mark.parametrize(
    "rpc_data",
    [
        SAVED_REQUEST["id"],
        [SAVED_REQUEST["id"]],
    ],
    ids=["scalar-id", "list-id"],
)
def test_service_returns_submit_result_without_a_post_save_read(
    equipment_request_database, equipment_request, rpc_data
):
    client, client_factory = equipment_request_database
    rpc_query = Mock()
    rpc_query.execute.return_value = SimpleNamespace(data=rpc_data)
    client.rpc.return_value = rpc_query
    saved_query = query_returning([SAVED_REQUEST])
    client.table.return_value = saved_query

    result = equipment_request_service.submit_equipment_request(
        "coordinator-token", COORDINATOR.id, equipment_request
    )

    client_factory.assert_called_once_with("coordinator-token")
    client.rpc.assert_called_once_with(
        "submit_equipment_request",
        {
            "p_event_id": VALID_REQUEST["event_id"],
            "p_request_details": VALID_REQUEST["request_details"],
            "p_items": VALID_REQUEST["items"],
        },
    )
    client.table.assert_not_called()
    assert result == {
        "id": SAVED_REQUEST["id"],
        "event_id": VALID_REQUEST["event_id"],
        "coordinator_id": COORDINATOR.id,
        "request_details": VALID_REQUEST["request_details"],
        "status": "Pending Technical Approval",
        "items": VALID_REQUEST["items"],
    }


@pytest.mark.parametrize("rpc_data", [None, []], ids=["null-id", "empty-id-list"])
def test_service_reports_missing_rpc_result(
    equipment_request_database, equipment_request, rpc_data
):
    client, _ = equipment_request_database
    rpc_query = Mock()
    rpc_query.execute.return_value = SimpleNamespace(data=rpc_data)
    client.rpc.return_value = rpc_query

    with pytest.raises(AuthError) as caught:
        equipment_request_service.submit_equipment_request(
            "coordinator-token", COORDINATOR.id, equipment_request
        )

    assert caught.value.status_code == 502
    assert caught.value.message == "Equipment request was not saved."
    client.table.assert_not_called()


@pytest.mark.parametrize(
    "code,status,message",
    [
        (
            "42501",
            403,
            "You do not have permission to perform this equipment request action.",
        ),
        (
            "P0002",
            404,
            "The event was not found, is not assigned to you, or is not eligible for an equipment request.",
        ),
        (
            "P0001",
            409,
            "An equipment request has already been submitted for this event.",
        ),
        (
            "22023",
            400,
            "The event or equipment details are invalid. Check the request and try again.",
        ),
        (
            "08006",
            502,
            "Unable to access equipment requests.",
        ),
    ],
)
def test_service_maps_rpc_database_errors(
    equipment_request_database, equipment_request, code, status, message
):
    client, _ = equipment_request_database
    rpc_query = Mock()
    database_error = PostgrestAPIError(
        {"code": code, "message": "Private database detail"}
    )
    rpc_query.execute.side_effect = database_error
    client.rpc.return_value = rpc_query

    with pytest.raises(AuthError) as caught:
        equipment_request_service.submit_equipment_request(
            "coordinator-token", COORDINATOR.id, equipment_request
        )

    assert caught.value.status_code == status
    assert caught.value.message == message
    assert "Private database detail" not in str(caught.value)
    assert caught.value.__cause__ is database_error


def test_service_list_returns_requests_ordered_by_recent_creation(
    equipment_request_database
):
    client, client_factory = equipment_request_database
    query = query_returning([SAVED_REQUEST])
    client.table.return_value = query

    result = equipment_request_service.list_equipment_requests("staff-token")

    client_factory.assert_called_once_with("staff-token")
    client.table.assert_called_once_with("equipment_requests")
    query.select.assert_called_once_with(REQUEST_SELECT)
    query.order.assert_called_once_with("created_at", desc=True)
    assert result == [SAVED_REQUEST]


def test_service_list_can_filter_to_one_event(equipment_request_database):
    client, _ = equipment_request_database
    query = query_returning([SAVED_REQUEST])
    client.table.return_value = query

    result = equipment_request_service.list_equipment_requests(
        "coordinator-token", VALID_REQUEST["event_id"]
    )

    query.eq.assert_called_once_with("event_id", VALID_REQUEST["event_id"])
    assert result == [SAVED_REQUEST]


def test_technical_support_service_loads_review_queue_via_user_rpc(
    equipment_request_database,
):
    client, client_factory = equipment_request_database
    rpc_query = Mock()
    rpc_query.execute.return_value = SimpleNamespace(data=[SAVED_REQUEST])
    client.rpc.return_value = rpc_query

    result = equipment_request_service.list_tech_support_equipment_requests(
        "staff-token"
    )

    client_factory.assert_called_once_with("staff-token")
    client.rpc.assert_called_once_with("list_equipment_request_review_queue")
    assert result == [SAVED_REQUEST]


@pytest.mark.parametrize("decision", ["Approved", "Rejected"])
def test_service_returns_saved_review_status(
    equipment_request_database, decision
):
    client, _ = equipment_request_database
    rpc_query = Mock()
    rpc_query.execute.return_value = SimpleNamespace(
        data={"id": SAVED_REQUEST["id"], "status": decision}
    )
    client.rpc.return_value = rpc_query
    review = EquipmentRequestReview(decision=decision)

    result = equipment_request_service.review_equipment_request(
        "staff-token", SAVED_REQUEST["id"], review
    )

    client.rpc.assert_called_once_with(
        "review_equipment_request",
        {"p_request_id": SAVED_REQUEST["id"], "p_decision": decision},
    )
    assert result == {"id": SAVED_REQUEST["id"], "status": decision}


def test_service_reports_unexpected_review_result(equipment_request_database):
    client, _ = equipment_request_database
    rpc_query = Mock()
    rpc_query.execute.return_value = SimpleNamespace(data=None)
    client.rpc.return_value = rpc_query

    with pytest.raises(AuthError) as caught:
        equipment_request_service.review_equipment_request(
            "staff-token",
            SAVED_REQUEST["id"],
            EquipmentRequestReview(decision="Approved"),
        )

    assert caught.value.status_code == 502


@pytest.mark.parametrize(
    "code,status",
    [("P0001", 409), ("P0002", 404), ("22023", 400), ("42501", 403)],
)
def test_service_maps_review_database_errors(
    equipment_request_database, code, status
):
    client, _ = equipment_request_database
    rpc_query = Mock()
    rpc_query.execute.side_effect = PostgrestAPIError(
        {"code": code, "message": "Private database detail"}
    )
    client.rpc.return_value = rpc_query

    with pytest.raises(AuthError) as caught:
        equipment_request_service.review_equipment_request(
            "staff-token",
            SAVED_REQUEST["id"],
            EquipmentRequestReview(decision="Approved"),
        )

    assert caught.value.status_code == status
    assert "Private database detail" not in caught.value.message


def test_service_maps_database_errors_while_listing_requests(
    equipment_request_database,
):
    client, _ = equipment_request_database
    query = query_returning([])
    database_error = PostgrestAPIError(
        {"code": "08006", "message": "Private database detail"}
    )
    query.execute.side_effect = database_error
    client.table.return_value = query

    with pytest.raises(AuthError) as caught:
        equipment_request_service.list_equipment_requests("staff-token")

    assert caught.value.status_code == 502
    assert caught.value.message == "Unable to access equipment requests."
    assert caught.value.__cause__ is database_error
