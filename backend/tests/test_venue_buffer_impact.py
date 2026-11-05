"""Venue edits persist first; new buffer conflicts use real service boundaries."""
from copy import deepcopy
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import UUID

import pytest
from postgrest import APIError

import config
from models.venue import VenueUpdateRequest
from services import venue_service, venue_buffer_service as impact
from services.venue_availability_service import effective_period


def uid(value):
    return str(UUID(int=value))


VENUE, OTHER, COORD, SUBMITTER, EVENT = map(uid, [11, 12, 21, 22, 31])


def timestamp(value):
    return f"2099-11-07T{value}:00+08:00"


class Database:
    def __init__(self, payload):
        self.venue = {"id": VENUE, **payload, "setup_time_minutes": 0, "turnaround_time_minutes": 0}
        self.bookings, self.holds, self.blocks, self.calls = [], [], [], []
        self.fail = None

    def booking(self, start="10:00", end="12:00", status="APPROVED", venue=VENUE, event=EVENT):
        row = {"booking_id":uid(100 + len(self.bookings)), "venue_id":venue,
               "event_id":event,"event_name":"Workshop","coordinator_id":SUBMITTER,
               "status":status,"start_at":timestamp(start),"end_at":timestamp(end)}
        self.bookings.append(row)
        return row

    def hold(self, start, end, event=uid(32), expired=False):
        self.holds.append({"id":uid(200+len(self.holds)),"venue_id":VENUE,"event":event,
            "type":"tentative_hold","reason":"Tentative hold","start_at":timestamp(start),"end_at":timestamp(end),
            "event_start_at":timestamp(start),"event_end_at":timestamp(end),
            "expires_at":"2000-01-01T00:00Z" if expired else "2099-11-06T00:00Z"})

    def block(self, start, end, source=None, reason="Maintenance"):
        self.blocks.append({"block_id":uid(300+len(self.blocks)),"venue_id":VENUE,
            "start_at":timestamp(start),"end_at":timestamp(end),"block_reason":reason,"source_booking_id":source})

    def reservation(self, booking):
        start, end = effective_period(
            datetime.fromisoformat(booking["start_at"]), datetime.fromisoformat(booking["end_at"]),
            max(self.venue["setup_time_minutes"], booking.get("setup_buffer_minutes", 0)),
            max(self.venue["turnaround_time_minutes"], booking.get("teardown_buffer_minutes", 0)),
        )
        start = min(start, datetime.fromisoformat(booking.get("effective_start_at", start.isoformat())))
        end = max(end, datetime.fromisoformat(booking.get("effective_end_at", end.isoformat())))
        return {"id": booking["booking_id"], "venue_id": booking["venue_id"], "type": "confirmed_booking",
                "reason": "Confirmed booking", "start_at": start.isoformat(), "end_at": end.isoformat(),
                "event_start_at": booking["start_at"], "event_end_at": booking["end_at"]}

    def table(self, name):
        assert name == "venues"
        db = self
        class Query:
            operation = "select"
            def select(self, *_): return self
            def order(self, *_): return self
            def eq(self, key, value):
                assert (key,value) == ("id",VENUE)
                return self
            def update(self, payload):
                self.operation, self.payload = "update", payload
                return self
            def execute(self):
                db.calls.append(self.operation)
                if db.fail == "old_read" and self.operation == "select":
                    raise APIError({"code":"XX000","message":"private error"})
                if self.operation == "update": db.venue.update(self.payload)
                return SimpleNamespace(data=[deepcopy(db.venue)])
        return Query()

    def rpc(self, name, params):
        db = self
        def execute():
            db.calls.append(name)
            if db.fail == name:
                raise APIError({"code":"XX000","message":"private error"})
            if name == "get_venue_block_bookings":
                rows = [{**b,"venue_name":db.venue["name"],"coordinator_id":COORD,
                         "setup_time_minutes":db.venue["setup_time_minutes"],
                         "turnaround_time_minutes":db.venue["turnaround_time_minutes"]}
                        for b in db.bookings if b["venue_id"] == params["p_venue_id"] and b["status"] == "APPROVED"]
            elif name == "get_venue_reservations":
                rows = []
                if not params["p_holds_only"]:
                    rows += [db.reservation(b)
                             for b in db.bookings if b["venue_id"] in params["p_venue_ids"]
                             and b["status"] in {"APPROVED","AFFECTED_BY_UNAVAILABILITY"}]
                for hold in db.holds:
                    if hold["event"] == params["p_exclude_event_id"] or datetime.fromisoformat(
                            hold["expires_at"].replace("Z", "+00:00")) <= datetime.now(timezone.utc):
                        continue
                    start, end = effective_period(datetime.fromisoformat(hold["event_start_at"]),
                        datetime.fromisoformat(hold["event_end_at"]), db.venue["setup_time_minutes"],
                        db.venue["turnaround_time_minutes"])
                    rows.append({**hold, "start_at": start.isoformat(), "end_at": end.isoformat()})
            elif name == "get_venue_operational_blocks": rows = deepcopy(db.blocks)
            elif name == "mark_venue_block_bookings_affected":
                rows = []
                for b in db.bookings:
                    if b["venue_id"] == params["p_venue_id"] and b["booking_id"] in params["p_booking_ids"] and b["status"] == "APPROVED":
                        b["status"] = "AFFECTED_BY_UNAVAILABILITY"
                        rows.append({"booking_id":b["booking_id"],"status":b["status"]})
            else: raise AssertionError(name)
            return SimpleNamespace(data=deepcopy(rows))
        return SimpleNamespace(execute=execute)


@pytest.fixture
def database(monkeypatch, venue_payload):
    db = Database(venue_payload)
    monkeypatch.setattr(config,"get_user_client",lambda _:db)
    db.notify = Mock(return_value=object())
    monkeypatch.setattr(impact,"notify",db.notify)
    return db


def save(db, setup=0, turnaround=0, **changes):
    payload = {key:value for key,value in db.venue.items() if key != "id"}
    payload.update(setup_time_minutes=setup,turnaround_time_minutes=turnaround,**changes)
    return venue_service.update_venue("token",VENUE,VenueUpdateRequest(**payload))


@pytest.mark.parametrize("first,second,setup,turnaround", [
    (("08:00","09:45"),("10:00","12:00"),30,0),
    (("10:00","12:00"),("12:30","14:00"),0,45),
])
def test_new_booking_conflicts_flag_both_and_preserve_times(database,first,second,setup,turnaround):
    database.booking(*first)
    database.booking(*second,event=uid(32))
    before = deepcopy(database.bookings)
    result = save(database,setup,turnaround)
    assert result.buffer_impact["status"] == "verified"
    assert len(result.buffer_impact["affected_bookings"]) == 2
    assert database.venue["setup_time_minutes"] == setup
    assert database.venue["turnaround_time_minutes"] == turnaround
    assert database.calls.index("update") < database.calls.index("get_venue_block_bookings")
    for old,after in zip(before,database.bookings):
        assert {k:v for k,v in old.items() if k != "status"} == {k:v for k,v in after.items() if k != "status"}
        assert after["status"] == "AFFECTED_BY_UNAVAILABILITY"
    assert database.notify.call_count == 2
    assert all(call.kwargs["user_id"] == COORD for call in database.notify.call_args_list)


@pytest.mark.parametrize("kind",["hold","operational"])
def test_new_setup_conflict_with_other_occupancy(database,kind):
    database.booking()
    if kind == "hold": database.hold("08:00","09:45")
    else: database.block("09:15","09:45")
    result = save(database,30)
    assert result.buffer_impact["status"] == "verified"
    assert len(result.buffer_impact["affected_bookings"]) == 1


@pytest.mark.parametrize("kind",["booking","hold","operational"])
def test_exact_touch_is_not_a_conflict(database,kind):
    database.booking()
    if kind == "booking": database.booking("08:00","09:30",event=uid(32))
    elif kind == "hold": database.hold("08:00","09:30")
    else: database.block("09:00","09:30")
    assert save(database,30).buffer_impact["affected_bookings"] == []
    database.notify.assert_not_called()


def test_own_generated_block_own_hold_and_expired_holds_do_not_flag(database):
    booking = database.booking()
    database.block("09:00","13:00",source=booking["booking_id"],reason="Approved Booking: Workshop (Theatre)")
    database.hold("08:00","09:45",event=EVENT)
    database.hold("08:00","09:45",expired=True)
    assert save(database,30).buffer_impact["affected_bookings"] == []


def test_unrelated_venue_and_nonapproved_bookings_are_unchanged(database):
    database.booking()
    database.block("09:15","09:45")
    others = [database.booking(venue=OTHER)]
    others += [database.booking(status=status) for status in ["PENDING_VENUE_APPROVAL","REJECTED","CANCELLED"]]
    before = deepcopy(others)
    assert len(save(database,30).buffer_impact["affected_bookings"]) == 1
    assert others == before


def test_existing_affected_booking_can_conflict_but_is_not_updated_or_notified(database):
    database.booking()
    other = database.booking("08:00","09:45",status="AFFECTED_BY_UNAVAILABILITY")
    before = deepcopy(other)
    assert len(save(database,30).buffer_impact["affected_bookings"]) == 1
    assert other == before
    assert database.notify.call_count == 1


def test_existing_conflicts_are_not_reported_as_new(database):
    database.booking()
    database.block("11:00","11:30")
    assert save(database,30).buffer_impact["affected_bookings"] == []


@pytest.mark.parametrize("explicit",[True,False])
def test_unrelated_or_unchanged_updates_do_not_run_impact(database,explicit):
    database.booking()
    if explicit: result = save(database,name="Renamed")
    else:
        payload = {k:v for k,v in database.venue.items() if k not in {"id","setup_time_minutes","turnaround_time_minutes"}}
        result = venue_service.update_venue("token",VENUE,VenueUpdateRequest(**{**payload,"name":"Renamed"}))
    assert result.buffer_impact is None
    assert not any(call.startswith("get_venue_") for call in database.calls)


def test_every_booking_of_an_event_is_checked_against_holds_read_once(database, monkeypatch):
    database.booking("10:00","12:00"); database.booking("14:00","16:00")
    database.hold("08:00","09:45"); database.hold("13:00","13:45")
    hold_reads = []
    rpc = database.rpc
    def recording_rpc(name, params):
        if name == "get_venue_reservations" and params["p_holds_only"]:
            hold_reads.append(params["p_exclude_event_id"])
        return rpc(name, params)
    monkeypatch.setattr(database, "rpc", recording_rpc)
    result = save(database,30)
    assert result.buffer_impact["status"] == "verified"
    assert len(result.buffer_impact["affected_bookings"]) == 2
    assert hold_reads == [EVENT]


def test_venue_without_saved_buffers_still_updates_without_claiming_impact(database):
    database.booking(); database.block("09:15","09:45")
    database.venue["setup_time_minutes"] = None
    result = save(database,30)
    assert database.venue["setup_time_minutes"] == result.setup_time_minutes == 30
    assert result.buffer_impact == {"status":"unavailable","affected_bookings":None}
    assert not any(call.startswith("get_venue_") for call in database.calls)
    assert database.bookings[0]["status"] == "APPROVED"
    database.notify.assert_not_called()


@pytest.mark.parametrize("failure",["old_read","get_venue_block_bookings","get_venue_reservations","get_venue_operational_blocks"])
def test_read_failure_reports_saved_venue_without_claiming_impact_success(database,failure):
    database.booking(); database.fail=failure
    result = save(database,30)
    assert database.venue["setup_time_minutes"] == result.setup_time_minutes == 30
    assert result.buffer_impact == {"status":"unavailable","affected_bookings":None}
    database.notify.assert_not_called()


def test_status_update_failure_is_partial_and_still_warns_coordinator(database):
    database.booking(); database.block("09:15","09:45")
    database.fail="mark_venue_block_bookings_affected"
    result = save(database,30)
    assert result.setup_time_minutes == 30
    assert result.buffer_impact["status"] == "partial"
    item, = result.buffer_impact["affected_bookings"]
    assert item["status_update"] == "failed"
    assert item["notification_status"] == "saved"
    assert database.bookings[0]["status"] == "APPROVED"


def test_notification_failure_is_visible_and_does_not_undo_flag(database):
    database.booking(); database.block("09:15","09:45"); database.notify.return_value=None
    result = save(database,30)
    assert result.buffer_impact["status"] == "partial"
    assert result.buffer_impact["affected_bookings"][0]["notification_status"] == "failed"
    assert database.bookings[0]["status"] == "AFFECTED_BY_UNAVAILABILITY"


def test_ambiguous_legacy_reservation_requires_manual_check_not_a_false_self_conflict(database):
    database.booking(); database.block("09:00","13:00",reason="Approved Booking: Old event (Theatre)")
    result = save(database,30)
    assert result.buffer_impact["status"] == "unavailable"
    assert database.bookings[0]["status"] == "APPROVED"


def test_saving_same_values_again_and_reading_does_not_repeat_notifications(database):
    database.booking(); database.block("09:15","09:45")
    save(database,30)
    assert save(database,30).buffer_impact is None
    venue_service.list_venues("token")
    assert database.notify.call_count == 1


def test_decreasing_buffers_preserves_valid_booking_records(database):
    database.venue.update(setup_time_minutes=60, turnaround_time_minutes=45)
    database.booking()
    before = deepcopy(database.bookings)
    assert save(database, 30, 15).buffer_impact == {"status": "verified", "affected_bookings": []}
    assert database.bookings == before
    database.notify.assert_not_called()


@pytest.mark.parametrize("status", ["APPROVED", "AFFECTED_BY_UNAVAILABILITY"])
@pytest.mark.parametrize("stored_field,stored_value,other_start,other_end,setup,turnaround", [
    ("effective_end_at", timestamp("13:45"), "12:00", "13:00", 30, 0),
    ("teardown_buffer_minutes", 45, "12:00", "13:00", 30, 0),
    ("effective_start_at", timestamp("16:15"), "17:00", "18:00", 0, 30),
    ("setup_buffer_minutes", 45, "17:00", "18:00", 0, 30),
])
def test_new_overlap_with_retained_reservation_is_detected(
        database, status, stored_field, stored_value, other_start, other_end, setup, turnaround):
    other = database.booking(other_start, other_end, status=status)
    other[stored_field] = stored_value
    candidate = database.booking("14:00", "16:00", event=uid(32))
    result = save(database, setup, turnaround)
    assert result.buffer_impact["status"] == "verified"
    assert candidate["status"] == "AFFECTED_BY_UNAVAILABILITY"
    assert candidate["booking_id"] in {item["booking_id"] for item in result.buffer_impact["affected_bookings"]}


def test_retained_reservation_preexisting_conflict_is_not_reported_as_new(database):
    other = database.booking("12:00", "13:00")
    other["effective_end_at"] = timestamp("14:15")
    database.booking("14:00", "16:00", event=uid(32))
    assert save(database, 30).buffer_impact["affected_bookings"] == []
    database.notify.assert_not_called()


def test_retained_reservation_exact_touch_remains_allowed(database):
    other = database.booking("12:00", "13:00")
    other["effective_end_at"] = timestamp("13:30")
    database.booking("14:00", "16:00", event=uid(32))
    assert save(database, 30).buffer_impact["affected_bookings"] == []


def test_retained_candidate_window_is_used_against_operational_blocks(database):
    booking = database.booking("14:00", "16:00")
    booking["effective_start_at"] = timestamp("13:00")
    database.block("13:15", "13:30")
    # This overlap already existed; changing an unrelated end buffer cannot create it.
    assert save(database, turnaround=30).buffer_impact["affected_bookings"] == []


def test_post_save_reservation_read_failure_reports_saved_but_unverified(database, monkeypatch):
    database.booking()
    original_rpc = database.rpc

    def rpc(name, params):
        if name == "get_venue_reservations" and "update" in database.calls:
            raise APIError({"code": "XX000", "message": "read failed"})
        return original_rpc(name, params)

    monkeypatch.setattr(database, "rpc", rpc)
    result = save(database, 30)
    assert result.setup_time_minutes == database.venue["setup_time_minutes"] == 30
    assert result.buffer_impact == {"status": "unavailable", "affected_bookings": None}
    database.notify.assert_not_called()


def test_booking_period_change_during_check_is_unverified_not_a_buffer_conflict(database, monkeypatch):
    booking = database.booking()
    original_rpc = database.rpc

    def rpc(name, params):
        if name == "get_venue_block_bookings":
            booking["start_at"] = timestamp("09:00")
        return original_rpc(name, params)

    monkeypatch.setattr(database, "rpc", rpc)
    result = save(database, 30)
    assert result.buffer_impact == {"status": "unavailable", "affected_bookings": None}
    assert booking["status"] == "APPROVED"
    database.notify.assert_not_called()
