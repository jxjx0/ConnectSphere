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
    "session_id": "77777777-7777-7777-7777-777777777777",
    "lines": [
        {"item_name": "Projector", "quantity": 2, "specifics": "With HDMI"},
    ],
}

SAVED_REQUEST = {
    "id": "55555555-5555-5555-5555-555555555555",
    "event_id": VALID_REQUEST["event_id"],
    "coordinator_id": COORDINATOR.id,
    "status": "Pending Technical Approval",
    "request_details": "2 x Projector (With HDMI)",
    "event": {
        "id": VALID_REQUEST["event_id"],
        "name": "Community Conference",
        "start_time": "2027-04-03T09:00:00+00:00",
        "end_time": "2027-04-03T17:00:00+00:00",
    },
    "lines": VALID_REQUEST["lines"],
}

REQUEST_SELECT = (
    "*, event:events(id,name,start_time,end_time), "
    "session:event_sessions(id,name,start_time,end_time,equipment_requirements), "
    "items:equipment_request_items("
    "id,equipment_id,quantity,equipment:equipment(id,name,type)), "
    "lines:equipment_request_lines(id,item_name,quantity,specifics), "
    "equipment_bookings(id,equipment_id,line_id,start_at,end_at,equipment:equipment(id,name))"
)


def authenticate_as(monkeypatch, profile):
    monkeypatch.setattr(auth_service, "get_user_id", lambda token: profile.id)
    monkeypatch.setattr(
        auth_service, "get_profile", lambda token, user_id: profile
    )


def query_returning(rows):
    query = Mock()
    for method in ("select", "eq", "order", "limit"):
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
    assert submit.call_args.args[2].lines[0].item_name == "Projector"


def test_submission_allows_equipment_not_in_the_catalogue_and_no_specifics(client, monkeypatch):
    authenticate_as(monkeypatch, COORDINATOR)
    submit = Mock(return_value=SAVED_REQUEST)
    monkeypatch.setattr(
        equipment_request_service, "submit_equipment_request", submit
    )

    response = client.post(
        "/equipment-requests",
        json={**VALID_REQUEST, "lines": [{"item_name": " Fog machine ", "quantity": 1, "specifics": "  "}]},
        headers={"Authorization": "Bearer coordinator-token"},
    )

    assert response.status_code == 201
    line = submit.call_args.args[2].lines[0]
    assert (line.item_name, line.quantity, line.specifics) == ("Fog machine", 1, None)


@pytest.mark.parametrize(
    "lines",
    [[], None, [{"item_name": "   ", "quantity": 1}]],
    ids=["no-lines", "null-lines", "blank-name"],
)
def test_submission_requires_equipment_to_be_named(client, monkeypatch, lines):
    authenticate_as(monkeypatch, COORDINATOR)
    submit = Mock(side_effect=AssertionError("invalid request must not be saved"))
    monkeypatch.setattr(
        equipment_request_service, "submit_equipment_request", submit
    )

    response = client.post(
        "/equipment-requests",
        json={**VALID_REQUEST, "lines": lines},
        headers={"Authorization": "Bearer coordinator-token"},
    )

    assert response.status_code == 400, response.get_json()
    submit.assert_not_called()


def test_submission_requires_a_session(client, monkeypatch):
    authenticate_as(monkeypatch, COORDINATOR)
    submit = Mock(side_effect=AssertionError("invalid request must not be saved"))
    monkeypatch.setattr(
        equipment_request_service, "submit_equipment_request", submit
    )
    payload = {key: value for key, value in VALID_REQUEST.items() if key != "session_id"}

    response = client.post(
        "/equipment-requests",
        json=payload,
        headers={"Authorization": "Bearer coordinator-token"},
    )

    assert response.status_code == 400, response.get_json()
    submit.assert_not_called()


@pytest.mark.parametrize("quantity", [0, -1, 101])
def test_submission_rejects_quantities_out_of_range(client, monkeypatch, quantity):
    authenticate_as(monkeypatch, COORDINATOR)
    submit = Mock(side_effect=AssertionError("invalid request must not be saved"))
    monkeypatch.setattr(
        equipment_request_service, "submit_equipment_request", submit
    )

    payload = {
        **VALID_REQUEST,
        "lines": [{**VALID_REQUEST["lines"][0], "quantity": quantity}],
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
        json={**VALID_REQUEST, "lines": [
            {"item_name": "Projector", "quantity": 1},
            {"item_name": "projector ", "quantity": 1},
        ]},
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
        "submit_equipment_request_lines",
        {
            "p_event_id": VALID_REQUEST["event_id"],
            "p_session_id": VALID_REQUEST["session_id"],
            "p_lines": VALID_REQUEST["lines"],
        },
    )
    client.table.assert_not_called()
    assert result == {
        "id": SAVED_REQUEST["id"],
        "event_id": VALID_REQUEST["event_id"],
        "session_id": VALID_REQUEST["session_id"],
        "coordinator_id": COORDINATOR.id,
        "status": "Pending Technical Approval",
        "lines": VALID_REQUEST["lines"],
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
            "An equipment request has already been submitted for this session.",
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


def test_service_says_when_a_request_was_already_reviewed(
    equipment_request_database,
):
    client, _ = equipment_request_database
    rpc_query = Mock()
    rpc_query.execute.side_effect = PostgrestAPIError(
        {"code": "P0001", "message": "Private database detail"}
    )
    client.rpc.return_value = rpc_query

    with pytest.raises(AuthError) as caught:
        equipment_request_service.review_equipment_request(
            "staff-token",
            SAVED_REQUEST["id"],
            EquipmentRequestReview(decision="Approved"),
        )

    assert caught.value.message == "This equipment request has already been reviewed."


def test_service_refuses_approval_until_equipment_is_allocated(
    equipment_request_database,
):
    client, _ = equipment_request_database
    bookings = query_returning([])
    client.table.return_value = bookings

    with pytest.raises(AuthError) as caught:
        equipment_request_service.review_equipment_request(
            "staff-token",
            SAVED_REQUEST["id"],
            EquipmentRequestReview(decision="Approved"),
        )

    client.table.assert_called_once_with("equipment_bookings")
    bookings.eq.assert_called_once_with("request_id", SAVED_REQUEST["id"])
    client.rpc.assert_not_called()
    assert caught.value.status_code == 409
    assert caught.value.message == (
        "Allocate at least one item of equipment before approving this request."
    )


def test_service_approves_once_equipment_is_allocated(
    equipment_request_database,
):
    client, _ = equipment_request_database
    client.table.return_value = query_returning([{"id": "booking-1"}])
    rpc_query = Mock()
    rpc_query.execute.return_value = SimpleNamespace(
        data={"id": SAVED_REQUEST["id"], "status": "Approved"}
    )
    client.rpc.return_value = rpc_query

    result = equipment_request_service.review_equipment_request(
        "staff-token",
        SAVED_REQUEST["id"],
        EquipmentRequestReview(decision="Approved"),
    )

    assert result == {"id": SAVED_REQUEST["id"], "status": "Approved"}


def test_service_rejects_without_checking_allocations(
    equipment_request_database,
):
    client, _ = equipment_request_database
    rpc_query = Mock()
    rpc_query.execute.return_value = SimpleNamespace(
        data={"id": SAVED_REQUEST["id"], "status": "Rejected"}
    )
    client.rpc.return_value = rpc_query

    equipment_request_service.review_equipment_request(
        "staff-token",
        SAVED_REQUEST["id"],
        EquipmentRequestReview(decision="Rejected"),
    )

    client.table.assert_not_called()


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


def test_approving_before_everything_is_allocated_explains_why(monkeypatch):
    client = Mock()
    client.table.return_value = query_returning([{"id": "booking-1"}])
    client.rpc.return_value.execute.side_effect = PostgrestAPIError({
        "message": "Allocate all the requested equipment before approving this request.",
        "code": "EQ001", "details": None, "hint": None,
    })
    monkeypatch.setattr(config, "get_user_client", lambda token: client)

    with pytest.raises(AuthError) as caught:
        equipment_request_service.review_equipment_request(
            "tech-token", "request-1", EquipmentRequestReview(decision="Approved")
        )

    assert caught.value.status_code == 409
    assert "Allocate all the requested equipment" in caught.value.message


LINE_ID = "88888888-8888-8888-8888-888888888888"
NOTIFY_URL = f"/equipment-requests/{SAVED_REQUEST['id']}/lines/{LINE_ID}/notify-unavailable"


def test_tech_support_can_report_a_line_as_unavailable(client, monkeypatch):
    authenticate_as(monkeypatch, TECH_SUPPORT)
    notify = Mock()
    monkeypatch.setattr(equipment_request_service, "notify_line_unavailable", notify)

    response = client.post(NOTIFY_URL, headers={"Authorization": "Bearer tech-token"})

    assert response.status_code == 204
    notify.assert_called_once_with("tech-token", SAVED_REQUEST["id"], LINE_ID)


def test_only_tech_support_can_report_a_line_as_unavailable(client, monkeypatch):
    authenticate_as(monkeypatch, COORDINATOR)
    notify = Mock(side_effect=AssertionError("must not reach the service"))
    monkeypatch.setattr(equipment_request_service, "notify_line_unavailable", notify)

    response = client.post(NOTIFY_URL, headers={"Authorization": "Bearer coordinator-token"})

    assert response.status_code == 403


def _line_database(monkeypatch, line_rows):
    database = Mock()
    tables = {
        "equipment_request_lines": query_returning(line_rows),
        "events": query_returning([{"name": "Gala"}]),
    }
    database.table.side_effect = tables.__getitem__
    monkeypatch.setattr(config, "get_user_client", lambda token: database)


def test_reporting_a_line_tells_its_coordinator(monkeypatch):
    _line_database(monkeypatch, [{
        "item_name": "Fog machine",
        "request": {
            "status": "Pending Technical Approval",
            "coordinator_id": COORDINATOR.id,
            "event_id": "event-1",
        },
    }])
    notify = Mock(return_value=object())
    monkeypatch.setattr(equipment_request_service.notification_service, "notify", notify)

    equipment_request_service.notify_line_unavailable("tech-token", "request-1", "line-1")

    assert notify.call_args.kwargs["user_id"] == COORDINATOR.id
    assert "cannot supply Fog machine for Gala" in notify.call_args.kwargs["body"]


@pytest.mark.parametrize(
    "rows, status_code",
    [
        ([], 404),
        ([{"item_name": "Fog machine", "request": {
            "status": "Approved", "coordinator_id": "c", "event_id": "e",
        }}], 409),
    ],
    ids=["unknown-line", "already-reviewed"],
)
def test_reporting_a_line_is_refused_when_it_no_longer_applies(monkeypatch, rows, status_code):
    _line_database(monkeypatch, rows)
    notify = Mock(side_effect=AssertionError("must not notify"))
    monkeypatch.setattr(equipment_request_service.notification_service, "notify", notify)

    with pytest.raises(AuthError) as caught:
        equipment_request_service.notify_line_unavailable("tech-token", "request-1", "line-1")

    assert caught.value.status_code == status_code


def test_reporting_a_line_says_when_the_coordinator_could_not_be_told(monkeypatch):
    _line_database(monkeypatch, [{
        "item_name": "Fog machine",
        "request": {
            "status": "Pending Technical Approval",
            "coordinator_id": COORDINATOR.id,
            "event_id": "event-1",
        },
    }])
    monkeypatch.setattr(
        equipment_request_service.notification_service, "notify", Mock(return_value=None)
    )

    with pytest.raises(AuthError) as caught:
        equipment_request_service.notify_line_unavailable("tech-token", "request-1", "line-1")

    assert caught.value.status_code == 502


def _database_with_failing_rpc(monkeypatch, code="P0001"):
    database = Mock()
    database.rpc.return_value.execute.side_effect = PostgrestAPIError({
        "message": "failed", "code": code, "details": None, "hint": None,
    })
    monkeypatch.setattr(config, "get_user_client", lambda token: database)
    return database


def test_a_failed_queue_load_is_reported(monkeypatch):
    _database_with_failing_rpc(monkeypatch)

    with pytest.raises(AuthError) as caught:
        equipment_request_service.list_tech_support_equipment_requests("tech-token")

    assert caught.value.status_code == 409


def test_an_unreadable_queue_is_reported(monkeypatch):
    database = Mock()
    database.rpc.return_value.execute.return_value = SimpleNamespace(data={"not": "a list"})
    monkeypatch.setattr(config, "get_user_client", lambda token: database)

    with pytest.raises(AuthError) as caught:
        equipment_request_service.list_tech_support_equipment_requests("tech-token")

    assert caught.value.status_code == 502


def _failing_query():
    query = Mock()
    for method in ("select", "eq", "limit", "order"):
        getattr(query, method).return_value = query
    query.execute.side_effect = PostgrestAPIError({
        "message": "failed", "code": "XX000", "details": None, "hint": None,
    })
    return query


def test_reporting_a_line_reports_a_failed_lookup(monkeypatch):
    database = Mock()
    database.table.return_value = _failing_query()
    monkeypatch.setattr(config, "get_user_client", lambda token: database)

    with pytest.raises(AuthError) as caught:
        equipment_request_service.notify_line_unavailable("tech-token", "request-1", "line-1")

    assert caught.value.status_code == 502


def test_reporting_a_line_still_sends_if_the_event_name_cannot_load(monkeypatch):
    database = Mock()
    tables = {
        "equipment_request_lines": query_returning([{
            "item_name": "Fog machine",
            "request": {
                "status": "Pending Technical Approval",
                "coordinator_id": COORDINATOR.id,
                "event_id": "event-1",
            },
        }]),
        "events": _failing_query(),
    }
    database.table.side_effect = tables.__getitem__
    monkeypatch.setattr(config, "get_user_client", lambda token: database)
    notify = Mock(return_value=object())
    monkeypatch.setattr(equipment_request_service.notification_service, "notify", notify)

    equipment_request_service.notify_line_unavailable("tech-token", "request-1", "line-1")

    assert "for your event" in notify.call_args.kwargs["body"]


def test_approval_reports_a_failed_allocation_check(monkeypatch):
    database = Mock()
    database.table.return_value = _failing_query()
    monkeypatch.setattr(config, "get_user_client", lambda token: database)

    with pytest.raises(AuthError) as caught:
        equipment_request_service.review_equipment_request(
            "tech-token", "request-1", EquipmentRequestReview(decision="Approved")
        )

    assert caught.value.status_code == 502


def test_a_coordinator_lists_all_their_requests_without_an_event(client, monkeypatch):
    authenticate_as(monkeypatch, COORDINATOR)
    list_requests = Mock(return_value=[SAVED_REQUEST])
    monkeypatch.setattr(equipment_request_service, "list_equipment_requests", list_requests)

    response = client.get("/equipment-requests", headers={"Authorization": "Bearer token"})

    assert response.status_code == 200
    list_requests.assert_called_once_with("token")


@pytest.mark.parametrize(
    "path",
    [
        f"/equipment-requests/{SAVED_REQUEST['id']}/review",
        f"/equipment-requests/{SAVED_REQUEST['id']}/cancel",
    ],
    ids=["review", "cancel"],
)
def test_review_and_cancel_need_a_json_object(client, monkeypatch, path):
    authenticate_as(monkeypatch, TECH_SUPPORT)

    response = client.patch(path, json=["not", "an", "object"], headers={"Authorization": "Bearer token"})

    assert response.status_code == 400


def test_reporting_a_line_needs_valid_ids(client, monkeypatch):
    authenticate_as(monkeypatch, TECH_SUPPORT)
    notify = Mock(side_effect=AssertionError("must not reach the service"))
    monkeypatch.setattr(equipment_request_service, "notify_line_unavailable", notify)

    response = client.post(
        "/equipment-requests/not-an-id/lines/also-not/notify-unavailable",
        headers={"Authorization": "Bearer token"},
    )

    assert response.status_code == 400
