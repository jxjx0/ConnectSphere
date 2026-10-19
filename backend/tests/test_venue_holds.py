"""Hold API/service wiring; database lifecycle rules are exercised by PGlite."""
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from httpx import ReadTimeout
from postgrest import APIError
from pydantic import ValidationError

import config
from models.profile import Profile, Role
from models.venue_hold import VenueHoldCreateRequest
from services import auth_service, venue_hold_service as holds, venue_booking_service as bookings
from services import venue_availability_service as availability, venue_search_service as search
from services.auth_service import AuthError

STAFF = "00000000-0000-0000-0000-000000000001"
VENUE = "00000000-0000-0000-0000-000000000011"
EVENT = "00000000-0000-0000-0000-000000000021"
COORD = "00000000-0000-0000-0000-000000000002"
HOLD = "00000000-0000-0000-0000-000000000041"
PAYLOAD = {"event_id": EVENT, "start_at": "2099-11-07T10:00+08:00",
           "end_at": "2099-11-07T12:00+08:00", "expires_at": "2099-11-06T12:00+08:00"}
STORED = {**PAYLOAD, "hold_id": HOLD, "venue_id": VENUE, "coordinator_id": COORD,
          "event_name": "Workshop", "venue_name": "Hall"}
ITEM = {"id": HOLD, "venue_id": VENUE, "type": "tentative_hold", "reason": "Tentative hold",
        "start_at": "2099-11-07T09:30+08:00", "end_at": "2099-11-07T12:45+08:00",
        "expires_at": PAYLOAD["expires_at"]}


@pytest.fixture
def database(monkeypatch):
    db = Mock()
    db.rpc.return_value.execute.return_value = SimpleNamespace(data=[])
    monkeypatch.setattr(config, "get_user_client", lambda token: db)
    return db


@pytest.mark.parametrize("change", [
    {"event_id": "bad"}, {"expires_at": None}, {"expires_at": "2000-01-01T00:00Z"},
    {"expires_at": "2099-11-07T11:00+08:00"}, {"expires_at": "2099-11-06T12:00"},
    {"start_at": "2099-11-07T10:00"}, {"end_at": PAYLOAD["start_at"]},
])
def test_hold_validation(change):
    with pytest.raises(ValidationError):
        VenueHoldCreateRequest(**{**PAYLOAD, **change})


@pytest.mark.parametrize("saved", [None, object()])
def test_creation_uses_shared_notification_and_retains_saved_hold(database, monkeypatch, saved):
    database.rpc.return_value.execute.return_value.data = STORED
    notify = Mock(return_value=saved)
    monkeypatch.setattr(holds, "notify", notify)
    result = holds.create_hold("token", VENUE, VenueHoldCreateRequest(**PAYLOAD))
    assert result["hold"]["hold_id"] == HOLD
    assert "coordinator_id" not in result["hold"]
    assert result["notification_status"] == ("saved" if saved else "failed")
    assert notify.call_args.kwargs["user_id"] == COORD
    assert notify.call_args.kwargs["event_id"] == EVENT
    assert "expires" in notify.call_args.kwargs["body"]
    assert database.rpc.call_args.args[0] == "create_venue_tentative_hold"


@pytest.mark.parametrize("code,status", [("22023",400),("23P01",409),("42501",403),("XX000",502)])
def test_create_error_is_controlled(database, code, status):
    database.rpc.return_value.execute.side_effect = APIError({"code":code,"message":"private SQL details"})
    with pytest.raises(AuthError) as error:
        holds.create_hold("token", VENUE, VenueHoldCreateRequest(**PAYLOAD))
    assert error.value.status_code == status
    assert "private" not in str(error.value)


def test_timeout_does_not_encourage_duplicate_creation(database):
    database.rpc.return_value.execute.side_effect = ReadTimeout("timeout")
    with pytest.raises(AuthError, match="Refresh"):
        holds.create_hold("token", VENUE, VenueHoldCreateRequest(**PAYLOAD))


@pytest.mark.parametrize("records", [None, {}, [{}], [{**ITEM,"venue_id":"another"}], [ITEM,ITEM], [{**ITEM,"expires_at":None}]])
def test_invalid_reservation_read_is_not_empty(database, records):
    database.rpc.return_value.execute.return_value.data = records
    with pytest.raises(AuthError):
        availability.read_reservations(database, [VENUE])


@pytest.mark.parametrize("role", list(Role))
def test_hold_endpoints_are_staff_only(client, database, monkeypatch, role):
    monkeypatch.setattr(auth_service,"get_user_id",lambda token: STAFF)
    monkeypatch.setattr(auth_service,"get_profile",lambda *args: Profile(id=STAFF,full_name="Staff",role=role))
    monkeypatch.setattr(holds,"notify",Mock(return_value=object()))
    database.rpc.return_value.execute.return_value.data = STORED
    response = client.post(f"/venues/{VENUE}/holds", json=PAYLOAD, headers={"Authorization":"Bearer token"})
    assert response.status_code == (201 if role == Role.VENUE_STAFF else 403)
    database.rpc.return_value.execute.return_value.data = [{"id":EVENT,"name":"Workshop"}]
    response = client.get("/venues/holds/events", headers={"Authorization":"Bearer token"})
    assert response.status_code == (200 if role == Role.VENUE_STAFF else 403)


def test_hold_requires_auth_and_valid_body(client, monkeypatch):
    assert client.post(f"/venues/{VENUE}/holds",json=PAYLOAD).status_code == 401
    monkeypatch.setattr(auth_service,"get_user_id",lambda token: STAFF)
    monkeypatch.setattr(auth_service,"get_profile",lambda *args: Profile(id=STAFF,full_name="Staff",role=Role.VENUE_STAFF))
    for payload in [[],{},None,{**PAYLOAD,"expires_at":None}]:
        assert client.post(f"/venues/{VENUE}/holds",json=payload,headers={"Authorization":"Bearer token"}).status_code == 400


@pytest.mark.parametrize("saved", [None, object()])
def test_expiry_runner_calls_existing_notify_and_acknowledges_only_saved(database, monkeypatch, saved):
    record = {**STORED,"expiry_claimed_at":"2099-11-06T04:01Z"}
    database.rpc.return_value.execute.return_value.data = [record]
    notify = Mock(return_value=saved)
    monkeypatch.setattr(holds,"notify",notify)
    assert holds.process_expired_holds(database) == int(saved is not None)
    assert notify.call_args.kwargs["notification_type"] == "venue_hold_expired"
    assert database.rpc.call_count == (2 if saved else 1)
    if saved:
        assert database.rpc.call_args.args == ("acknowledge_venue_hold_expiry",{"p_hold_id":HOLD,"p_claim":record["expiry_claimed_at"]})


@pytest.mark.parametrize("start,end,conflict", [
    ("09:00","09:30",False), ("09:29","09:31",True),
    ("12:44","13:00",True), ("12:45","13:00",False),
])
def test_booking_checks_hold_effective_period_and_passes_own_event(database, start, end, conflict):
    database.table.return_value.select.return_value.eq.return_value.lt.return_value.gt.return_value.execute.return_value.data = []
    database.rpc.return_value.execute.return_value.data = [ITEM]
    result = bookings.check_schedule_conflict_details(database,VENUE,f"2099-11-07T{start}+08:00",f"2099-11-07T{end}+08:00",EVENT)
    assert bool(result) is conflict
    assert database.rpc.call_args.args[1]["p_exclude_event_id"] == EVENT
    assert database.rpc.call_args.args[1]["p_holds_only"] is True


@pytest.mark.parametrize("start,end,conflict", [("08:00","09:00",False),("09:30","10:00",True),("12:45","13:00",False)])
def test_search_consumes_active_hold(database, venue_payload, start, end, conflict):
    venue = {"id":VENUE,**venue_payload,"setup_time_minutes":0,"turnaround_time_minutes":0}
    tables = {"venues":Mock(),"venue_blocks":Mock()}
    tables["venues"].select.return_value.order.return_value.execute.return_value.data = [venue]
    tables["venue_blocks"].select.return_value.in_.return_value.lt.return_value.gt.return_value.execute.return_value.data = []
    database.table.side_effect = tables.__getitem__
    database.rpc.side_effect = lambda name, params: SimpleNamespace(execute=lambda: SimpleNamespace(data=[] if name == "get_venue_operational_blocks" else [ITEM]))
    request = search.VenueSearchRequest(date="2099-11-07",start_time=start,end_time=end,timezone_offset_minutes=480)
    result = search.search_venues("token",request)
    assert bool(result["venues"]) is not conflict
    assert result["warnings"] == []
    if not conflict:
        assert result["venues"][0]["availability_status"] == "available"


def test_contextual_search_passes_event_for_authorized_own_hold_exclusion(database, venue_payload):
    venue = {"id":VENUE,**venue_payload,"setup_time_minutes":0,"turnaround_time_minutes":0}
    tables = {"venues":Mock(),"venue_blocks":Mock()}
    tables["venues"].select.return_value.order.return_value.execute.return_value.data = [venue]
    tables["venue_blocks"].select.return_value.in_.return_value.lt.return_value.gt.return_value.execute.return_value.data = []
    database.table.side_effect = tables.__getitem__
    request = search.VenueSearchRequest(event_id=EVENT,date="2099-11-07",start_time="10:00",end_time="12:00",timezone_offset_minutes=480)
    assert search.search_venues("token",request)["venues"]
    assert database.rpc.call_args.args[1]["p_exclude_event_id"] == EVENT


def test_calendar_keeps_distinct_hold_booking_and_operational_block(database):
    booking = {**ITEM,"id":"00000000-0000-0000-0000-000000000031","type":"confirmed_booking","reason":"Confirmed booking","expires_at":None}
    database.rpc.return_value.execute.return_value.data = [ITEM,booking]
    tables = {"venues":Mock(),"venue_blocks":Mock()}
    tables["venues"].select.return_value.eq.return_value.execute.return_value.data = [{"id":VENUE,"name":"Hall","setup_time_minutes":30,"turnaround_time_minutes":45}]
    block = {"block_id":"00000000-0000-0000-0000-000000000051","venue_id":VENUE,"start_at":ITEM["start_at"],"end_at":ITEM["end_at"],"block_reason":"Maintenance"}
    reservation = {**block,"block_id":"00000000-0000-0000-0000-000000000052","source_booking_id":booking["id"]}
    tables["venue_blocks"].select.return_value.eq.return_value.lt.return_value.gt.return_value.order.return_value.execute.return_value.data = [block,reservation]
    database.table.side_effect = tables.__getitem__
    database.rpc.side_effect = lambda name, params: SimpleNamespace(execute=lambda: SimpleNamespace(data=[block,reservation] if name == "get_venue_operational_blocks" else [ITEM,booking]))
    request = availability.VenueAvailabilityRequest(venue_id=VENUE,start_at=PAYLOAD["start_at"],end_at=PAYLOAD["end_at"])
    result = availability.get_venue_availability("token",request)
    assert sorted(item.type for item in result.items) == ['confirmed_booking','operational_block','tentative_hold']
    assert result.verification_status == 'verified'


@pytest.mark.parametrize("stored_setup,stored_turnaround,expected_start,expected_end", [
    (0, 0, "09:30", "12:45"), (60, 90, "09:00", "13:30"),
])
def test_booking_buffers_cannot_narrow_authoritative_occupancy(stored_setup, stored_turnaround, expected_start, expected_end):
    original = {"start_at": PAYLOAD["start_at"], "end_at": PAYLOAD["end_at"],
                "setup_buffer_minutes": stored_setup, "teardown_buffer_minutes": stored_turnaround,
                "venues": {"setup_time_minutes": 30, "turnaround_time_minutes": 45}}
    result = bookings._booking_occupancy(original)
    assert result["effective_start_at"].strftime("%H:%M") == expected_start
    assert result["effective_end_at"].strftime("%H:%M") == expected_end
    assert original["start_at"] == PAYLOAD["start_at"]
    original.update(effective_start_at="2099-11-07T08:45+08:00", effective_end_at="2099-11-07T14:00+08:00")
    result = bookings._booking_occupancy(original)
    assert result["effective_start_at"].strftime("%H:%M") == "08:45"
    assert result["effective_end_at"].strftime("%H:%M") == "14:00"


@pytest.mark.parametrize("venue", [{}, {"setup_time_minutes": None, "turnaround_time_minutes": 45},
                                   {"setup_time_minutes": -1, "turnaround_time_minutes": 45}])
def test_booking_missing_or_invalid_authoritative_buffers_fail_closed(venue):
    with pytest.raises(AuthError, match="verify venue buffers"):
        bookings._booking_occupancy({**PAYLOAD, "venues": venue})


def test_zero_buffer_request_persists_current_venue_occupancy(database, monkeypatch):
    request = bookings.VenueBookingCreateRequest(event_id=EVENT, room_layout="Classroom",
        start_at=PAYLOAD["start_at"], end_at=PAYLOAD["end_at"], setup_buffer_minutes=0, teardown_buffer_minutes=0)
    tables = {"venues": Mock(), "venue_bookings": Mock(), "venue_blocks": Mock()}
    tables["venues"].select.return_value.eq.return_value.execute.return_value.data = [{"setup_time_minutes":30,"turnaround_time_minutes":45}]
    tables["venue_bookings"].select.return_value.eq.return_value.eq.return_value.neq.return_value.neq.return_value.execute.return_value.data = []
    tables["venue_bookings"].insert.return_value.execute.return_value.data = [{"booking_id": "booking"}]
    tables["venue_blocks"].select.return_value.eq.return_value.lt.return_value.gt.return_value.execute.return_value.data = []
    database.table.side_effect = tables.__getitem__
    bookings.create_venue_booking("token", VENUE, request, COORD)
    payload = tables["venue_bookings"].insert.call_args.args[0]
    assert payload["setup_buffer_minutes"] == 30
    assert payload["teardown_buffer_minutes"] == 45
    assert payload["effective_start_at"].endswith("01:30:00+00:00")
    assert payload["effective_end_at"].endswith("04:45:00+00:00")
    assert payload["start_at"].endswith("02:00:00+00:00")


def test_approval_rechecks_expanded_buffers_and_keeps_existing_sequence(database, monkeypatch):
    booking = {"booking_id": HOLD, "venue_id": VENUE, "event_id": EVENT, "status":"PENDING_VENUE_APPROVAL",
               "room_layout":"Classroom", "start_at":PAYLOAD["start_at"], "end_at":PAYLOAD["end_at"],
               "effective_start_at":PAYLOAD["start_at"], "effective_end_at":PAYLOAD["end_at"],
               "setup_buffer_minutes":0,"teardown_buffer_minutes":0,
               "venues":{"setup_time_minutes":30,"turnaround_time_minutes":45,"layouts":[{"name":"Classroom","capacity":100}]}}
    table = database.table.return_value
    table.select.return_value.eq.return_value.execute.return_value.data = [booking]
    table.insert.return_value.execute.return_value.data = [{"block_id":"block"}]
    table.update.return_value.eq.return_value.execute.return_value.data = [{**booking,"status":"APPROVED"}]
    check = Mock(return_value=[])
    monkeypatch.setattr(bookings,"check_schedule_conflict_details",check)
    bookings.review_venue_booking("token",HOLD,STAFF,bookings.VenueBookingReviewRequest(status="APPROVED"))
    assert check.call_args.args[2:4] == ("2099-11-07T09:30:00+08:00","2099-11-07T12:45:00+08:00")
    assert table.insert.call_args.args[0]["start_at"] == check.call_args.args[2]
    assert table.update.call_args.args[0]["effective_end_at"] == check.call_args.args[3]
    assert "start_at" not in table.update.call_args.args[0]
    check.return_value = [{"block_reason":"Maintenance"}]
    table.insert.reset_mock(); table.update.reset_mock()
    with pytest.raises(AuthError) as error:
        bookings.review_venue_booking("token",HOLD,STAFF,bookings.VenueBookingReviewRequest(status="APPROVED"))
    assert error.value.status_code == 409
    table.insert.assert_not_called(); table.update.assert_not_called()


def test_late_confirmation_expiry_message_does_not_request_another_booking(database, monkeypatch):
    record = {"hold_id":HOLD,"event_id":EVENT,"event_name":"Workshop","venue_name":"Hall",
              "coordinator_id":COORD,"expiry_claimed_at":"2099-11-01T00:00Z","completed_booking_id":HOLD}
    database.rpc.return_value.execute.return_value.data = [record]
    sender = Mock(return_value=object()); monkeypatch.setattr(holds,"notify",sender)
    assert holds.process_expired_holds(database) == 1
    assert "before the booking was confirmed" in sender.call_args.kwargs["body"]
    assert "requesting" not in sender.call_args.kwargs["body"]


@pytest.mark.parametrize("records", [None, {}])
def test_incomplete_block_aggregate_cannot_produce_available_search(database, venue_payload, records):
    database.table.return_value.select.return_value.order.return_value.execute.return_value.data = [{"id":VENUE,**venue_payload}]
    database.rpc.return_value.execute.return_value.data = records
    with pytest.raises(AuthError):
        search.search_venues("token",search.VenueSearchRequest(date="2099-11-07",start_time="10:00",end_time="12:00",timezone_offset_minutes=480))


@pytest.mark.parametrize("active", [True,False])
def test_event_booking_context_reads_only_active_unreleased_holds(database, active):
    tables = {"venue_bookings": Mock(), "venue_tentative_holds": Mock()}
    tables["venue_bookings"].select.return_value.eq.return_value.order.return_value.execute.return_value.data = []
    live = tables["venue_tentative_holds"].select.return_value.eq.return_value.is_.return_value.gt.return_value.limit.return_value
    live.execute.return_value.data = [{"hold_id":HOLD}] if active else []
    database.table.side_effect = tables.__getitem__
    assert bookings.get_event_booking_context("token", EVENT) == {"bookings":[],"has_active_venue_hold":active}
    tables["venue_tentative_holds"].select.return_value.eq.assert_called_once_with("event_id",EVENT)
    tables["venue_tentative_holds"].select.return_value.eq.return_value.is_.assert_called_once_with("released_at","null")
    tables["venue_tentative_holds"].select.return_value.eq.return_value.is_.return_value.gt.assert_called_once()


@pytest.mark.parametrize("role", list(Role))
def test_event_booking_context_route_role_guard(client, monkeypatch, role):
    monkeypatch.setattr(auth_service,"get_user_id",lambda _:COORD)
    monkeypatch.setattr(auth_service,"get_profile",lambda *_:Profile(id=COORD,full_name="Tester",role=role))
    reader = Mock(return_value={"bookings":[],"has_active_venue_hold":True})
    monkeypatch.setattr(bookings,"get_event_booking_context",reader)
    response = client.get(f"/venues/bookings/event/{EVENT}",headers={"Authorization":"Bearer token"})
    allowed = role in {Role.VENUE_STAFF,Role.COORDINATOR}
    assert response.status_code == (200 if allowed else 403)
    assert reader.called is allowed
