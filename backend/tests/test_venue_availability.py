"""Calendar unit and route/service tests; database reads use test doubles."""

from types import SimpleNamespace

import pytest
from postgrest import APIError
from pydantic import ValidationError

from models.profile import Profile, Role
from models.venue_availability import VenueAvailabilityRequest
from services import auth_service, venue_availability_service as availability
from services.auth_service import AuthError

VENUE_ID = "33333333-3333-3333-3333-333333333333"
OTHER_ID = "44444444-4444-4444-4444-444444444444"
RANGE = {"start_at": "2026-11-20T10:00:00+08:00", "end_at": "2026-11-20T12:00:00+08:00"}


def request(**changes):
    return VenueAvailabilityRequest(venue_id=VENUE_ID, **{**RANGE, **changes})


def block(start, end, venue_id=VENUE_ID):
    return {"block_id": "55555555-5555-5555-5555-555555555555", "venue_id": venue_id,
            "start_at": start, "end_at": end, "block_reason": "Maintenance"}


class ReadClient:
    def __init__(self, blocks=None, venues=None, failure=None):
        self.records = {"venue_blocks": blocks or [], "venues": venues if venues is not None else [{"id": VENUE_ID, "name": "Hall", "setup_time_minutes":0, "turnaround_time_minutes":0}]}
        self.calls = []
        self.failure = failure

    def rpc(self, name, params):
        self.calls.append(("rpc", name, params))
        def execute():
            if name == "get_venue_operational_blocks" and self.failure == "venue_blocks":
                raise APIError({"code": "XX000", "message": "private database details"})
            return SimpleNamespace(data=self.records["venue_blocks"] if name == "get_venue_operational_blocks" else [])
        return SimpleNamespace(execute=execute)

    def table(self, table):
        self.calls.append(("table", table))
        owner = self

        class Query:
            def select(self, fields):
                owner.calls.append(("select", fields))
                return self

            def eq(self, key, value):
                owner.calls.append(("eq", key, value))
                return self

            def lt(self, key, value):
                owner.calls.append(("lt", key, value))
                return self

            def gt(self, key, value):
                owner.calls.append(("gt", key, value))
                return self

            def order(self, key):
                return self

            def execute(self):
                if owner.failure == table:
                    raise APIError({"code": "XX000", "message": "private database details", "details": None, "hint": None})
                return SimpleNamespace(data=owner.records[table])

        return Query()


def test_range_normalizes_utc():
    assert request().start_at.isoformat() == "2026-11-20T02:00:00+00:00"


@pytest.mark.parametrize("changes", [
    {"start_at": None}, {"end_at": None}, {"start_at": "bad"},
    {"start_at": "2026-11-20T10:00:00"}, {"end_at": "2026-11-20T12:00:00"},
    {"end_at": RANGE["start_at"]}, {"end_at": "2026-11-20T09:00:00+08:00"},
])
def test_invalid_range(changes):
    with pytest.raises(ValidationError):
        request(**changes)


@pytest.mark.parametrize("start,end,venue_id,included", [
    ("2026-11-20T10:30:00+08:00", "2026-11-20T11:30:00+08:00", VENUE_ID, True),
    ("2026-11-20T09:00:00+08:00", RANGE["start_at"], VENUE_ID, False),
    (RANGE["end_at"], "2026-11-20T13:00:00+08:00", VENUE_ID, False),
    (RANGE["start_at"], RANGE["end_at"], OTHER_ID, False),
    ("2026-11-19T22:00:00+08:00", "2026-11-20T11:00:00+08:00", VENUE_ID, True),
    ("2026-11-18T22:00:00+08:00", "2026-11-23T02:00:00+08:00", VENUE_ID, True),
])
def test_overlap_isolation_and_multidate(monkeypatch, start, end, venue_id, included):
    client = ReadClient([block(start, end, venue_id)])
    monkeypatch.setattr(availability.config, "get_user_client", lambda token: client)
    result = availability.get_venue_availability("token", request())
    assert bool(result.items) is included
    assert ("rpc", "get_venue_operational_blocks", {
        "p_venue_ids": [VENUE_ID], "p_start_at": request().start_at.isoformat(),
        "p_end_at": request().end_at.isoformat(),
    }) in client.calls
    if included:
        assert result.items[0].reason == "Maintenance"
        assert result.items[0].start_at.isoformat() == start


def test_empty_blocks_and_authoritative_reservations_are_verified(monkeypatch):
    monkeypatch.setattr(availability.config, "get_user_client", lambda token: ReadClient())
    result = availability.get_venue_availability("token", request()).model_dump(mode="json")
    assert result["items"] == []
    assert result["verification_status"] == "verified"
    assert result["sources"] == {key: "verified" for key in (
        "operational_blocks", "confirmed_bookings", "tentative_holds", "hold_expiry", "venue_buffers")}


@pytest.mark.parametrize("table", ["venues", "venue_blocks"])
def test_persistence_failure_is_not_empty(monkeypatch, table):
    monkeypatch.setattr(availability.config, "get_user_client", lambda token: ReadClient(failure=table))
    with pytest.raises(AuthError) as error:
        availability.get_venue_availability("token", request())
    assert error.value.status_code == 502
    assert "private" not in str(error.value)


def test_missing_venue(monkeypatch):
    monkeypatch.setattr(availability.config, "get_user_client", lambda token: ReadClient(venues=[]))
    with pytest.raises(AuthError) as error:
        availability.get_venue_availability("token", request())
    assert error.value.status_code == 404


def test_malformed_venue_data_is_controlled(monkeypatch):
    monkeypatch.setattr(availability.config, "get_user_client", lambda token: ReadClient(venues=[{"id": VENUE_ID}]))
    with pytest.raises(AuthError) as error:
        availability.get_venue_availability("token", request())
    assert error.value.status_code == 502


def test_blocks_are_sorted_chronologically(monkeypatch):
    later = block("2026-11-20T11:00:00+08:00", RANGE["end_at"])
    earlier = {**block(RANGE["start_at"], "2026-11-20T11:00:00+08:00"), "block_id": OTHER_ID}
    monkeypatch.setattr(availability.config, "get_user_client", lambda token: ReadClient([later, earlier]))
    result = availability.get_venue_availability("token", request())
    assert [str(item.id) for item in result.items] == [OTHER_ID, later["block_id"]]


@pytest.mark.parametrize("records", [[{}], [block("bad", RANGE["end_at"])], None])
def test_malformed_block_data_fails_closed(monkeypatch, records):
    client = ReadClient()
    client.records["venue_blocks"] = records
    monkeypatch.setattr(availability.config, "get_user_client", lambda token: client)
    with pytest.raises(AuthError) as error:
        availability.get_venue_availability("token", request())
    assert error.value.status_code == 502


def authenticate(monkeypatch, role):
    monkeypatch.setattr(auth_service, "get_user_id", lambda token: VENUE_ID)
    monkeypatch.setattr(auth_service, "get_profile", lambda token, user_id: Profile(id=user_id, full_name="Tester", role=role))


@pytest.mark.parametrize("role", list(Role))
def test_route_role_allowlist(client, monkeypatch, role):
    authenticate(monkeypatch, role)
    monkeypatch.setattr(availability.config, "get_user_client", lambda token: ReadClient())
    response = client.get(f"/venues/{VENUE_ID}/availability", query_string=RANGE, headers={"Authorization": "Bearer token"})
    assert response.status_code == (200 if role in {Role.VENUE_STAFF, Role.COORDINATOR} else 403)
    if response.status_code == 200:
        assert response.json["venue"]["name"] == "Hall"
        assert response.json["verification_status"] == "verified"


def test_route_requires_authentication(client):
    assert client.get(f"/venues/{VENUE_ID}/availability", query_string=RANGE).status_code == 401


@pytest.mark.parametrize("params", [{}, {"start_at": RANGE["start_at"]}, {"end_at": RANGE["end_at"]},
                                    {**RANGE, "end_at": RANGE["start_at"]}, {**RANGE, "start_at": "bad"}])
def test_route_validation(client, monkeypatch, params):
    authenticate(monkeypatch, Role.VENUE_STAFF)
    response = client.get(f"/venues/{VENUE_ID}/availability", query_string=params, headers={"Authorization": "Bearer token"})
    assert response.status_code == 400
    assert response.json["errors"]


@pytest.mark.parametrize("venue_id,venues,failure,status", [("bad", None, None, 400), (VENUE_ID, [], None, 404),
                                                          (VENUE_ID, None, "venue_blocks", 502)])
def test_route_controlled_errors(client, monkeypatch, venue_id, venues, failure, status):
    authenticate(monkeypatch, Role.COORDINATOR)
    monkeypatch.setattr(availability.config, "get_user_client", lambda token: ReadClient(venues=venues, failure=failure))
    response = client.get(f"/venues/{venue_id}/availability", query_string=RANGE, headers={"Authorization": "Bearer token"})
    assert response.status_code == status
    assert "private" not in response.get_data(as_text=True)


@pytest.mark.parametrize("matched", [True, False])
def test_legacy_grouping_retains_details_and_genuine_operational_blocks(monkeypatch, matched):
    old = {**block(RANGE["start_at"], RANGE["end_at"]), "block_reason":"Approved Booking: Workshop (Classroom)"}
    operational = {**old, "block_id":OTHER_ID, "block_reason":"Maintenance"}
    booking = {"id":"66666666-6666-6666-6666-666666666666", "venue_id":VENUE_ID,
               "type":"confirmed_booking", "reason":"Confirmed booking", **RANGE,
               "legacy_blocks":[{"id":old["block_id"],"reason":old["block_reason"],**RANGE}] if matched else []}
    client = ReadClient([old,operational]); original = client.rpc
    client.rpc = lambda name, params: (SimpleNamespace(execute=lambda: SimpleNamespace(data=[booking]))
                                     if name == "get_venue_reservations" else original(name, params))
    monkeypatch.setattr(availability.config,"get_user_client",lambda _:client)
    result = availability.get_venue_availability("token",request())
    assert result.verification_status == "partial"
    assert len(result.items) == (2 if matched else 3)
    assert any(item.reason == "Maintenance" for item in result.items)
    if matched:
        assert str(next(item for item in result.items if item.type == "confirmed_booking").legacy_blocks[0].id) == old["block_id"]
    assert len(client.records["venue_blocks"]) == 2



def test_missing_calendar_buffers_cannot_be_verified(monkeypatch):
    client = ReadClient(venues=[{"id":VENUE_ID,"name":"Hall"}])
    monkeypatch.setattr(availability.config,"get_user_client",lambda _:client)
    result = availability.get_venue_availability("token",request())
    assert result.verification_status == "partial"
    assert result.sources.venue_buffers == "unavailable"
