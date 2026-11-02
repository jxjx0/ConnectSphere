"""PostgreSQL integration tests for change requests at each event stage.

Set CANCELLATION_TEST_DATABASE_URL to a disposable PostgreSQL server, as for
test_event_cancellation_database.py. These tests create their own database on
it and execute the real migration rather than a SQL or Supabase mock.
"""

from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
SCHEMA_SQL = ROOT / "backend" / "tests" / "sql" / "change_request_schema.sql"
MIGRATION = ROOT / "database" / "change_request_in_safety_check.sql"
TEST_DATABASE = "change_request_test"

ORGANISER_ID = "11111111-1111-1111-1111-111111111111"
COORDINATOR_ID = "22222222-2222-2222-2222-222222222222"
EVENT_ID = "33333333-3333-3333-3333-333333333333"
SESSION_ID = "44444444-4444-4444-4444-444444444444"

START = datetime.now(timezone.utc).replace(microsecond=0) + timedelta(days=30)
END = START + timedelta(hours=2)


@pytest.fixture(scope="module")
def postgres_connection():
    database_url = os.environ.get("CANCELLATION_TEST_DATABASE_URL")
    if not database_url:
        pytest.skip("CANCELLATION_TEST_DATABASE_URL is not configured")
    psycopg = pytest.importorskip("psycopg")

    with psycopg.connect(database_url, autocommit=True) as admin:
        admin.execute(f"drop database if exists {TEST_DATABASE}")
        admin.execute(f"create database {TEST_DATABASE}")

    connection = psycopg.connect(
        psycopg.conninfo.make_conninfo(database_url, dbname=TEST_DATABASE),
        autocommit=True,
    )
    connection.execute(SCHEMA_SQL.read_text(encoding="utf-8"))
    connection.execute(MIGRATION.read_text(encoding="utf-8"))
    connection.execute(
        "select set_config('test.organiser_id', %s, false), "
        "set_config('test.coordinator_id', %s, false)",
        (ORGANISER_ID, COORDINATOR_ID),
    )

    yield connection
    connection.close()
    with psycopg.connect(database_url, autocommit=True) as admin:
        admin.execute(f"drop database if exists {TEST_DATABASE}")


@pytest.fixture
def db(postgres_connection):
    postgres_connection.execute(
        "truncate table public.events, public.venue_bookings, "
        "public.equipment_requests, public.venues cascade"
    )
    return postgres_connection


def _event(db, status):
    db.execute(
        "insert into public.events (id, organiser_id, coordinator_id, name, "
        "description, purpose, category, status) "
        "values (%s, %s, %s, 'Workshop', 'Original', 'Learning', 'workshop', %s)",
        (EVENT_ID, ORGANISER_ID, COORDINATOR_ID, status),
    )
    db.execute(
        "insert into public.event_sessions (id, event_id, name, start_time, "
        "end_time, expected_attendance) values (%s, %s, 'Main', %s, %s, 50)",
        (SESSION_ID, EVENT_ID, START, END),
    )


def _changes(description="Original", attendance=50):
    return {
        "name": "Workshop",
        "description": description,
        "reason_for_change": "Plans have moved on",
        "purpose": "Learning",
        "category": "workshop",
        "category_other": None,
        "accessibility_requirements": None,
        "sessions": [{
            "session_id": SESSION_ID,
            "name": "Main",
            "start_time": START.isoformat(),
            "end_time": END.isoformat(),
            "expected_attendance": attendance,
        }],
    }


def _sign_in(db, user_id):
    db.execute("select set_config('request.jwt.claim.sub', %s, false)", (user_id,))


def _submit(db, changes):
    _sign_in(db, ORGANISER_ID)
    db.execute(
        "select public.submit_session_change_request(%s, %s::jsonb)",
        (EVENT_ID, json.dumps(changes)),
    )


def _approve(db):
    _sign_in(db, COORDINATOR_ID)
    return db.execute(
        "select public.approve_session_change_request(%s)", (EVENT_ID,)
    ).fetchone()[0]


def _status(db):
    return db.execute(
        "select status from public.events where id = %s", (EVENT_ID,)
    ).fetchone()[0]


def _pending_changes(db):
    return db.execute(
        "select count(*) from public.event_change_requests "
        "where event_id = %s and status = 'pending'",
        (EVENT_ID,),
    ).fetchone()[0]


@pytest.mark.parametrize(
    "status", ["under_review", "planning", "awaiting_safety_check", "confirmed"]
)
def test_organiser_can_request_a_change_and_the_event_keeps_its_stage(db, status):
    _event(db, status)

    _submit(db, _changes(description="Updated"))

    assert _pending_changes(db) == 1
    assert _status(db) == status


@pytest.mark.parametrize(
    "status", ["under_review", "planning", "awaiting_safety_check", "confirmed"]
)
def test_an_open_clarification_does_not_stop_a_change_request(db, status):
    _event(db, status)
    db.execute("insert into public.event_clarifications (event_id) values (%s)", (EVENT_ID,))

    _submit(db, _changes(description="Updated"))

    assert _pending_changes(db) == 1
    assert _status(db) == status


@pytest.mark.parametrize("status", ["draft", "completed", "rejected", "cancelled"])
def test_change_requests_are_refused_at_other_stages(db, status):
    _event(db, status)

    with pytest.raises(Exception, match="cannot be changed in its current status"):
        _submit(db, _changes(description="Updated"))

    assert _pending_changes(db) == 0


def test_only_one_change_request_can_be_pending(db):
    _event(db, "awaiting_safety_check")
    _submit(db, _changes(description="Updated"))

    with pytest.raises(Exception, match="pending change request already exists"):
        _submit(db, _changes(description="Updated again"))


def test_a_pending_cancellation_stops_a_change_request(db):
    _event(db, "awaiting_safety_check")
    db.execute(
        "insert into public.event_cancellation_requests (event_id) values (%s)",
        (EVENT_ID,),
    )

    with pytest.raises(Exception, match="while a cancellation request is pending"):
        _submit(db, _changes(description="Updated"))


@pytest.mark.parametrize("status", ["awaiting_safety_check", "confirmed"])
def test_material_change_sends_the_event_back_to_planning(db, status):
    _event(db, status)
    _submit(db, _changes(attendance=80))

    result = _approve(db)

    assert result["returned_to_planning"] is True
    assert _status(db) == "planning"


def test_wording_change_leaves_the_event_in_the_safety_queue(db):
    _event(db, "awaiting_safety_check")
    _submit(db, _changes(description="Updated"))

    result = _approve(db)

    assert result["returned_to_planning"] is False
    assert _status(db) == "awaiting_safety_check"


def test_material_change_in_planning_is_not_reported_as_a_return(db):
    _event(db, "planning")
    _submit(db, _changes(attendance=80))

    result = _approve(db)

    assert result["returned_to_planning"] is False
    assert _status(db) == "planning"
