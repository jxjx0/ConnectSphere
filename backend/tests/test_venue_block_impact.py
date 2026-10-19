"""Real impact-service wiring with mocked persistence/notification boundaries."""

from copy import deepcopy
from unittest.mock import Mock, call
from types import SimpleNamespace

import pytest
from httpx import ReadTimeout
from postgrest import APIError

import config
from models.venue_block import VenueBlockCreateRequest
from models.profile import Profile, Role
from services import auth_service
from services import venue_block_service as blocks


BOOKING = {
    "booking_id": "booking-1", "venue_id": "hall", "venue_name": "Hall",
    "event_id": "event-1", "event_name": "Workshop", "coordinator_id": "current-coordinator",
    "status": "APPROVED", "start_at": "2026-11-07T10:00:00+08:00",
    "end_at": "2026-11-07T12:00:00+08:00",
    "setup_time_minutes": 30, "turnaround_time_minutes": 45,
}


@pytest.fixture
def dependencies(monkeypatch):
    records = [deepcopy(BOOKING)]
    client = Mock()
    write = Mock()
    write.execute.side_effect = lambda: SimpleNamespace(data=[
        {"booking_id": identity, "status": "AFFECTED_BY_UNAVAILABILITY"}
        for identity in client.rpc.call_args.args[1]["p_booking_ids"]
    ])
    def rpc(name, params):
        if name == "get_venue_block_bookings":
            read = Mock()
            read.execute.return_value.data = records
            return read
        assert name == "mark_venue_block_bookings_affected"
        return write
    client.rpc.side_effect = rpc
    client.status_write = write
    factory = Mock(return_value=client)
    notification = Mock(return_value=object())
    monkeypatch.setattr(config, "get_user_client", factory)
    monkeypatch.setattr(blocks, "notify", notification)
    return client, records, notification, factory


def block(start="09:15", end="09:45", date="2026-11-07", end_date=None):
    return VenueBlockCreateRequest(
        start_at=f"{date}T{start}:00+08:00",
        end_at=f"{end_date or date}T{end}:00+08:00", block_reason="Maintenance",
    )


@pytest.mark.parametrize("start,end,count", [
    ("09:15", "09:45", 1),  # Setup overlap only.
    ("12:30", "13:00", 1),  # Turnaround overlap only.
    ("10:30", "11:00", 1),
    ("09:00", "09:30", 0),  # Exact touching is allowed.
    ("12:45", "13:00", 0),
    ("13:00", "14:00", 0),
])
def test_impact_uses_configured_effective_period_and_half_open_boundaries(dependencies, start, end, count):
    client, records, notification, factory = dependencies
    original = deepcopy(records)
    result = blocks.check_booking_impact("staff-token", "hall", block(start, end))
    assert result["status"] == "verified"
    assert len(result["affected_bookings"]) == count
    assert notification.call_count == count
    factory.assert_called_once_with("staff-token")
    expected = [call("get_venue_block_bookings", {"p_venue_id": "hall"})]
    if count:
        expected.append(call("mark_venue_block_bookings_affected", {
            "p_venue_id": "hall", "p_booking_ids": ["booking-1"],
        }))
    assert client.rpc.call_args_list == expected
    client.table.assert_not_called()  # No direct table writes; status-only RPC is separately tested.
    assert records == original
    if count:
        affected = result["affected_bookings"][0]
        assert affected["effective_start"] == "2026-11-07T09:30:00+08:00"
        assert affected["effective_end"] == "2026-11-07T12:45:00+08:00"
        assert affected["notification_status"] == "saved"
        assert affected["status_update"] == "updated"


@pytest.mark.parametrize("end_date", [None, "2026-11-08"])
def test_notification_targets_projection_current_coordinator_and_links_event(dependencies, end_date):
    _, _, notification, _ = dependencies
    blocks.check_booking_impact("token", "hall", block(end_date=end_date))
    args = notification.call_args.kwargs
    assert args["user_id"] == "current-coordinator"
    assert args["event_id"] == "event-1"
    assert args["notification_type"] == "venue_booking_affected"
    assert args["title"] == "Venue unavailable"
    for text in ["Hall", "Workshop", "Maintenance", "09:15", "09:45", "Singapore time", "Please arrange another venue"]:
        assert text in args["body"]
    assert args["body"].count("07 Nov 2026") == 1
    assert ("08 Nov 2026" in args["body"]) is (end_date is not None)
    assert "preserved" not in args["body"]
    assert "setup/turnaround" not in args["body"]


@pytest.mark.parametrize("setup,turnaround,count", [(0, 0, 0), (30, 0, 1), (0, 45, 0)])
def test_zero_and_positive_venue_durations_are_not_added_twice(dependencies, setup, turnaround, count):
    _, records, notification, _ = dependencies
    records[0].update(setup_time_minutes=setup, turnaround_time_minutes=turnaround,
                      effective_start_at="2026-11-07T09:00:00+08:00")
    result = blocks.check_booking_impact("token", "hall", block())
    assert len(result["affected_bookings"]) == count
    assert notification.call_count == count


def test_multi_date_booking_and_overnight_buffer_are_included(dependencies):
    _, records, _, _ = dependencies
    records[0].update(start_at="2026-11-08T00:15:00+08:00", end_at="2026-11-09T12:00:00+08:00")
    result = blocks.check_booking_impact("token", "hall", block("23:40", "23:55"))
    assert len(result["affected_bookings"]) == 1
    assert result["affected_bookings"][0]["effective_start"].startswith("2026-11-07T23:45")


def test_notification_failure_keeps_identified_bookings_and_reports_partial(dependencies):
    _, _, notification, _ = dependencies
    notification.return_value = None
    result = blocks.check_booking_impact("token", "hall", block())
    assert result["status"] == "partial"
    assert result["affected_bookings"][0]["notification_status"] == "failed"


def test_unassigned_event_does_not_notify_an_old_booking_submitter(dependencies):
    _, records, notification, _ = dependencies
    records[0]["coordinator_id"] = None
    result = blocks.check_booking_impact("token", "hall", block())
    assert result["status"] == "partial"
    assert result["affected_bookings"][0]["notification_status"] == "missing_coordinator"
    notification.assert_not_called()


@pytest.mark.parametrize("error_code", ["PGRST202", "42501", "99999"])
def test_missing_rpc_permissions_or_database_error_is_not_verified_empty(dependencies, error_code):
    client, _, notification, _ = dependencies
    client.rpc.side_effect = APIError({"code": error_code, "message": "internal"})
    assert blocks.check_booking_impact("token", "hall", block()) == {
        "status": "unavailable", "affected_bookings": None,
    }
    notification.assert_not_called()


@pytest.mark.parametrize("changes", [
    {"setup_time_minutes": None}, {"turnaround_time_minutes": -1},
    {"setup_time_minutes": 1.5}, {"setup_time_minutes": True},
    {"start_at": "2026-11-07T10:00:00"}, {"end_at": "invalid"},
    {"venue_id": "other-hall"}, {"status": "CANCELLED"},
])
def test_invalid_or_wrong_venue_projection_cannot_claim_verification(dependencies, changes):
    _, records, notification, _ = dependencies
    records[0].update(changes)
    assert blocks.check_booking_impact("token", "hall", block())["status"] == "unavailable"
    notification.assert_not_called()


def test_all_records_are_validated_before_sending_any_notification(dependencies):
    _, records, notification, _ = dependencies
    records.append({**BOOKING, "booking_id": "bad", "setup_time_minutes": None})
    assert blocks.check_booking_impact("token", "hall", block())["status"] == "unavailable"
    notification.assert_not_called()


def test_empty_authoritative_result_is_verified_empty(dependencies):
    _, records, notification, _ = dependencies
    records.clear()
    assert blocks.check_booking_impact("token", "hall", block()) == {
        "status": "verified", "affected_bookings": [],
    }
    notification.assert_not_called()


def test_duplicate_booking_projection_is_not_notified_twice(dependencies):
    _, records, notification, _ = dependencies
    records.append(deepcopy(BOOKING))
    assert blocks.check_booking_impact("token", "hall", block())["status"] == "unavailable"
    notification.assert_not_called()


@pytest.mark.parametrize("response", [None, {}, "[]"])
def test_missing_or_malformed_projection_is_not_verified_empty(dependencies, response):
    client, _, notification, _ = dependencies
    client.rpc.side_effect = lambda *args: Mock(execute=Mock(return_value=SimpleNamespace(data=response)))
    assert blocks.check_booking_impact("token", "hall", block())["status"] == "unavailable"
    notification.assert_not_called()


@pytest.mark.parametrize("failure", [None, "notification", "read"])
def test_route_saves_block_checks_impact_and_reports_notification_outcome(
    dependencies, client, monkeypatch, failure,
):
    database, _, notification, _ = dependencies
    profile = Profile(id="staff", full_name="Venue Staff", role=Role.VENUE_STAFF)
    monkeypatch.setattr(auth_service, "get_user_id", lambda token: profile.id)
    monkeypatch.setattr(auth_service, "get_profile", lambda *args: profile)
    database.table.return_value.insert.return_value.execute.return_value.data = [{"block_id": "block-1"}]
    if failure == "notification":
        notification.return_value = None
    elif failure == "read":
        database.rpc.side_effect = ReadTimeout("internal")
    response = client.post("/venues/hall/blocks", json=block().model_dump(mode="json"),
                           headers={"Authorization": "Bearer staff-token"})
    assert response.status_code == 201
    outcome = response.get_json()
    assert outcome["block"] == {"block_id": "block-1"}
    assert outcome["booking_impact"]["status"] == {
        None: "verified", "notification": "partial", "read": "unavailable",
    }[failure]
    database.table.assert_called_once_with("venue_blocks")
    inserted = database.table.return_value.insert.call_args.args[0]
    assert inserted["venue_id"] == "hall"
    assert inserted["block_issuer"] == "staff"
    assert inserted["start_at"] == "2026-11-07T01:15:00+00:00"


def test_coordinator_cannot_invoke_block_impact_through_route(dependencies, client, monkeypatch):
    database, _, notification, factory = dependencies
    profile = Profile(id="coordinator", full_name="Coordinator", role=Role.COORDINATOR)
    monkeypatch.setattr(auth_service, "get_user_id", lambda token: profile.id)
    monkeypatch.setattr(auth_service, "get_profile", lambda *args: profile)
    response = client.post("/venues/hall/blocks", json=block().model_dump(mode="json"),
                           headers={"Authorization": "Bearer coordinator-token"})
    assert response.status_code == 403
    factory.assert_not_called()
    database.rpc.assert_not_called()
    notification.assert_not_called()


def test_block_is_saved_before_an_impact_read_failure_and_not_saved_again(dependencies, monkeypatch):
    client, _, _, _ = dependencies
    saved = {"block_id": "block-1", "venue_id": "hall"}
    create = Mock(return_value=saved)
    monkeypatch.setattr(blocks, "create_venue_block", create)
    client.rpc.side_effect = APIError({"code": "99999", "message": "internal"})
    result = blocks.create_venue_block_outcome("token", "hall", block(), "staff")
    assert result["block"] == saved
    assert result["booking_impact"]["status"] == "unavailable"
    create.assert_called_once()


def test_impact_network_timeout_does_not_turn_saved_block_into_failure(dependencies, monkeypatch):
    client, _, notification, _ = dependencies
    saved = {"block_id": "block-1"}
    monkeypatch.setattr(blocks, "create_venue_block", Mock(return_value=saved))
    client.rpc.side_effect = ReadTimeout("private connection details")
    result = blocks.create_venue_block_outcome("token", "hall", block(), "staff")
    assert result == {"block": saved, "booking_impact": {"status": "unavailable", "affected_bookings": None}}
    notification.assert_not_called()


def test_notification_failures_do_not_skip_other_affected_bookings(dependencies):
    _, records, notification, _ = dependencies
    records.append({**BOOKING, "booking_id": "booking-2", "event_id": "event-2"})
    notification.side_effect = [None, object()]
    result = blocks.check_booking_impact("token", "hall", block())
    assert result["status"] == "partial"
    assert [item["notification_status"] for item in result["affected_bookings"]] == ["failed", "saved"]
    assert notification.call_count == 2


def test_failed_block_creation_never_checks_impact_or_sends_notifications(dependencies, monkeypatch):
    client, _, notification, _ = dependencies
    from services.auth_service import AuthError

    monkeypatch.setattr(blocks, "create_venue_block", Mock(side_effect=AuthError("Unable to create block.", status_code=502)))
    with pytest.raises(AuthError):
        blocks.create_venue_block_outcome("token", "hall", block(), "staff")
    client.rpc.assert_not_called()
    notification.assert_not_called()


@pytest.mark.parametrize("failure", [APIError({"code": "42501", "message": "private"}), ReadTimeout("private")])
def test_failed_status_update_preserves_saved_block_and_still_warns_coordinator(dependencies, monkeypatch, failure):
    client, _, notification, _ = dependencies
    monkeypatch.setattr(blocks, "create_venue_block", Mock(return_value={"block_id": "saved"}))
    client.status_write.execute.side_effect = failure
    result = blocks.create_venue_block_outcome("token", "hall", block(), "staff")
    assert result["block"] == {"block_id": "saved"}
    impact = result["booking_impact"]
    assert impact["status"] == "partial"
    assert impact["affected_bookings"][0]["status_update"] == (
        "unverified" if isinstance(failure, ReadTimeout) else "failed"
    )
    assert impact["affected_bookings"][0]["notification_status"] == "saved"
    notification.assert_called_once()


@pytest.mark.parametrize("response", [None, {}, [{"booking_id": "other", "status": "AFFECTED_BY_UNAVAILABILITY"}]])
def test_unverified_update_response_is_never_reported_as_updated(dependencies, response):
    client, _, notification, _ = dependencies
    client.status_write.execute.side_effect = lambda: SimpleNamespace(data=response)
    impact = blocks.check_booking_impact("token", "hall", block())
    assert impact["status"] == "partial"
    assert impact["affected_bookings"][0]["status_update"] == "unverified"
    notification.assert_called_once()


def test_concurrently_changed_booking_is_not_overwritten_or_notified(dependencies):
    client, _, notification, _ = dependencies
    client.status_write.execute.side_effect = lambda: SimpleNamespace(data=[])
    impact = blocks.check_booking_impact("token", "hall", block())
    assert impact["status"] == "partial"
    assert impact["affected_bookings"][0]["status_update"] == "not_updated"
    assert impact["affected_bookings"][0]["notification_status"] == "not_required"
    notification.assert_not_called()


def test_status_changes_before_notification_and_is_not_reverted_when_notification_fails(dependencies):
    client, _, notification, _ = dependencies
    order = []
    write = client.status_write
    original_update = write.execute.side_effect
    def update():
        order.append("status")
        return original_update()
    def notify(**kwargs):
        order.append("notification")
        return None
    write.execute.side_effect = update
    notification.side_effect = notify
    impact = blocks.check_booking_impact("token", "hall", block())
    assert order == ["status", "notification"]
    assert impact["status"] == "partial"
    assert impact["affected_bookings"][0]["status_update"] == "updated"
    write.execute.assert_called_once()


def test_only_overlapping_approved_booking_ids_are_updated_in_one_batch(dependencies):
    client, records, _, _ = dependencies
    records.extend([
        {**BOOKING, "booking_id": "booking-2", "event_id": "other-event"},
        {**BOOKING, "booking_id": "later", "start_at": "2026-11-07T16:00:00+08:00",
         "end_at": "2026-11-07T17:00:00+08:00"},
    ])
    before = deepcopy(records)
    impact = blocks.check_booking_impact("token", "hall", block())
    write = client.status_write
    client.rpc.assert_any_call("mark_venue_block_bookings_affected", {
        "p_venue_id": "hall", "p_booking_ids": ["booking-1", "booking-2"],
    })
    write.execute.assert_called_once()
    assert len(impact["affected_bookings"]) == 2
    assert records == before  # Read snapshots, periods, event links and buffers are not rewritten.
