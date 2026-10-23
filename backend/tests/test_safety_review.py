"""Tests for the Safety Officer review queue, safety flags and safety check requests."""

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

import config
from models.event import Event, EventReviewSummary
from services import safety_review_service
from services.auth_service import AuthError


EVENT_ID = "55555555-5555-5555-5555-555555555555"

PLANNING_EVENT = {
    "id": EVENT_ID,
    "organiser_id": "11111111-1111-1111-1111-111111111111",
    "name": "Safety Summit",
    "status": "planning",
    "safety_status": "not_requested",
    "expected_attendance": 80,
    "accessibility_requirements": "Wheelchair access for two guests",
}


class FakeQuery:
    """A chainable stand-in for one Supabase table query."""

    def __init__(self, table, rows, filters, updates):
        self._table = table
        self._rows = rows
        self._filters = filters
        self._updates = updates

    def select(self, *args):
        return self

    def eq(self, column, value):
        self._filters.append((self._table, column, value))
        if column == "status" and self._table == "equipment_requests":
            self._rows = [row for row in self._rows if row.get("status") == value]
        return self

    def in_(self, column, values):
        return self

    def order(self, *args, **kwargs):
        return self

    def update(self, values):
        self._updates.append((self._table, values))
        return self

    def execute(self):
        return SimpleNamespace(data=self._rows)


def fake_database(monkeypatch, tables):
    filters, updates = [], []
    client = SimpleNamespace(
        table=lambda name: FakeQuery(name, list(tables.get(name, [])), filters, updates),
        from_=lambda name: FakeQuery(name, list(tables.get(name, [])), filters, updates),
    )
    monkeypatch.setattr(config, "get_admin_client", lambda: client)
    monkeypatch.setattr(config, "get_user_client", lambda token: client)
    monkeypatch.setattr(safety_review_service, "get_admin_client", lambda: client)
    monkeypatch.setattr(safety_review_service, "get_user_client", lambda token: client)
    monkeypatch.setattr(safety_review_service, "_get_client", lambda access_token=None: client)
    return filters, updates


def test_event_models_keep_safety_status():
    assert Event(**{**PLANNING_EVENT, "safety_status": "pending"}).safety_status == "pending"
    summary = EventReviewSummary(
        id=EVENT_ID,
        name="Safety Summit",
        start_time="2026-11-20T02:00:00+00:00",
        end_time="2026-11-20T04:00:00+00:00",
        status="planning",
        safety_status="pending",
    )
    assert summary.safety_status == "pending"


@pytest.mark.parametrize("maintenance_status", ["Under Repair", "Decommissioned"])
def test_equipment_not_in_working_order_is_flagged(monkeypatch, maintenance_status):
    fake_database(monkeypatch, {
        "events": [PLANNING_EVENT],
        "equipment_requests": [{"id": "request-1", "status": "Approved"}],
        "equipment_request_items": [{
            "quantity": 1,
            "equipment": {"name": "Microphone", "type": "Audio", "maintenance_status": maintenance_status},
        }],
    })

    details = safety_review_service.get_safety_event_details(EVENT_ID, "token")

    hazards = [flag for flag in details["safety_flags"] if flag["type"] == "EQUIPMENT_HAZARD"]
    assert len(hazards) == 1
    assert maintenance_status in hazards[0]["message"]


def test_functional_equipment_is_not_flagged(monkeypatch):
    fake_database(monkeypatch, {
        "events": [PLANNING_EVENT],
        "equipment_requests": [{"id": "request-1", "status": "Approved"}],
        "equipment_request_items": [{
            "quantity": 1,
            "equipment": {"name": "Microphone", "type": "Audio", "maintenance_status": "Functional"},
        }],
    })

    details = safety_review_service.get_safety_event_details(EVENT_ID, "token")

    assert not [flag for flag in details["safety_flags"] if flag["type"] == "EQUIPMENT_HAZARD"]


def test_only_approved_equipment_requests_are_shown(monkeypatch):
    filters, _ = fake_database(monkeypatch, {
        "events": [PLANNING_EVENT],
        "equipment_requests": [{"id": "request-1", "status": "Rejected"}],
        "equipment_request_items": [{"quantity": 1, "equipment": {"name": "Projector"}}],
    })

    details = safety_review_service.get_safety_event_details(EVENT_ID, "token")

    assert ("equipment_requests", "status", "Approved") in filters
    assert details["equipment_items"] == []


@pytest.mark.parametrize(
    "accessibility,flagged",
    [
        (["Wheelchair access"], False),
        (["Wheelchair Accessible", "Lift"], False),
        (["Hearing loop"], True),
        ([], True),
    ],
)
def test_wheelchair_needs_are_checked_against_venue_features(
    monkeypatch, accessibility, flagged
):
    fake_database(monkeypatch, {
        "events": [PLANNING_EVENT],
        "venue_bookings": [{
            "status": "APPROVED",
            "venue": {"name": "Hall", "capacity": 200, "accessibility": accessibility},
        }],
    })

    details = safety_review_service.get_safety_event_details(EVENT_ID, "token")

    gaps = [flag for flag in details["safety_flags"] if flag["type"] == "ACCESSIBILITY_GAP"]
    assert bool(gaps) is flagged


def test_request_is_refused_without_an_approved_venue(monkeypatch):
    _, updates = fake_database(monkeypatch, {
        "events": [PLANNING_EVENT],
        "venue_bookings": [{"status": "PENDING"}],
    })

    with pytest.raises(AuthError) as caught:
        safety_review_service.request_safety_check(EVENT_ID, "token")

    assert caught.value.status_code == 409
    assert "approved venue booking" in caught.value.message
    assert updates == []


def test_request_is_refused_while_equipment_is_pending(monkeypatch):
    _, updates = fake_database(monkeypatch, {
        "events": [PLANNING_EVENT],
        "venue_bookings": [{"status": "APPROVED"}],
        "equipment_requests": [{"status": "Approved"}, {"status": "Pending Technical Approval"}],
    })

    with pytest.raises(AuthError) as caught:
        safety_review_service.request_safety_check(EVENT_ID, "token")

    assert "pending equipment requests" in caught.value.message
    assert updates == []


@pytest.mark.parametrize("other_status", ["PENDING_VENUE_APPROVAL", "AFFECTED_BY_UNAVAILABILITY"])
def test_request_is_refused_while_any_venue_booking_is_not_approved(monkeypatch, other_status):
    _, updates = fake_database(monkeypatch, {
        "events": [PLANNING_EVENT],
        "venue_bookings": [{"status": "APPROVED"}, {"status": other_status}],
    })

    with pytest.raises(AuthError) as caught:
        safety_review_service.request_safety_check(EVENT_ID, "token")

    assert caught.value.status_code == 409
    assert "every venue booking must be approved" in caught.value.message
    assert updates == []


def test_every_approved_venue_booking_is_sent(monkeypatch):
    _, updates = fake_database(monkeypatch, {
        "events": [PLANNING_EVENT],
        "venue_bookings": [{"status": "APPROVED"}, {"status": "approved"}],
    })

    safety_review_service.request_safety_check(EVENT_ID, "token")

    assert [table for table, _ in updates] == ["events"]


@pytest.mark.parametrize("settled_status", ["CANCELLED", "REJECTED", "REJECTED_BY_SAFETY"])
def test_settled_venue_bookings_do_not_block_a_replanned_event(monkeypatch, settled_status):
    _, updates = fake_database(monkeypatch, {
        "events": [PLANNING_EVENT],
        "venue_bookings": [{"status": settled_status}, {"status": "APPROVED"}],
    })

    safety_review_service.request_safety_check(EVENT_ID, "token")

    assert [table for table, _ in updates] == ["events"]


@pytest.mark.parametrize("settled_status", ["CANCELLED", "REJECTED", "REJECTED_BY_SAFETY"])
def test_settled_bookings_alone_do_not_count_as_an_approved_venue(monkeypatch, settled_status):
    _, updates = fake_database(monkeypatch, {
        "events": [PLANNING_EVENT],
        "venue_bookings": [{"status": settled_status}],
    })

    with pytest.raises(AuthError) as caught:
        safety_review_service.request_safety_check(EVENT_ID, "token")

    assert "approved venue booking" in caught.value.message
    assert updates == []


def test_request_stamps_updated_at_so_the_queue_shows_the_request_time(monkeypatch):
    _, updates = fake_database(monkeypatch, {
        "events": [PLANNING_EVENT],
        "venue_bookings": [{"status": "APPROVED"}],
    })

    before = datetime.now(timezone.utc)
    safety_review_service.request_safety_check(EVENT_ID, "token")

    _, values = updates[0]
    assert values["status"] == "awaiting_safety_check"
    stamped = datetime.fromisoformat(values["updated_at"])
    assert stamped.utcoffset() == timedelta(0)
    assert before <= stamped <= datetime.now(timezone.utc)


def test_rejected_equipment_requests_do_not_block_the_request(monkeypatch):
    _, updates = fake_database(monkeypatch, {
        "events": [PLANNING_EVENT],
        "venue_bookings": [{"status": "APPROVED"}],
        "equipment_requests": [{"status": "Approved"}, {"status": "Rejected"}],
    })

    safety_review_service.request_safety_check(EVENT_ID, "token")

    assert [table for table, _ in updates] == ["events"]
    assert updates[0][1]["status"] == "awaiting_safety_check"


def test_request_is_refused_outside_planning(monkeypatch):
    fake_database(monkeypatch, {
        "events": [{**PLANNING_EVENT, "status": "under_review"}],
        "venue_bookings": [{"status": "APPROVED"}],
    })

    with pytest.raises(AuthError) as caught:
        safety_review_service.request_safety_check(EVENT_ID, "token")

    assert "Planning" in caught.value.message


def test_request_is_refused_when_already_requested(monkeypatch):
    _, updates = fake_database(monkeypatch, {
        "events": [{**PLANNING_EVENT, "status": "awaiting_safety_check"}],
        "venue_bookings": [{"status": "APPROVED"}],
    })

    with pytest.raises(AuthError) as caught:
        safety_review_service.request_safety_check(EVENT_ID, "token")

    assert caught.value.status_code == 409
    assert updates == []


def test_ready_event_is_sent_for_safety_check(monkeypatch):
    _, updates = fake_database(monkeypatch, {
        "events": [PLANNING_EVENT],
        "venue_bookings": [{"status": "APPROVED"}],
        "equipment_requests": [{"status": "Approved"}],
    })

    safety_review_service.request_safety_check(EVENT_ID, "token")

    assert [table for table, _ in updates] == ["events"]
    assert updates[0][1]["status"] == "awaiting_safety_check"


def test_event_without_equipment_can_be_sent(monkeypatch):
    _, updates = fake_database(monkeypatch, {
        "events": [PLANNING_EVENT],
        "venue_bookings": [{"status": "APPROVED"}],
    })

    safety_review_service.request_safety_check(EVENT_ID, "token")

    assert [table for table, _ in updates] == ["events"]
    assert updates[0][1]["status"] == "awaiting_safety_check"


def test_missing_event_returns_not_found(monkeypatch):
    fake_database(monkeypatch, {"events": []})

    with pytest.raises(AuthError) as caught:
        safety_review_service.request_safety_check(EVENT_ID, "token")

    assert caught.value.status_code == 404

# --- Sessions (T7-278) -------------------------------------------------------

CONFERENCE_SESSIONS = [
    {"id": "ses-main", "name": "Main programme", "expected_attendance": 300},
    {"id": "ses-a", "name": "Breakout A", "expected_attendance": 50},
]


def test_request_is_refused_until_every_session_has_an_approved_venue(monkeypatch):
    _, updates = fake_database(monkeypatch, {
        "events": [PLANNING_EVENT],
        "venue_bookings": [{"status": "APPROVED", "session_id": "ses-main"}],
        "event_sessions": CONFERENCE_SESSIONS,
    })

    with pytest.raises(AuthError) as caught:
        safety_review_service.request_safety_check(EVENT_ID, "token")

    assert caught.value.status_code == 409
    assert "every session needs an approved venue booking (Breakout A has none)" in caught.value.message
    assert updates == []


def test_request_is_accepted_once_every_session_has_an_approved_venue(monkeypatch):
    _, updates = fake_database(monkeypatch, {
        "events": [PLANNING_EVENT],
        "venue_bookings": [
            {"status": "APPROVED", "session_id": "ses-main"},
            {"status": "APPROVED", "session_id": "ses-a"},
        ],
        "event_sessions": CONFERENCE_SESSIONS,
    })

    safety_review_service.request_safety_check(EVENT_ID, "token")

    assert updates


def test_each_venue_is_checked_against_its_own_sessions_attendance(monkeypatch):
    """A 60-seat room is fine for a 50-person breakout in a 300-person event."""
    fake_database(monkeypatch, {
        "events": [{**PLANNING_EVENT, "expected_attendance": 300, "sessions": CONFERENCE_SESSIONS}],
        "venue_bookings": [
            {"status": "APPROVED", "session_id": "ses-a", "room_layout": "Classroom",
             "venue": {"name": "Room 3-1", "capacity": 120, "accessibility": ["Wheelchair access"],
                       "layouts": [{"name": "Classroom", "capacity": 60}]}},
            {"status": "APPROVED", "session_id": "ses-main", "room_layout": "Theatre",
             "venue": {"name": "Hall", "capacity": 200, "accessibility": ["Wheelchair access"],
                       "layouts": [{"name": "Theatre", "capacity": 200}]}},
        ],
    })

    details = safety_review_service.get_safety_event_details(EVENT_ID, "token")

    capacity = [flag["message"] for flag in details["safety_flags"] if flag["type"] == "CAPACITY_EXCEEDED"]
    assert capacity == [
        "Main programme - Hall: expected attendance (300) exceeds capacity (200) for layout 'Theatre'."
    ]
    assert [booking["session"]["name"] for booking in details["venue_bookings"]] == [
        "Breakout A",
        "Main programme",
    ]


# --- Equipment per session (T7-279) ------------------------------------------

SESSIONS_NEEDING_EQUIPMENT = [
    {**CONFERENCE_SESSIONS[0], "equipment_requirements": "2 projectors"},
    {**CONFERENCE_SESSIONS[1], "equipment_requirements": "  "},
]
BOTH_VENUES = [
    {"status": "APPROVED", "session_id": "ses-main"},
    {"status": "APPROVED", "session_id": "ses-a"},
]


def test_request_is_refused_until_each_session_needing_equipment_has_a_request(monkeypatch):
    _, updates = fake_database(monkeypatch, {
        "events": [PLANNING_EVENT],
        "venue_bookings": BOTH_VENUES,
        "event_sessions": SESSIONS_NEEDING_EQUIPMENT,
    })

    with pytest.raises(AuthError) as caught:
        safety_review_service.request_safety_check(EVENT_ID, "token")

    assert caught.value.status_code == 409
    assert (
        "every session that needs equipment needs an equipment request (Main programme has none)"
        in caught.value.message
    )
    assert updates == []


def test_sessions_without_equipment_needs_do_not_need_a_request(monkeypatch):
    """Breakout A lists no equipment, so only Main programme needs a request."""
    _, updates = fake_database(monkeypatch, {
        "events": [PLANNING_EVENT],
        "venue_bookings": BOTH_VENUES,
        "event_sessions": SESSIONS_NEEDING_EQUIPMENT,
        "equipment_requests": [{"status": "Approved", "session_id": "ses-main"}],
    })

    safety_review_service.request_safety_check(EVENT_ID, "token")

    assert updates
