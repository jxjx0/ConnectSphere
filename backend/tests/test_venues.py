"""Tests for the protected venue catalogue endpoints."""

from unittest.mock import Mock

from models.profile import Profile, Role
from models.venue import Venue, VenueCreateRequest, VenueUpdateRequest, VenueUpdateResult
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


def test_saved_venue_with_unavailable_impact_is_a_successful_update(client, monkeypatch):
    authenticate_as_venue_staff(monkeypatch)
    impact = {"status": "unavailable", "affected_bookings": None}
    saved = VenueUpdateResult(**VENUE_RESPONSE.model_dump(), buffer_impact=impact)
    monkeypatch.setattr(venue_service, "update_venue", lambda *_: saved)
    response = client.put(f"/venues/{VENUE_RESPONSE.id}", json=VALID_VENUE,
                          headers={"Authorization": "Bearer venue-token"})
    assert response.status_code == 200
    assert response.get_json() == {"venue": VENUE_RESPONSE.model_dump(mode="json"), "buffer_impact": impact}


def test_create_venue_passes_validated_request_to_service(client, monkeypatch):
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
    assert response.get_json()["venue"] == VENUE_RESPONSE.model_dump(mode="json")
    assert captured["access_token"] == "venue-token"
    assert isinstance(captured["request"], VenueCreateRequest)
    assert captured["request"].name == VALID_VENUE["name"]
    assert captured["request"].layouts[0].capacity == 150


def test_non_venue_staff_cannot_create_a_venue(
    client, monkeypatch, organiser_profile
):
    monkeypatch.setattr(
        auth_service, "get_user_id", lambda access_token: organiser_profile.id
    )
    monkeypatch.setattr(
        auth_service,
        "get_profile",
        lambda access_token, user_id: organiser_profile,
    )
    monkeypatch.setattr(
        venue_service,
        "create_venue",
        Mock(side_effect=AssertionError("the venue service should not be reached")),
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


def test_create_venue_reports_duplicate_name(client, monkeypatch):
    authenticate_as_venue_staff(monkeypatch)
    monkeypatch.setattr(
        venue_service,
        "create_venue",
        Mock(
            side_effect=AuthError(
                "A venue with this name already exists.",
                status_code=409,
            ),
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
        Mock(side_effect=AssertionError("the venue service should not be reached")),
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
        Mock(side_effect=AssertionError("the venue service should not be reached")),
    )

    response = client.put(
        f"/venues/{VENUE_RESPONSE.id}",
        json={**VALID_VENUE, "capacity": 0, "layouts": []},
        headers={"Authorization": "Bearer venue-token"},
    )

    assert response.status_code == 400
    assert response.get_json()["errors"]


def test_non_venue_staff_cannot_update_a_venue(client, monkeypatch, organiser_profile):
    monkeypatch.setattr(
        auth_service, "get_user_id", lambda access_token: organiser_profile.id
    )
    monkeypatch.setattr(
        auth_service,
        "get_profile",
        lambda access_token, user_id: organiser_profile,
    )
    monkeypatch.setattr(
        venue_service,
        "update_venue",
        Mock(side_effect=AssertionError("the venue service should not be reached")),
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
        Mock(side_effect=AssertionError("the venue service should not be reached")),
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
