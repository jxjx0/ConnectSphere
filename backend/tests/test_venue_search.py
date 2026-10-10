"""T7-31 tests; no fabricated booking database or hold lifecycle."""

from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from postgrest import APIError
from pydantic import ValidationError

import config
from models.profile import Profile, Role
from models.venue_search import OccupiedPeriod, VenueSearchRequest
from services import auth_service, venue_search_service
from services import venue_availability_service as availability
from services.auth_service import AuthError


PAYLOAD = {
    "date": "2026-11-07", "start_time": "10:00", "end_time": "12:00",
    "expected_attendance": 100, "required_layout": "Theatre",
    "timezone_offset_minutes": 480,
}


@pytest.fixture
def search_request():
    return VenueSearchRequest(**PAYLOAD)


@pytest.fixture
def catalogue(venue_payload):
    return [{"id": "hall", **venue_payload}]


@pytest.fixture
def database(monkeypatch, catalogue):
    client = Mock()
    venues, blocks = Mock(), Mock()
    venues.select.return_value.order.return_value.execute.return_value = SimpleNamespace(data=catalogue)
    blocks.select.return_value.in_.return_value.lt.return_value.gt.return_value.execute.return_value = SimpleNamespace(data=[])
    client.table.side_effect = lambda name: {"venues": venues, "venue_blocks": blocks}[name]
    factory = Mock(return_value=client)
    monkeypatch.setattr(config, "get_user_client", factory)
    return client, venues, blocks, factory


def set_blocks(database, records):
    database[2].select.return_value.in_.return_value.lt.return_value.gt.return_value.execute.return_value = SimpleNamespace(data=records)


@pytest.mark.parametrize("accessibility", [None, "", "  ", " wheelchair ACCESS "])
def test_optional_accessibility_matches_normalized_feature(database, catalogue, accessibility):
    catalogue[0]["accessibility"] = ["Wheelchair access"]
    request = VenueSearchRequest(required_accessibility=accessibility)
    assert len(venue_search_service.search_venues("token", request)["venues"]) == 1


@pytest.mark.parametrize("selected", ["Wheelchair access", " Wheelchair Accessible ", "WHEELCHAIR   ACCESSIBLE"])
@pytest.mark.parametrize("stored", ["Wheelchair access", " Wheelchair Accessible ", "WHEELCHAIR   ACCESSIBLE"])
def test_accessibility_aliases_match_in_both_directions_without_mutation(database, catalogue, selected, stored):
    catalogue[0]["accessibility"] = [stored, stored.lower()]
    request = VenueSearchRequest(required_accessibility=selected)
    result = venue_search_service.search_venues("token", request)
    assert len(result["venues"]) == 1
    assert result["venues"][0]["accessibility"] == [stored, stored.lower()]
    assert catalogue[0]["accessibility"] == [stored, stored.lower()]


@pytest.mark.parametrize("features", [None, [], [""], ["Step-free"], ["Wheelchair access ramp"]])
def test_accessibility_excludes_missing_or_nonmatching_features(database, catalogue, features):
    catalogue[0]["accessibility"] = features
    request = VenueSearchRequest(required_accessibility="Wheelchair access")
    assert venue_search_service.search_venues("token", request)["venues"] == []


def test_accessibility_combines_with_suitability_and_blocks(database, catalogue):
    catalogue[0]["accessibility"] = ["Wheelchair access"]
    request = VenueSearchRequest(**PAYLOAD, required_accessibility="Wheelchair access")
    assert len(venue_search_service.search_venues("token", request)["venues"]) == 1
    catalogue[0]["capacity"] = 99
    assert venue_search_service.search_venues("token", request)["venues"] == []
    catalogue[0]["capacity"] = 180
    set_blocks(database, [{"venue_id": "hall", "start_at": "2026-11-07T11:00:00+08:00", "end_at": "2026-11-07T12:00:00+08:00"}])
    assert venue_search_service.search_venues("token", request)["venues"] == []


@pytest.mark.parametrize("features", [None, [], [""]])
def test_empty_accessibility_data_does_not_filter_default_search(database, catalogue, features):
    catalogue[0]["accessibility"] = features
    assert len(venue_search_service.search_venues("token", VenueSearchRequest())["venues"]) == 1


@pytest.mark.parametrize("changes", [
    {"date": "2026-02-30"}, {"date": "07-11-2026"}, {"date": "2026-11-07T00:00:00"},
    {"start_time": "25:00"}, {"end_time": "12:60"}, {"start_time": "9:00"},
    {"end_time": "10:00"}, {"end_time": "09:00"},
    {"expected_attendance": 0}, {"expected_attendance": -1},
    {"expected_attendance": 1.5}, {"expected_attendance": True}, {"expected_attendance": "100"},
    {"required_layout": "x" * 121}, {"timezone_offset_minutes": 841},
])
def test_invalid_search_is_rejected(changes):
    with pytest.raises(ValidationError):
        VenueSearchRequest(**{**PAYLOAD, **changes})


@pytest.mark.parametrize("field", ["date", "start_time", "end_time"])
def test_time_group_must_be_complete(field):
    with pytest.raises(ValidationError):
        VenueSearchRequest(**{key: value for key, value in PAYLOAD.items() if key != field})


def test_search_period_has_explicit_offset(search_request):
    start, end = search_request.period()
    assert start.astimezone(timezone.utc).hour == 2
    assert end.astimezone(timezone.utc).hour == 4


@pytest.mark.parametrize("timed,attendance,layout", [
    (False, False, False), (False, True, False), (False, False, True),
    (False, True, True), (True, False, False), (True, True, False),
    (True, False, True), (True, True, True),
])
def test_all_optional_filter_combinations(database, timed, attendance, layout):
    payload = {}
    if timed:
        payload.update({key: PAYLOAD[key] for key in ("date", "start_time", "end_time", "timezone_offset_minutes")})
    if attendance:
        payload["expected_attendance"] = 100
    if layout:
        payload["required_layout"] = "Theatre"
    result = venue_search_service.search_venues("token", VenueSearchRequest(**payload))
    venue = result["venues"][0]
    assert venue["capacity"] == 180
    assert venue["location"] == "Campus West"
    assert venue["selected_layout"] == ("Theatre" if layout else None)
    assert venue["layout_capacity"] == (120 if layout else None)
    assert venue["availability_status"] == ("unverified" if timed else "not_checked")
    assert database[0].table.call_count == (2 if timed else 1)
    if not timed:
        assert result["warnings"] == []
        assert venue["requested_start"] is None


def test_attendance_only_uses_overall_capacity_not_a_layout(database, catalogue):
    catalogue[0]["layouts"][0]["capacity"] = 10
    result = venue_search_service.search_venues("token", VenueSearchRequest(expected_attendance=100))
    assert len(result["venues"]) == 1
    assert result["venues"][0]["selected_layout"] is None


@pytest.mark.parametrize("payload", [{"expected_attendance": 181}, {"required_layout": "Unknown"}])
def test_partial_filters_can_return_no_matches(database, payload):
    assert venue_search_service.search_venues("token", VenueSearchRequest(**payload))["venues"] == []


@pytest.mark.parametrize("payload", [
    {"date": "2026-11-07"}, {"start_time": "10:00"}, {"end_time": "12:00"},
    {"start_time": "10:00", "end_time": "12:00"},
])
def test_incomplete_time_groups_are_rejected(payload):
    with pytest.raises(ValidationError, match="together"):
        VenueSearchRequest(**payload)


def test_blank_and_null_filters_are_optional():
    request = VenueSearchRequest(date="", start_time=None, end_time=" ", expected_attendance="", required_layout=" ")
    assert request.period() is None
    assert request.expected_attendance is None
    assert request.required_layout is None


def test_untimed_search_never_reads_occupancy_or_durations(database, catalogue, monkeypatch):
    catalogue[0].update(setup_time_minutes=-1, turnaround_time_minutes=-1)
    reader = Mock(side_effect=AssertionError("untimed search must not check occupancy"))
    monkeypatch.setattr(availability, "load_booking_occupancy", reader)
    result = venue_search_service.search_venues("token", VenueSearchRequest())
    reader.assert_not_called()
    assert len(result["venues"]) == 1
    assert database[0].table.call_count == 1


def test_valid_search_is_explicitly_unverified_without_dependencies(database, search_request):
    result = venue_search_service.search_venues("caller-token", search_request)
    database[3].assert_called_once_with("caller-token")
    assert result["venues"][0]["name"] == "Community Hall"
    assert result["venues"][0]["layout_capacity"] == 120
    assert result["venues"][0]["availability_status"] == "unverified"
    assert result["venues"][0]["effective_start"] is None
    assert len(result["warnings"]) == 2
    assert database[0].table.call_args_list == [(("venues",),), (("venue_blocks",),)]


@pytest.mark.parametrize("layout_capacity,overall_capacity,layout,expected", [
    (100, 180, "Theatre", 1), (99, 180, "Theatre", 0),
    (120, 99, "Theatre", 0), (120, 180, "Banquet", 0),
    (120, 180, " theatre ", 1),
])
def test_suitability_boundaries(database, catalogue, layout_capacity, overall_capacity, layout, expected):
    catalogue[0]["layouts"][0]["capacity"] = layout_capacity
    catalogue[0]["capacity"] = overall_capacity
    request = VenueSearchRequest(**{**PAYLOAD, "required_layout": layout})
    assert len(venue_search_service.search_venues("token", request)["venues"]) == expected


@pytest.mark.parametrize("start,end,expected", [
    ("2026-11-07T02:30:00Z", "2026-11-07T03:00:00Z", 0),
    ("2026-11-07T01:00:00Z", "2026-11-07T02:00:00Z", 1),
    ("2026-11-07T04:00:00Z", "2026-11-07T05:00:00Z", 1),
])
def test_block_overlap_and_touching(database, search_request, start, end, expected):
    set_blocks(database, [{"venue_id": "hall", "start_at": start, "end_at": end}])
    assert len(venue_search_service.search_venues("token", search_request)["venues"]) == expected


@pytest.mark.parametrize("start,end", [
    ("2026-11-07T01:35:00Z", "2026-11-07T01:40:00Z"),
    ("2026-11-07T04:30:00Z", "2026-11-07T04:40:00Z"),
])
def test_supplied_buffers_exclude_setup_and_turnaround_block_conflicts(database, catalogue, search_request, start, end):
    catalogue[0].update(setup_time_minutes=30, turnaround_time_minutes=45)
    set_blocks(database, [{"venue_id": "hall", "start_at": start, "end_at": end}])
    assert venue_search_service.search_venues("token", search_request)["venues"] == []


def test_multi_date_search_preserves_full_period():
    request = VenueSearchRequest(date="2026-11-07", end_date="2026-11-09",
                                 start_time="22:00", end_time="02:00", timezone_offset_minutes=480)
    start, end = request.period()
    assert start.isoformat() == "2026-11-07T22:00:00+08:00"
    assert end.isoformat() == "2026-11-09T02:00:00+08:00"


@pytest.mark.parametrize("end_date", ["2026-11-06", "2026-02-30", "bad"])
def test_invalid_end_date_is_rejected(end_date):
    with pytest.raises(ValidationError):
        VenueSearchRequest(date="2026-11-07", end_date=end_date, start_time="22:00", end_time="02:00")


def test_end_date_alone_requires_complete_period():
    with pytest.raises(ValidationError):
        VenueSearchRequest(end_date="2026-11-08")


def test_period_can_use_separate_end_offset():
    request = VenueSearchRequest(date="2026-11-07", end_date="2026-11-08",
                                 start_time="22:00", end_time="02:00",
                                 timezone_offset_minutes=120, end_timezone_offset_minutes=60)
    assert request.period()[1].isoformat() == "2026-11-08T02:00:00+01:00"


def test_overnight_search_checks_next_day_blocks(database):
    request = VenueSearchRequest(date="2026-11-07", end_date="2026-11-08",
                                 start_time="22:00", end_time="02:00", timezone_offset_minutes=480)
    set_blocks(database, [{"venue_id": "hall", "start_at": "2026-11-08T00:00:00+08:00", "end_at": "2026-11-08T01:00:00+08:00"}])
    assert venue_search_service.search_venues("token", request)["venues"] == []


def test_effective_period_example_and_midnight():
    start = datetime.fromisoformat("2026-11-07T10:00:00+08:00")
    end = datetime.fromisoformat("2026-11-07T12:00:00+08:00")
    occupied_start, occupied_end = availability.effective_period(start, end, 30, 45)
    assert occupied_start.isoformat() == "2026-11-07T09:30:00+08:00"
    assert occupied_end.isoformat() == "2026-11-07T12:45:00+08:00"
    midnight = start.replace(hour=0, minute=15)
    assert availability.effective_period(midnight, end, 30, 0)[0].day == 6


def test_verified_adapter_contract_can_be_plugged_in(database, catalogue, search_request, monkeypatch):
    catalogue[0].update(setup_time_minutes=0, turnaround_time_minutes=0)
    reader = Mock(return_value={"hall": []})
    monkeypatch.setattr(availability, "load_booking_occupancy", reader)
    result = venue_search_service.search_venues("token", search_request)
    reader.assert_called_once_with(database[0], ["hall"])
    assert result["warnings"] == []
    assert result["venues"][0]["availability_status"] == "available"


def test_adapter_effective_occupancy_excludes_conflict(database, catalogue, search_request, monkeypatch):
    catalogue[0].update(setup_time_minutes=30, turnaround_time_minutes=45)
    interval = OccupiedPeriod(start_at="2026-11-07T04:40:00Z", end_at="2026-11-07T06:00:00Z")
    monkeypatch.setattr(availability, "load_booking_occupancy", lambda *_: {"hall": [interval]})
    assert venue_search_service.search_venues("token", search_request)["venues"] == []


def test_incomplete_adapter_never_proves_availability(database, catalogue, search_request, monkeypatch):
    catalogue[0].update(setup_time_minutes=0, turnaround_time_minutes=0)
    monkeypatch.setattr(availability, "load_booking_occupancy", lambda *_: {})
    result = venue_search_service.search_venues("token", search_request)
    assert result["venues"][0]["availability_status"] == "unverified"
    assert "incomplete" in result["warnings"][0]


def test_database_failure_does_not_return_available_venues(database, search_request):
    database[2].select.return_value.in_.return_value.lt.return_value.gt.return_value.execute.side_effect = APIError({"code": "99999", "message": "failed"})
    with pytest.raises(AuthError) as error:
        venue_search_service.search_venues("token", search_request)
    assert error.value.status_code == 502


def test_empty_catalogue_returns_no_matches(database, catalogue, search_request):
    catalogue.clear()
    assert venue_search_service.search_venues("token", search_request) == {"venues": [], "warnings": []}
    assert database[0].table.call_count == 1


@pytest.mark.parametrize("value", [-1, 1.5, True])
def test_invalid_supplied_duration_is_not_zero(database, catalogue, search_request, value):
    catalogue[0].update(setup_time_minutes=value, turnaround_time_minutes=0)
    with pytest.raises(AuthError) as error:
        venue_search_service.search_venues("token", search_request)
    assert error.value.status_code == 502


def test_malformed_adapter_period_fails_closed(database, search_request, monkeypatch):
    monkeypatch.setattr(availability, "load_booking_occupancy", lambda *_: {
        "hall": [{"start_at": "2026-11-07T10:00", "end_at": "2026-11-07T11:00"}]
    })
    with pytest.raises(AuthError) as error:
        venue_search_service.search_venues("token", search_request)
    assert error.value.status_code == 502


def test_invalid_database_timestamp_fails_closed(database, search_request):
    set_blocks(database, [{"venue_id": "hall", "start_at": "2026-11-07T10:00", "end_at": "2026-11-07T11:00"}])
    with pytest.raises(AuthError) as error:
        venue_search_service.search_venues("token", search_request)
    assert error.value.status_code == 502


def authenticate(monkeypatch, role):
    profile = Profile(id="11111111-1111-1111-1111-111111111111", full_name="User", role=role)
    monkeypatch.setattr(auth_service, "get_user_id", lambda _: profile.id)
    monkeypatch.setattr(auth_service, "get_profile", lambda *_: profile)


def test_coordinator_can_search(client, monkeypatch):
    authenticate(monkeypatch, Role.COORDINATOR)
    service = Mock(return_value={"venues": [], "warnings": []})
    monkeypatch.setattr(venue_search_service, "search_venues", service)
    response = client.post("/venues/search", json=PAYLOAD, headers={"Authorization": "Bearer token"})
    assert response.status_code == 200
    assert response.get_json() == {"venues": [], "warnings": []}
    assert service.call_args.args[0] == "token"


@pytest.mark.parametrize("role", [Role.ORGANISER, Role.VENUE_STAFF, Role.ATTENDEE, Role.TECH_SUPPORT])
def test_other_roles_cannot_search(client, monkeypatch, role):
    authenticate(monkeypatch, role)
    assert client.post("/venues/search", json=PAYLOAD, headers={"Authorization": "Bearer token"}).status_code == 403


def test_search_requires_token(client):
    assert client.post("/venues/search", json=PAYLOAD).status_code == 401


@pytest.mark.parametrize("payload", [{**PAYLOAD, "expected_attendance": 0}, [], "invalid", None])
def test_route_reports_invalid_request(client, monkeypatch, payload):
    authenticate(monkeypatch, Role.COORDINATOR)
    service = Mock()
    monkeypatch.setattr(venue_search_service, "search_venues", service)
    response = client.post("/venues/search", json=payload, headers={"Authorization": "Bearer token"})
    assert response.status_code == 400
    assert response.get_json()["errors"]
    service.assert_not_called()
