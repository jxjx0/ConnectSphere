"""Tests for the equipment catalogue: its routes, service and model."""

from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from postgrest import APIError as PostgrestAPIError
from pydantic import ValidationError

import config
from models.equipment import EquipmentCreate
from models.profile import Profile, Role
from routes import equipment as equipment_routes
from services import auth_service, equipment_service
from services.auth_service import AuthError


TECH_SUPPORT = Profile(id="tech-1", full_name="Tech Support", role=Role.TECH_SUPPORT)
COORDINATOR = Profile(id="coordinator-1", full_name="Coordinator", role=Role.COORDINATOR)

VALID_EQUIPMENT = {"name": "Old Projector", "type": "Projector"}
HEADERS = {"Authorization": "Bearer token"}
URL = "/api/equipment"


def authenticate_as(monkeypatch, profile):
    monkeypatch.setattr(auth_service, "get_user_id", lambda token: profile.id)
    monkeypatch.setattr(auth_service, "get_profile", lambda token, user_id: profile)


def api_error(message="database down"):
    return PostgrestAPIError({"message": message, "code": "XX000", "details": None, "hint": None})


# --- Model ------------------------------------------------------------------


def test_type_is_free_text_and_trimmed():
    equipment = EquipmentCreate(name="Fog machine", type="  Fog machine ")
    assert equipment.type == "Fog machine"
    assert equipment.maintenance_status == "Functional"


@pytest.mark.parametrize(
    "fields",
    [
        {"name": "Fog machine", "type": "   "},
        {"name": "Fog machine", "type": ""},
        {"name": "Fog machine", "type": "x" * 121},
        {"name": "Fog machine"},
        {"name": "", "type": "Fog machine"},
        {"name": "Fog machine", "type": "Fog machine", "maintenance_status": "Lost"},
    ],
    ids=["blank-type", "empty-type", "long-type", "no-type", "no-name", "bad-status"],
)
def test_invalid_equipment_is_refused(fields):
    with pytest.raises(ValidationError):
        EquipmentCreate(**fields)


# --- Create route -----------------------------------------------------------


def test_tech_support_can_create_equipment(client, monkeypatch):
    authenticate_as(monkeypatch, TECH_SUPPORT)
    create = Mock(return_value={"id": "item-1", **VALID_EQUIPMENT})
    monkeypatch.setattr(equipment_routes, "create_equipment", create)

    response = client.post(URL, json=VALID_EQUIPMENT, headers=HEADERS)

    assert response.status_code == 201
    assert response.get_json()["id"] == "item-1"
    assert create.call_args.args[1].type == "Projector"


def test_only_tech_support_can_create_equipment(client, monkeypatch):
    authenticate_as(monkeypatch, COORDINATOR)
    create = Mock(side_effect=AssertionError("must not reach the service"))
    monkeypatch.setattr(equipment_routes, "create_equipment", create)

    response = client.post(URL, json=VALID_EQUIPMENT, headers=HEADERS)

    assert response.status_code == 403


def test_creating_invalid_equipment_is_refused(client, monkeypatch):
    authenticate_as(monkeypatch, TECH_SUPPORT)

    response = client.post(URL, json={"name": "Fog machine", "type": "  "}, headers=HEADERS)

    assert response.status_code == 400
    assert "Enter the type of this equipment." in response.get_json()["errors"]


def test_an_unexpected_create_failure_is_reported(client, monkeypatch):
    authenticate_as(monkeypatch, TECH_SUPPORT)
    monkeypatch.setattr(equipment_routes, "create_equipment", Mock(side_effect=RuntimeError("boom")))

    response = client.post(URL, json=VALID_EQUIPMENT, headers=HEADERS)

    assert response.status_code == 500


# --- List route -------------------------------------------------------------


def test_signed_in_users_can_list_equipment(client, monkeypatch):
    authenticate_as(monkeypatch, COORDINATOR)
    monkeypatch.setattr(equipment_routes, "get_all_equipment", Mock(return_value=[VALID_EQUIPMENT]))

    response = client.get(URL, headers=HEADERS)

    assert response.status_code == 200
    assert response.get_json() == [VALID_EQUIPMENT]


def test_a_failed_listing_is_reported(client, monkeypatch):
    authenticate_as(monkeypatch, COORDINATOR)
    monkeypatch.setattr(equipment_routes, "get_all_equipment", Mock(side_effect=RuntimeError("boom")))

    assert client.get(URL, headers=HEADERS).status_code == 500


# --- Update route -----------------------------------------------------------


def test_tech_support_can_update_equipment(client, monkeypatch):
    authenticate_as(monkeypatch, TECH_SUPPORT)
    update = Mock(return_value=[{"id": "item-1", "type": "Projector"}])
    monkeypatch.setattr(equipment_routes, "update_equipment", update)

    response = client.put(f"{URL}/item-1", json={"type": "Projector"}, headers=HEADERS)

    assert response.status_code == 200
    update.assert_called_once_with("item-1", {"type": "Projector"}, access_token="token")


def test_only_tech_support_can_update_equipment(client, monkeypatch):
    authenticate_as(monkeypatch, COORDINATOR)
    update = Mock(side_effect=AssertionError("must not reach the service"))
    monkeypatch.setattr(equipment_routes, "update_equipment", update)

    response = client.put(f"{URL}/item-1", json={"type": "Projector"}, headers=HEADERS)

    assert response.status_code == 403


@pytest.mark.parametrize(
    "result, payload, status_code",
    [
        ([], {"type": "Projector"}, 404),
        (RuntimeError("boom"), {"type": "Projector"}, 500),
        ([], {}, 400),
    ],
    ids=["unknown-item", "failure", "empty-payload"],
)
def test_failed_updates_are_reported(client, monkeypatch, result, payload, status_code):
    authenticate_as(monkeypatch, TECH_SUPPORT)
    monkeypatch.setattr(equipment_routes, "update_equipment", Mock(side_effect=[result]))

    response = client.put(f"{URL}/item-1", json=payload, headers=HEADERS)

    assert response.status_code == status_code


# --- Service ----------------------------------------------------------------


@pytest.fixture
def database(monkeypatch):
    client = Mock()
    monkeypatch.setattr(config, "get_user_client", Mock(return_value=client))
    return client


def test_service_saves_the_type_it_was_given(database):
    insert = database.from_.return_value.insert
    insert.return_value.execute.return_value = SimpleNamespace(data=[{"id": "item-1"}])

    result = equipment_service.create_equipment("token", EquipmentCreate(**VALID_EQUIPMENT))

    assert result == {"id": "item-1"}
    saved = insert.call_args.args[0]
    assert (saved["name"], saved["type"]) == ("Old Projector", "Projector")
    assert saved["maintenance_status"] == "Functional"


def test_service_reports_a_database_error_on_create(database):
    database.from_.return_value.insert.return_value.execute.side_effect = api_error("bad row")

    with pytest.raises(AuthError) as caught:
        equipment_service.create_equipment("token", EquipmentCreate(**VALID_EQUIPMENT))

    assert caught.value.status_code == 400
    assert "bad row" not in caught.value.message
    assert caught.value.message == "Unable to create equipment. Please try again."
    assert caught.value.__cause__ is database.from_.return_value.insert.return_value.execute.side_effect


def test_service_reports_when_nothing_was_created(database):
    database.from_.return_value.insert.return_value.execute.return_value = SimpleNamespace(data=[])

    with pytest.raises(AuthError) as caught:
        equipment_service.create_equipment("token", EquipmentCreate(**VALID_EQUIPMENT))

    assert caught.value.status_code == 502


def test_service_lists_equipment(database):
    database.table.return_value.select.return_value.execute.return_value = SimpleNamespace(
        data=[VALID_EQUIPMENT]
    )

    assert equipment_service.get_all_equipment("token") == [VALID_EQUIPMENT]
    database.table.assert_called_once_with("equipment")


def test_service_updates_one_item(database):
    update = database.table.return_value.update
    update.return_value.eq.return_value.execute.return_value = SimpleNamespace(data=[{"id": "item-1"}])

    result = equipment_service.update_equipment("item-1", {"type": "Projector"}, access_token="token")

    assert result == [{"id": "item-1"}]
    update.assert_called_once_with({"type": "Projector"})
    update.return_value.eq.assert_called_once_with("id", "item-1")
