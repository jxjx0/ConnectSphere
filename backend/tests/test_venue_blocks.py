"""Tests for venue block validation, endpoints, and persistence service."""

from types import SimpleNamespace
import pytest
from postgrest import APIError as PostgrestAPIError
from pydantic import ValidationError

from models.profile import Profile, Role
from models.venue import Venue
from models.venue_block import VenueBlockCreateRequest
from services import auth_service, venue_block_service
from services.auth_service import AuthError


VENUE_ID = "33333333-3333-3333-3333-333333333333"
BLOCK_ID = "55555555-5555-5555-5555-555555555555"

VENUE_STAFF_PROFILE = Profile(
    id="22222222-2222-2222-2222-222222222222",
    full_name="Venue Staff",
    role=Role.VENUE_STAFF,
)

VALID_BLOCK_PAYLOAD = {
    "start_at": "2026-10-01T09:00:00Z",
    "end_at": "2026-10-01T17:00:00Z",
    "block_reason": "Scheduled maintenance",
}

BLOCK_RECORD = {
    "id": BLOCK_ID,
    "venue_id": VENUE_ID,
    "start_at": "2026-10-01T09:00:00+00:00",
    "end_at": "2026-10-01T17:00:00+00:00",
    "block_reason": "Scheduled maintenance",
    "block_issuer": VENUE_STAFF_PROFILE.id,
}


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


# ============================================================================
# 1. Model Validation Tests (VenueBlockCreateRequest)
# ============================================================================

def test_venue_block_request_valid_data():
    request = VenueBlockCreateRequest(**VALID_BLOCK_PAYLOAD)
    assert request.block_reason == "Scheduled maintenance"
    assert request.start_at < request.end_at


def test_venue_block_request_strips_reason_whitespace():
    payload = {**VALID_BLOCK_PAYLOAD, "block_reason": "  Maintenance  "}
    request = VenueBlockCreateRequest(**payload)
    assert request.block_reason == "Maintenance"


def test_venue_block_request_rejects_blank_reason():
    payload = {**VALID_BLOCK_PAYLOAD, "block_reason": "   "}
    with pytest.raises(ValidationError, match="block reason must not be blank"):
        VenueBlockCreateRequest(**payload)


def test_venue_block_request_rejects_start_time_equal_to_end_time():
    same_time = "2026-10-01T09:00:00Z"
    payload = {**VALID_BLOCK_PAYLOAD, "start_at": same_time, "end_at": same_time}
    with pytest.raises(ValidationError, match="block end time must be after start time"):
        VenueBlockCreateRequest(**payload)


def test_venue_block_request_rejects_start_time_after_end_time():
    payload = {
        **VALID_BLOCK_PAYLOAD,
        "start_at": "2026-10-01T18:00:00Z",
        "end_at": "2026-10-01T09:00:00Z",
    }
    with pytest.raises(ValidationError, match="block end time must be after start time"):
        VenueBlockCreateRequest(**payload)


# ============================================================================
# 2. HTTP Route Tests (POST /venues/<venue_id>/blocks)
# ============================================================================

def test_venue_staff_can_create_venue_block(client, monkeypatch):
    authenticate_as_venue_staff(monkeypatch)
    captured = {}

    def create_venue_block(access_token, venue_id, request, block_issuer):
        captured["access_token"] = access_token
        captured["venue_id"] = venue_id
        captured["request"] = request
        captured["block_issuer"] = block_issuer
        return BLOCK_RECORD

    monkeypatch.setattr(venue_block_service, "create_venue_block", create_venue_block)

    response = client.post(
        f"/venues/{VENUE_ID}/blocks",
        json=VALID_BLOCK_PAYLOAD,
        headers={"Authorization": "Bearer venue-token"},
    )

    assert response.status_code == 201
    assert response.get_json()["block"]["id"] == BLOCK_ID
    assert captured["access_token"] == "venue-token"
    assert captured["venue_id"] == VENUE_ID
    assert captured["block_issuer"] == VENUE_STAFF_PROFILE.id
    assert isinstance(captured["request"], VenueBlockCreateRequest)


def test_create_venue_block_rejects_invalid_json(client, monkeypatch):
    authenticate_as_venue_staff(monkeypatch)
    monkeypatch.setattr(
        venue_block_service,
        "create_venue_block",
        lambda **kwargs: (_ for _ in ()).throw(
            AssertionError("venue block service should not be reached")
        ),
    )

    response = client.post(
        f"/venues/{VENUE_ID}/blocks",
        json={
            "start_at": "2026-10-01T10:00:00Z",
            "end_at": "2026-10-01T09:00:00Z",
            "block_reason": "Maintenance",  # Added to allow model-level validation to run
        },
        headers={"Authorization": "Bearer venue-token"},
    )

    assert response.status_code == 400
    errors = response.get_json()["errors"]
    assert len(errors) > 0
    assert any("block end time must be after start time" in err for err in errors)

def test_non_venue_staff_cannot_create_venue_block(
    client, monkeypatch, organiser_profile
):
    monkeypatch.setattr(auth_service, "get_user_id", lambda access_token: organiser_profile.id)
    monkeypatch.setattr(
        auth_service,
        "get_profile",
        lambda access_token, user_id: organiser_profile,
    )
    monkeypatch.setattr(
        venue_block_service,
        "create_venue_block",
        lambda **kwargs: (_ for _ in ()).throw(
            AssertionError("venue block service should not be reached")
        ),
    )

    response = client.post(
        f"/venues/{VENUE_ID}/blocks",
        json=VALID_BLOCK_PAYLOAD,
        headers={"Authorization": "Bearer organiser-token"},
    )

    assert response.status_code == 403
    assert response.get_json()["error"] == "Only Venue Staff can create venues."


def test_create_venue_block_without_token_is_rejected(client):
    response = client.post(f"/venues/{VENUE_ID}/blocks", json=VALID_BLOCK_PAYLOAD)

    assert response.status_code == 401
    assert response.get_json()["error"] == "Missing bearer token."


# ============================================================================
# 3. Persistence & Service Tests (venue_block_service)
# ============================================================================

def test_service_create_venue_block_success(monkeypatch):
    captured_data = {}

    class FakeQuery:
        def insert(self, data):
            captured_data.update(data)
            return self

        def execute(self):
            return SimpleNamespace(data=[BLOCK_RECORD])

    class FakeClient:
        def table(self, table_name):
            assert table_name == "venue_blocks"
            return FakeQuery()

    monkeypatch.setattr(
        "config.get_user_client",
        lambda access_token: FakeClient(),
    )

    request = VenueBlockCreateRequest(**VALID_BLOCK_PAYLOAD)
    result = venue_block_service.create_venue_block(
        access_token="venue-token",
        venue_id=VENUE_ID,
        request=request,
        block_issuer=VENUE_STAFF_PROFILE.id,
    )

    assert result == BLOCK_RECORD
    assert captured_data["venue_id"] == VENUE_ID
    assert captured_data["block_issuer"] == VENUE_STAFF_PROFILE.id
    assert captured_data["block_reason"] == "Scheduled maintenance"


@pytest.mark.parametrize(
    "error_code,expected_status,expected_message",
    [
        ("23514", 400, "Venue block data violates a database validation rule."),
        ("23503", 400, "The specified venue or block issuer does not exist."),
        ("42501", 403, "You do not have permission to create a venue block."),
        ("PGRST301", 403, "You do not have permission to create a venue block."),
        ("99999", 502, "Unable to create the venue block."),
    ],
)
def test_service_create_venue_block_error_mapping(
    monkeypatch, error_code, expected_status, expected_message
):
    class FakeQuery:
        def insert(self, data):
            return self

        def execute(self):
            raise PostgrestAPIError({"code": error_code, "message": "Database error"})

    class FakeClient:
        def table(self, table_name):
            return FakeQuery()

    monkeypatch.setattr(
        "config.get_user_client",
        lambda access_token: FakeClient(),
    )

    request = VenueBlockCreateRequest(**VALID_BLOCK_PAYLOAD)
    with pytest.raises(AuthError) as exc_info:
        venue_block_service.create_venue_block(
            access_token="venue-token",
            venue_id=VENUE_ID,
            request=request,
            block_issuer=VENUE_STAFF_PROFILE.id,
        )

    assert exc_info.value.status_code == expected_status
    assert exc_info.value.message == expected_message


def test_service_create_venue_block_empty_response_raises_502(monkeypatch):
    class FakeQuery:
        def insert(self, data):
            return self

        def execute(self):
            return SimpleNamespace(data=[])

    class FakeClient:
        def table(self, table_name):
            return FakeQuery()

    monkeypatch.setattr(
        "config.get_user_client",
        lambda access_token: FakeClient(),
    )

    request = VenueBlockCreateRequest(**VALID_BLOCK_PAYLOAD)
    with pytest.raises(AuthError) as exc_info:
        venue_block_service.create_venue_block(
            access_token="venue-token",
            venue_id=VENUE_ID,
            request=request,
            block_issuer=VENUE_STAFF_PROFILE.id,
        )

    assert exc_info.value.status_code == 502
    assert exc_info.value.message == "Venue block was not created."