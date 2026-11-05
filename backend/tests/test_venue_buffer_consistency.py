"""Concurrent/incomplete occupancy projections cannot claim verified impact."""

from copy import deepcopy
from types import SimpleNamespace

import pytest

from services import venue_buffer_service as impact
from services.auth_service import AuthError
from services.venue_block_service import read_operational_blocks
from test_venue_availability import ReadClient, VENUE_ID, block, request
from test_venue_buffer_impact import database, save, timestamp


def transform_rpc(database, monkeypatch, transform):
    original = database.rpc

    def rpc(name, params):
        query = original(name, params)

        def execute():
            response = query.execute()
            response.data = transform(name, params, response.data)
            return response

        return SimpleNamespace(execute=execute)

    monkeypatch.setattr(database, "rpc", rpc)


@pytest.mark.parametrize("kind", ["missing_reservation", "changed_period", "wrong_hold_kind"])
def test_inconsistent_post_save_projection_preserves_saved_venue_without_flagging_bookings(database, monkeypatch, kind):
    booking = database.booking()

    def transform(name, params, rows):
        if kind == "missing_reservation" and name == "get_venue_reservations" and "update" in database.calls:
            return []
        if kind == "changed_period" and name == "get_venue_block_bookings":
            return [{**row, "start_at": timestamp("09:00")} for row in rows]
        if kind == "wrong_hold_kind" and name == "get_venue_reservations" and params["p_holds_only"]:
            return [database.reservation(booking)]
        return rows

    transform_rpc(database, monkeypatch, transform)
    result = save(database, 30)
    assert result.setup_time_minutes == database.venue["setup_time_minutes"] == 30
    assert result.buffer_impact == {"status": "unavailable", "affected_bookings": None}
    assert booking["status"] == "APPROVED"
    database.notify.assert_not_called()


def test_buffer_impact_ignores_expired_hold_even_if_returned_by_projection(database, monkeypatch):
    database.booking()
    database.hold("08:00", "09:45", expired=True)
    expired = deepcopy(database.holds[0])

    def transform(name, params, rows):
        return [expired] if name == "get_venue_reservations" and params["p_holds_only"] else rows

    transform_rpc(database, monkeypatch, transform)
    assert save(database, 30).buffer_impact == {"status": "verified", "affected_bookings": []}
    database.notify.assert_not_called()


def test_concurrent_booking_status_change_does_not_trigger_an_impact_notification(database, monkeypatch):
    booking = database.booking()
    database.block("09:15", "09:45")
    monkeypatch.setattr(impact, "mark_affected_bookings", lambda *args: {booking["booking_id"]: "not_updated"})
    result = save(database, 30)
    assert result.buffer_impact["status"] == "partial"
    (item,) = result.buffer_impact["affected_bookings"]
    assert item["status_update"] == "not_updated"
    assert item["notification_status"] == "not_required"
    database.notify.assert_not_called()


def test_missing_current_coordinator_is_reported_without_notifying_old_submitter(database, monkeypatch):
    database.booking()
    database.block("09:15", "09:45")

    def transform(name, params, rows):
        return [{**row, "coordinator_id": None} for row in rows] if name == "get_venue_block_bookings" else rows

    transform_rpc(database, monkeypatch, transform)
    result = save(database, 30)
    assert result.buffer_impact["status"] == "partial"
    (item,) = result.buffer_impact["affected_bookings"]
    assert item["status_update"] == "updated"
    assert item["notification_status"] == "missing_coordinator"
    database.notify.assert_not_called()


def test_duplicate_operational_blocks_cannot_produce_verified_availability():
    record = block("2026-11-20T10:00:00+08:00", "2026-11-20T11:00:00+08:00")
    client = ReadClient(blocks=[record, record])
    period = request()
    with pytest.raises(AuthError, match="Unable to verify venue block data") as caught:
        read_operational_blocks(client, VENUE_ID, period.start_at, period.end_at)
    assert caught.value.status_code == 502
    assert str(caught.value.__cause__) == "duplicate blocks"
