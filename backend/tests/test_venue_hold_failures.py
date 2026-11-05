"""Hold response validation and expiry delivery failures remain fail closed."""

from unittest.mock import Mock

import pytest
from httpx import ReadTimeout
from postgrest import APIError

import config
from models.venue_hold import VenueHoldCreateRequest
from services import venue_hold_service as holds
from services.auth_service import AuthError
from test_venue_holds import database, PAYLOAD, STORED, VENUE


@pytest.mark.parametrize("records", [None, {}, [{}], [{"id": "event"}], [None], ["invalid"]])
def test_hold_choices_reject_incomplete_responses(database, records):
    database.rpc.return_value.execute.return_value.data = records
    with pytest.raises(AuthError, match="Unable to load events for a hold") as caught:
        holds.list_hold_events("token")
    assert caught.value.status_code == 502


@pytest.mark.parametrize("failure,status", [
    (APIError({"code": "42501", "message": "private SQL"}), 403),
    (APIError({"code": "XX000", "message": "private SQL"}), 502),
    (ReadTimeout("network failed"), 502),
])
def test_hold_choices_translate_failures_without_disclosing_database_details(database, failure, status):
    database.rpc.return_value.execute.side_effect = failure
    with pytest.raises(AuthError) as caught:
        holds.list_hold_events("token")
    assert caught.value.status_code == status
    assert caught.value.__cause__ is failure
    assert "private SQL" not in caught.value.message


def test_hold_choices_accept_an_empty_authorised_list(database):
    assert holds.list_hold_events("token") == []
    database.rpc.assert_called_once_with("get_venue_hold_events")


@pytest.mark.parametrize("record", [
    None, [], {}, {**STORED, "event_name": ""}, {**STORED, "coordinator_id": "invalid"},
    {**STORED, "expires_at": "2099-11-06T12:00:00"},
])
def test_unverified_creation_response_does_not_notify_or_claim_success(database, monkeypatch, record):
    database.rpc.return_value.execute.return_value.data = record
    sender = Mock()
    monkeypatch.setattr(holds, "notify", sender)
    with pytest.raises(AuthError, match="Hold creation unconfirmed. Refresh") as caught:
        holds.create_hold("token", VENUE, VenueHoldCreateRequest(**PAYLOAD))
    assert caught.value.status_code == 502
    sender.assert_not_called()
    assert database.rpc.call_count == 1


@pytest.mark.parametrize("records", [None, {}])
def test_expiry_runner_refuses_incomplete_claim_response(database, monkeypatch, records):
    database.rpc.return_value.execute.return_value.data = records
    sender = Mock()
    monkeypatch.setattr(holds, "notify", sender)
    with pytest.raises(AuthError, match="Unable to process expired holds") as caught:
        holds.process_expired_holds(database)
    assert caught.value.status_code == 502
    sender.assert_not_called()
    assert database.rpc.call_count == 1


def test_expiry_runner_skips_holds_without_a_coordinator(database, monkeypatch):
    database.rpc.return_value.execute.return_value.data = [{**STORED, "coordinator_id": None}]
    sender = Mock()
    monkeypatch.setattr(holds, "notify", sender)
    assert holds.process_expired_holds(database) == 0
    sender.assert_not_called()
    database.rpc.assert_called_once_with("claim_expired_venue_holds")


def test_expiry_runner_uses_admin_client_only_when_none_supplied(database, monkeypatch):
    factory = Mock(return_value=database)
    monkeypatch.setattr(config, "get_admin_client", factory)
    assert holds.process_expired_holds() == 0
    factory.assert_called_once_with()
    database.rpc.assert_called_once_with("claim_expired_venue_holds")


def test_expiry_acknowledgement_failure_is_not_reported_as_success(database, monkeypatch):
    record = {**STORED, "expiry_claimed_at": "2099-11-06T04:01Z"}
    failure = APIError({"code": "XX000", "message": "acknowledgement failed"})
    database.rpc.return_value.execute.side_effect = [Mock(data=[record]), failure]
    sender = Mock(return_value=object())
    monkeypatch.setattr(holds, "notify", sender)
    with pytest.raises(APIError) as caught:
        holds.process_expired_holds(database)
    assert caught.value is failure
    sender.assert_called_once()
    database.rpc.assert_called_with("acknowledge_venue_hold_expiry", {
        "p_hold_id": record["hold_id"], "p_claim": record["expiry_claimed_at"],
    })
    assert database.rpc.call_count == 2
    assert sender.call_args.kwargs["user_id"] == record["coordinator_id"]
    assert sender.call_args.kwargs["event_id"] == record["event_id"]
