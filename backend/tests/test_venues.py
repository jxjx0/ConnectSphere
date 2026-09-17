"""Tests for the protected venue catalogue endpoints."""

import pytest
from pydantic import ValidationError
from types import SimpleNamespace

from models.profile import Profile, Role
from models.venue import Venue, VenueCreateRequest, VenueUpdateRequest
from models.venue_audit import VenueEditHistory
from services import auth_service, venue_service
from services.auth_service import AuthError


VALID_VENUE = {
    "name": "Grand Hall",
    "location": "123 Main Street",
    "capacity": 200,
    "facilities": {"parking": True},
    "accessibility": ["Wheelchair access", "Hearing loop"],
    "layouts": [
        {"name": "Theatre", "capacity": 150},
        {"name": "Banquet", "capacity": 80},
    ],
    "operating_hours": {"open": "08:00", "close": "22:00"},
}

VENUE_STAFF_PROFILE = Profile(
    id="22222222-2222-2222-2222-222222222222",
    full_name="Venue Staff",
    role=Role.VENUE_STAFF,
)

VENUE_RESPONSE = Venue(
    id="33333333-3333-3333-3333-333333333333",
    **VALID_VENUE,
)

HISTORY_RESPONSE = VenueEditHistory(
    id="44444444-4444-4444-4444-444444444444",
    venue_id=VENUE_RESPONSE.id,
    changed_by=VENUE_STAFF_PROFILE.id,
    changed_by_name="Venue Staff",
    changed_at="2026-09-18T02:00:00Z",
    changed_fields=["capacity"],
    old_values={"capacity": 200},
    new_values={"capacity": 250},
)


def authenticate_as_venue_staff(monkeypatch):
    """Replace token verification and profile lookup for an isolated route test."""
    monkeypatch.setattr(
        auth_service,
        "get_user_id",
        lambda access_token: VENUE_STAFF_PROFILE.id,
    )
    monkeypatch.setattr(
        auth_service,
        "get_profile",
        lambda access_token, user_id: VENUE_STAFF_PROFILE,
    )


def test_venue_staff_can_create_a_valid_venue(
    client, monkeypatch
):
    authenticate_as_venue_staff(monkeypatch)
    monkeypatch.setattr(
        venue_service,
        "create_venue",
        lambda access_token, request: VENUE_RESPONSE,
    )

    response = client.post(
        "/venues",
        json=VALID_VENUE,
        headers={"Authorization": "Bearer venue-token"},
    )

    assert response.status_code == 201
    assert response.get_json()["venue"]["name"] == "Grand Hall"


def test_create_venue_passes_validated_request_to_service(
    client, monkeypatch
):
    authenticate_as_venue_staff(monkeypatch)
    captured = {}

    def create_venue(access_token, request):
        captured["access_token"] = access_token
        captured["request"] = request
        return VENUE_RESPONSE

    monkeypatch.setattr(venue_service, "create_venue", create_venue)

    response = client.post(
        "/venues",
        json=VALID_VENUE,
        headers={"Authorization": "Bearer venue-token"},
    )

    assert response.status_code == 201
    assert captured["access_token"] == "venue-token"
    assert isinstance(captured["request"], VenueCreateRequest)
    assert captured["request"].name == VALID_VENUE["name"]
    assert captured["request"].layouts[0].capacity == 150


def test_non_venue_staff_cannot_create_a_venue(
    client, monkeypatch, organiser_profile
):
    monkeypatch.setattr(auth_service, "get_user_id", lambda access_token: organiser_profile.id)
    monkeypatch.setattr(
        auth_service,
        "get_profile",
        lambda access_token, user_id: organiser_profile,
    )
    monkeypatch.setattr(
        venue_service,
        "create_venue",
        lambda access_token, request: (_ for _ in ()).throw(
            AssertionError("the venue service should not be reached")
        ),
    )

    response = client.post(
        "/venues",
        json=VALID_VENUE,
        headers={"Authorization": "Bearer organiser-token"},
    )

    assert response.status_code == 403
    assert response.get_json()["error"] == "Only Venue Staff can create venues."


def test_create_venue_without_a_bearer_token_is_rejected(client):
    response = client.post("/venues", json=VALID_VENUE)

    assert response.status_code == 401
    assert response.get_json()["error"] == "Missing bearer token."


def test_create_venue_with_an_invalid_token_is_rejected(client, monkeypatch):
    def reject_token(access_token):
        raise AuthError("Invalid or expired token.", status_code=401)

    monkeypatch.setattr(auth_service, "get_user_id", reject_token)

    response = client.post(
        "/venues",
        json=VALID_VENUE,
        headers={"Authorization": "Bearer expired-token"},
    )

    assert response.status_code == 401
    assert response.get_json()["error"] == "Invalid or expired token."


def test_create_venue_reports_duplicate_name(
    client, monkeypatch
):
    authenticate_as_venue_staff(monkeypatch)
    monkeypatch.setattr(
        venue_service,
        "create_venue",
        lambda access_token, request: (_ for _ in ()).throw(
            AuthError(
                "A venue with this name already exists.",
                status_code=409,
            )
        ),
    )

    response = client.post(
        "/venues",
        json=VALID_VENUE,
        headers={"Authorization": "Bearer venue-token"},
    )

    assert response.status_code == 409
    assert response.get_json()["error"] == "A venue with this name already exists."


def test_create_venue_rejects_invalid_request_data(client, monkeypatch):
    authenticate_as_venue_staff(monkeypatch)
    monkeypatch.setattr(
        venue_service,
        "create_venue",
        lambda access_token, request: (_ for _ in ()).throw(
            AssertionError("the venue service should not be reached")
        ),
    )

    response = client.post(
        "/venues",
        json={
            **VALID_VENUE,
            "capacity": 0,
            "layouts": [],
        },
        headers={"Authorization": "Bearer venue-token"},
    )

    assert response.status_code == 400
    assert response.get_json()["errors"]
    assert all(isinstance(message, str) for message in response.get_json()["errors"])


def test_venue_layout_capacity_equal_to_overall_capacity_is_valid():
    request = VenueCreateRequest(
        **{
            **VALID_VENUE,
            "capacity": 200,
            "layouts": [{"name": "Theatre", "capacity": 200}],
        }
    )

    assert request.layouts[0].capacity == 200


def test_venue_layout_capacity_below_overall_capacity_is_valid():
    request = VenueCreateRequest(
        **{
            **VALID_VENUE,
            "capacity": 200,
            "layouts": [{"name": "Theatre", "capacity": 199}],
        }
    )

    assert request.layouts[0].capacity == 199


def test_venue_layout_capacity_above_overall_capacity_is_rejected():
    with pytest.raises(ValidationError, match="layout capacity cannot exceed"):
        VenueCreateRequest(
            **{
                **VALID_VENUE,
                "capacity": 200,
                "layouts": [{"name": "Theatre", "capacity": 201}],
            }
        )


def test_any_layout_capacity_above_overall_capacity_is_rejected():
    with pytest.raises(ValidationError, match="layout capacity cannot exceed"):
        VenueCreateRequest(
            **{
                **VALID_VENUE,
                "capacity": 200,
                "layouts": [
                    {"name": "Theatre", "capacity": 199},
                    {"name": "Banquet", "capacity": 201},
                ],
            }
        )


def test_edit_request_uses_the_same_layout_capacity_rule():
    with pytest.raises(ValidationError, match="layout capacity cannot exceed"):
        VenueUpdateRequest(
            **{
                **VALID_VENUE,
                "capacity": 200,
                "layouts": [{"name": "Theatre", "capacity": 201}],
            }
        )


def test_venue_staff_can_update_a_valid_venue(client, monkeypatch):
    authenticate_as_venue_staff(monkeypatch)
    captured = {}

    def update_venue(access_token, venue_id, request):
        captured["access_token"] = access_token
        captured["venue_id"] = venue_id
        captured["request"] = request
        return Venue(
            **{
                **VALID_VENUE,
                "id": VENUE_RESPONSE.id,
                "name": "Updated Hall",
                "capacity": 250,
            }
        )

    monkeypatch.setattr(venue_service, "update_venue", update_venue)

    response = client.put(
        f"/venues/{VENUE_RESPONSE.id}",
        json={
            **VALID_VENUE,
            "name": "Updated Hall",
            "capacity": 250,
        },
        headers={"Authorization": "Bearer venue-token"},
    )

    assert response.status_code == 200
    assert response.get_json()["venue"]["name"] == "Updated Hall"
    assert captured["access_token"] == "venue-token"
    assert captured["venue_id"] == VENUE_RESPONSE.id
    assert isinstance(captured["request"], VenueUpdateRequest)
    assert captured["request"].capacity == 250


def test_update_venue_rejects_invalid_request_data(client, monkeypatch):
    authenticate_as_venue_staff(monkeypatch)
    monkeypatch.setattr(
        venue_service,
        "update_venue",
        lambda access_token, venue_id, request: (_ for _ in ()).throw(
            AssertionError("the venue service should not be reached")
        ),
    )

    response = client.put(
        f"/venues/{VENUE_RESPONSE.id}",
        json={**VALID_VENUE, "capacity": 0, "layouts": []},
        headers={"Authorization": "Bearer venue-token"},
    )

    assert response.status_code == 400
    assert response.get_json()["errors"]


def test_non_venue_staff_cannot_update_a_venue(client, monkeypatch, organiser_profile):
    monkeypatch.setattr(auth_service, "get_user_id", lambda access_token: organiser_profile.id)
    monkeypatch.setattr(
        auth_service,
        "get_profile",
        lambda access_token, user_id: organiser_profile,
    )
    monkeypatch.setattr(
        venue_service,
        "update_venue",
        lambda access_token, venue_id, request: (_ for _ in ()).throw(
            AssertionError("the venue service should not be reached")
        ),
    )

    response = client.put(
        f"/venues/{VENUE_RESPONSE.id}",
        json=VALID_VENUE,
        headers={"Authorization": "Bearer organiser-token"},
    )

    assert response.status_code == 403
    assert response.get_json()["error"] == "Only Venue Staff can create venues."


def test_venue_staff_can_retrieve_venue_history(client, monkeypatch):
    authenticate_as_venue_staff(monkeypatch)
    captured = {}

    def get_venue_history(access_token, venue_id):
        captured["access_token"] = access_token
        captured["venue_id"] = venue_id
        return [HISTORY_RESPONSE]

    monkeypatch.setattr(venue_service, "get_venue_history", get_venue_history)

    response = client.get(
        f"/venues/{VENUE_RESPONSE.id}/history",
        headers={"Authorization": "Bearer venue-token"},
    )

    assert response.status_code == 200
    assert response.get_json()["history"] == [
        HISTORY_RESPONSE.model_dump(mode="json")
    ]
    assert captured == {
        "access_token": "venue-token",
        "venue_id": VENUE_RESPONSE.id,
    }


def test_venue_history_returns_empty_list(client, monkeypatch):
    authenticate_as_venue_staff(monkeypatch)
    monkeypatch.setattr(
        venue_service,
        "get_venue_history",
        lambda access_token, venue_id: [],
    )

    response = client.get(
        f"/venues/{VENUE_RESPONSE.id}/history",
        headers={"Authorization": "Bearer venue-token"},
    )

    assert response.status_code == 200
    assert response.get_json() == {"history": []}


def test_non_venue_staff_cannot_retrieve_venue_history(
    client, monkeypatch, organiser_profile
):
    monkeypatch.setattr(
        auth_service,
        "get_user_id",
        lambda access_token: organiser_profile.id,
    )
    monkeypatch.setattr(
        auth_service,
        "get_profile",
        lambda access_token, user_id: organiser_profile,
    )
    monkeypatch.setattr(
        venue_service,
        "get_venue_history",
        lambda access_token, venue_id: (_ for _ in ()).throw(
            AssertionError("the venue service should not be reached")
        ),
    )

    response = client.get(
        f"/venues/{VENUE_RESPONSE.id}/history",
        headers={"Authorization": "Bearer organiser-token"},
    )

    assert response.status_code == 403
    assert response.get_json()["error"] == "Only Venue Staff can create venues."


def test_venue_history_without_a_bearer_token_is_rejected(client):
    response = client.get(f"/venues/{VENUE_RESPONSE.id}/history")

    assert response.status_code == 401
    assert response.get_json()["error"] == "Missing bearer token."


def test_venue_history_with_an_invalid_token_is_rejected(client, monkeypatch):
    def reject_token(access_token):
        raise AuthError("Invalid or expired token.", status_code=401)

    monkeypatch.setattr(auth_service, "get_user_id", reject_token)

    response = client.get(
        f"/venues/{VENUE_RESPONSE.id}/history",
        headers={"Authorization": "Bearer invalid-token"},
    )

    assert response.status_code == 401
    assert response.get_json()["error"] == "Invalid or expired token."


def test_venue_history_resolves_names_with_one_profile_query(monkeypatch):
    calls = []

    class FakeQuery:
        def __init__(self, table_name):
            self.table_name = table_name

        def select(self, fields):
            calls.append((self.table_name, "select", fields))
            return self

        def eq(self, field, value):
            calls.append((self.table_name, "eq", field, value))
            return self

        def order(self, field, desc=False):
            calls.append((self.table_name, "order", field, desc))
            return self

        def in_(self, field, values):
            calls.append((self.table_name, "in", field, values))
            return self

        def execute(self):
            if self.table_name == "venue_edit_history":
                return SimpleNamespace(
                    data=[HISTORY_RESPONSE.model_dump(mode="json")]
                )
            return SimpleNamespace(
                data=[{
                    "id": VENUE_STAFF_PROFILE.id,
                    "full_name": VENUE_STAFF_PROFILE.full_name,
                }]
            )

    class FakeClient:
        def table(self, table_name):
            return FakeQuery(table_name)

    monkeypatch.setattr(
        "config.get_user_client",
        lambda access_token: FakeClient(),
    )

    history = venue_service.get_venue_history("venue-token", VENUE_RESPONSE.id)

    assert history[0].changed_by_name == "Venue Staff"
    assert sum(call[0] == "profiles" and call[1] == "select" for call in calls) == 1
    assert sum(call[0] == "profiles" and call[1] == "in" for call in calls) == 1


def test_venue_history_uses_unknown_user_when_profile_is_missing(monkeypatch):
    class FakeQuery:
        def __init__(self, table_name):
            self.table_name = table_name

        def select(self, fields):
            return self

        def eq(self, field, value):
            return self

        def order(self, field, desc=False):
            return self

        def in_(self, field, values):
            return self

        def execute(self):
            if self.table_name == "venue_edit_history":
                return SimpleNamespace(
                    data=[HISTORY_RESPONSE.model_dump(mode="json")]
                )
            return SimpleNamespace(data=[])

    class FakeClient:
        def table(self, table_name):
            return FakeQuery(table_name)

    monkeypatch.setattr(
        "config.get_user_client",
        lambda access_token: FakeClient(),
    )

    history = venue_service.get_venue_history("venue-token", VENUE_RESPONSE.id)

    assert history[0].changed_by_name == "Unknown user"


def test_authenticated_user_can_retrieve_venues(client, monkeypatch):
    authenticate_as_venue_staff(monkeypatch)
    monkeypatch.setattr(
        venue_service,
        "list_venues",
        lambda access_token: [VENUE_RESPONSE],
    )

    response = client.get(
        "/venues",
        headers={"Authorization": "Bearer venue-token"},
    )

    assert response.status_code == 200
    assert response.get_json()["venues"] == [
        VENUE_RESPONSE.model_dump(mode="json")
    ]
