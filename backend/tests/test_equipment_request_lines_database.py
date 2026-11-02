"""PostgreSQL integration tests for trackable equipment requests.

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
SCHEMA_SQL = ROOT / "backend" / "tests" / "sql" / "equipment_request_lines_schema.sql"
MIGRATION = ROOT / "database" / "equipment_request_lines.sql"
OTHER_LINES_MIGRATION = ROOT / "database" / "equipment_request_other_lines.sql"
TEST_DATABASE = "equipment_request_lines_test"

COORDINATOR_ID = "11111111-1111-1111-1111-111111111111"
TECH_ID = "22222222-2222-2222-2222-222222222222"
ORGANISER_ID = "33333333-3333-3333-3333-333333333333"
EVENT_ID = "44444444-4444-4444-4444-444444444444"
SESSION_ID = "55555555-5555-5555-5555-555555555555"

START = datetime.now(timezone.utc).replace(microsecond=0) + timedelta(days=30)
END = START + timedelta(hours=2)


@pytest.fixture(scope="module")
def database():
    database_url = os.environ.get("CANCELLATION_TEST_DATABASE_URL")
    if not database_url:
        pytest.skip("CANCELLATION_TEST_DATABASE_URL is not configured")
    psycopg = pytest.importorskip("psycopg")

    # Roles belong to the whole server, and other test modules create this one.
    with psycopg.connect(database_url, autocommit=True) as admin:
        admin.execute(f"drop database if exists {TEST_DATABASE}")
        admin.execute(f"create database {TEST_DATABASE}")
        created_role = not admin.execute(
            "select 1 from pg_roles where rolname = 'authenticated'"
        ).fetchone()
        created_anon = not admin.execute(
            "select 1 from pg_roles where rolname = 'anon'"
        ).fetchone()
        if created_role:
            admin.execute("create role authenticated")
        if created_anon:
            admin.execute("create role anon")

    connection = psycopg.connect(
        psycopg.conninfo.make_conninfo(database_url, dbname=TEST_DATABASE),
        autocommit=True,
    )
    connection.execute(SCHEMA_SQL.read_text(encoding="utf-8"))
    connection.execute(
        "insert into public.equipment (name, type) values "
        "('Old Projector', 'Visual'), (' Speaker ', 'Audio')"
    )
    connection.execute(MIGRATION.read_text(encoding="utf-8"))
    connection.execute(OTHER_LINES_MIGRATION.read_text(encoding="utf-8"))
    connection.execute(
        "select set_config('test.coordinator_id', %s, false), "
        "set_config('test.tech_id', %s, false)",
        (COORDINATOR_ID, TECH_ID),
    )

    yield connection
    connection.close()
    with psycopg.connect(database_url, autocommit=True) as admin:
        admin.execute(f"drop database if exists {TEST_DATABASE}")
        if created_role:
            admin.execute("drop role authenticated")
        if created_anon:
            admin.execute("drop role anon")


@pytest.fixture
def db(database):
    database.execute(
        "truncate table public.equipment_requests, public.equipment, "
        "public.events, public.profiles cascade"
    )
    database.execute(
        "insert into public.profiles (id, full_name) values (%s, 'Organiser')",
        (ORGANISER_ID,),
    )
    database.execute(
        "insert into public.events (id, organiser_id, coordinator_id, name, status) "
        "values (%s, %s, %s, 'Bootcamp', 'planning')",
        (EVENT_ID, ORGANISER_ID, COORDINATOR_ID),
    )
    database.execute(
        "insert into public.event_sessions (id, event_id, name, start_time, end_time) "
        "values (%s, %s, 'Lab', %s, %s)",
        (SESSION_ID, EVENT_ID, START, END),
    )
    return database


def _sign_in(db, user_id):
    db.execute("select set_config('request.jwt.claim.sub', %s, false)", (user_id,))


def _item(db, name, kind=None, status="Functional"):
    return db.execute(
        "insert into public.equipment (name, type, maintenance_status) "
        "values (%s, %s, %s) returning id",
        (name, kind if kind is not None else name, status),
    ).fetchone()[0]


def _submit(db, lines):
    _sign_in(db, COORDINATOR_ID)
    return db.execute(
        "select public.submit_equipment_request_lines(%s, %s, %s::jsonb)",
        (EVENT_ID, SESSION_ID, json.dumps(lines)),
    ).fetchone()[0]


def _book(db, equipment_id, request_id):
    _sign_in(db, TECH_ID)
    return db.execute(
        "select public.create_equipment_booking(%s, %s, %s, %s)",
        (equipment_id, request_id, START, END),
    ).fetchone()[0]


def _book_for_line(db, equipment_id, request_id, line_id):
    _sign_in(db, TECH_ID)
    return db.execute(
        "select public.create_equipment_booking(%s, %s, %s, %s, %s)",
        (equipment_id, request_id, START, END, line_id),
    ).fetchone()[0]


def _line_id(db, request_id, item_name):
    return db.execute(
        "select id from public.equipment_request_lines "
        "where request_id = %s and item_name = %s",
        (request_id, item_name),
    ).fetchone()[0]


def _approve(db, request_id):
    _sign_in(db, TECH_ID)
    return db.execute(
        "select public.review_equipment_request(%s, 'Approved')", (request_id,)
    ).fetchone()[0]


def test_old_equipment_gets_its_new_type_from_the_migration(database):
    # Added before the migration in the fixture. This test runs first in this
    # file, before the db fixture clears the table.
    kinds = dict(database.execute("select name, type from public.equipment").fetchall())
    # The type is tidied, but the migration leaves every name as it was.
    assert kinds == {"Old Projector": "Projector", " Speaker ": "Speaker"}


def test_an_item_without_a_type_counts_as_its_name(db):
    equipment_id = _item(db, "  Speaker ", "  ")
    kind = db.execute(
        "select type from public.equipment where id = %s", (equipment_id,)
    ).fetchone()[0]
    assert kind == "Speaker"


def test_lines_are_saved_with_a_summary_for_other_pages(db):
    request_id = _submit(db, [
        {"item_name": " Projector ", "quantity": 2, "specifics": " HDMI "},
        {"item_name": "Fog machine", "quantity": 1, "specifics": None},
    ])

    lines = db.execute(
        "select item_name, quantity, specifics from public.equipment_request_lines "
        "where request_id = %s order by item_name",
        (request_id,),
    ).fetchall()
    assert lines == [("Fog machine", 1, None), ("Projector", 2, "HDMI")]

    summary = db.execute(
        "select request_details from public.equipment_requests where id = %s",
        (request_id,),
    ).fetchone()[0]
    assert summary == "2 x Projector (HDMI); 1 x Fog machine"


def test_the_same_item_cannot_be_listed_twice(db):
    with pytest.raises(Exception, match="equipment_request_lines_one_per_item"):
        _submit(db, [
            {"item_name": "Projector", "quantity": 1},
            {"item_name": "projector", "quantity": 1},
        ])


def test_allocating_counts_towards_the_matching_line_and_stops_when_full(db):
    first = _item(db, "Projector A", "Projector")
    second = _item(db, "Projector B", "Projector")
    request_id = _submit(db, [{"item_name": "projector", "quantity": 1}])

    booked = _book(db, first, request_id)

    line_id = db.execute(
        "select id from public.equipment_request_lines where request_id = %s",
        (request_id,),
    ).fetchone()[0]
    assert booked["outcome"] == "booked"
    assert booked["booking"]["line_id"] == str(line_id)
    with pytest.raises(Exception, match="have already been allocated"):
        _book(db, second, request_id)


def test_equipment_outside_the_request_cannot_be_allocated(db):
    speaker = _item(db, "Speaker")
    request_id = _submit(db, [{"item_name": "Projector", "quantity": 1}])

    with pytest.raises(Exception, match="is not part of this request"):
        _book(db, speaker, request_id)


def test_something_not_in_the_catalogue_can_be_allocated_once_added(db):
    request_id = _submit(db, [{"item_name": "Fog machine", "quantity": 1}])
    added = _item(db, "Fog machine")

    assert _book(db, added, request_id)["outcome"] == "booked"
    assert _approve(db, request_id)["status"] == "Approved"


def test_an_existing_item_can_fill_an_other_line(db):
    smoke = _item(db, "Smoke Machine")
    request_id = _submit(db, [{"item_name": "Fog machine", "quantity": 1}])
    line_id = _line_id(db, request_id, "Fog machine")

    booked = _book_for_line(db, smoke, request_id, line_id)

    assert booked["booking"]["line_id"] == str(line_id)
    assert _approve(db, request_id)["status"] == "Approved"
    kind = db.execute(
        "select type from public.equipment where id = %s", (smoke,)
    ).fetchone()[0]
    assert kind == "Smoke Machine"


def test_a_different_item_cannot_fill_a_line_the_catalogue_can_fill(db):
    _item(db, "Projector")
    speaker = _item(db, "Speaker")
    request_id = _submit(db, [{"item_name": "Projector", "quantity": 1}])
    line_id = _line_id(db, request_id, "Projector")

    with pytest.raises(Exception, match="cannot fill this line"):
        _book_for_line(db, speaker, request_id, line_id)


def test_an_other_line_cannot_be_overfilled(db):
    first = _item(db, "Smoke Machine")
    second = _item(db, "Haze Machine")
    request_id = _submit(db, [{"item_name": "Fog machine", "quantity": 1}])
    line_id = _line_id(db, request_id, "Fog machine")
    _book_for_line(db, first, request_id, line_id)

    with pytest.raises(Exception, match="have already been allocated"):
        _book_for_line(db, second, request_id, line_id)


def test_a_line_from_another_request_cannot_be_used(db):
    smoke = _item(db, "Smoke Machine")
    request_id = _submit(db, [{"item_name": "Fog machine", "quantity": 1}])

    with pytest.raises(Exception, match="is not part of this request"):
        _book_for_line(db, smoke, request_id, "99999999-9999-9999-9999-999999999999")


def test_approval_waits_until_every_line_is_full(db):
    first = _item(db, "Projector A", "Projector")
    second = _item(db, "Projector B", "Projector")
    request_id = _submit(db, [{"item_name": "Projector", "quantity": 2}])
    _book(db, first, request_id)

    with pytest.raises(Exception, match="Allocate all the requested equipment"):
        _approve(db, request_id)

    _book(db, second, request_id)
    assert _approve(db, request_id)["status"] == "Approved"


def test_removing_an_allocation_opens_the_line_again(db):
    first = _item(db, "Projector A", "Projector")
    request_id = _submit(db, [{"item_name": "Projector", "quantity": 1}])
    booking_id = _book(db, first, request_id)["booking"]["id"]
    db.execute("delete from public.equipment_bookings where id = %s", (booking_id,))

    with pytest.raises(Exception, match="Allocate all the requested equipment"):
        _approve(db, request_id)


def test_a_text_only_request_is_still_not_held_to_lines(db):
    db.execute(
        "insert into public.equipment_requests (id, event_id, session_id, coordinator_id, "
        "request_details) values (%s, %s, %s, %s, '2 microphones')",
        ("66666666-6666-6666-6666-666666666666", EVENT_ID, SESSION_ID, COORDINATOR_ID),
    )
    speaker = _item(db, "Speaker")

    booked = _book(db, speaker, "66666666-6666-6666-6666-666666666666")

    assert booked["outcome"] == "booked"
    assert booked["booking"]["line_id"] is None


def test_the_review_queue_includes_lines_and_which_line_each_booking_fills(db):
    first = _item(db, "Projector A", "Projector")
    request_id = _submit(db, [{"item_name": "Projector", "quantity": 2, "specifics": "HDMI"}])
    _book(db, first, request_id)

    queue = db.execute("select public.list_equipment_request_review_queue()").fetchone()[0]

    assert queue[0]["lines"][0]["item_name"] == "Projector"
    assert queue[0]["lines"][0]["specifics"] == "HDMI"
    assert queue[0]["equipment_bookings"][0]["line_id"] == queue[0]["lines"][0]["id"]
