"""PostgreSQL integration tests for remembering who was in the safety queue.

Set CANCELLATION_TEST_DATABASE_URL to a disposable PostgreSQL server, as for
test_event_cancellation_database.py. These tests create their own database on
it and execute the real migration rather than a SQL or Supabase mock.
"""

import os
from pathlib import Path

import pytest


MIGRATION = Path(__file__).resolve().parents[2] / "database" / "event_safety_queue_tracking.sql"
TEST_DATABASE = "event_safety_queue_test"
EVENT_ID = "33333333-3333-3333-3333-333333333333"
WAITING_ID = "44444444-4444-4444-4444-444444444444"


@pytest.fixture(scope="module")
def database():
    database_url = os.environ.get("CANCELLATION_TEST_DATABASE_URL")
    if not database_url:
        pytest.skip("CANCELLATION_TEST_DATABASE_URL is not configured")
    psycopg = pytest.importorskip("psycopg")

    # Roles belong to the whole server, and other test modules create these.
    with psycopg.connect(database_url, autocommit=True) as admin:
        admin.execute(f"drop database if exists {TEST_DATABASE}")
        admin.execute(f"create database {TEST_DATABASE}")
        missing = [
            role for role in ("anon", "authenticated")
            if not admin.execute("select 1 from pg_roles where rolname = %s", (role,)).fetchone()
        ]
        for role in missing:
            admin.execute(f"create role {role}")

    connection = psycopg.connect(
        psycopg.conninfo.make_conninfo(database_url, dbname=TEST_DATABASE),
        autocommit=True,
    )
    connection.execute(
        "create table public.events (id uuid primary key, status text not null, "
        "updated_at timestamptz not null default '2026-01-01T00:00:00Z')"
    )
    connection.execute(
        "insert into public.events (id, status) values (%s, 'awaiting_safety_check')",
        (WAITING_ID,),
    )
    connection.execute(MIGRATION.read_text(encoding="utf-8"))

    yield connection
    connection.close()
    with psycopg.connect(database_url, autocommit=True) as admin:
        admin.execute(f"drop database if exists {TEST_DATABASE}")
        for role in missing:
            admin.execute(f"drop role {role}")


@pytest.fixture
def db(database):
    database.execute("delete from public.events where id = %s", (EVENT_ID,))
    database.execute("insert into public.events (id, status) values (%s, 'planning')", (EVENT_ID,))
    return database


def _move(db, status):
    db.execute("update public.events set status = %s where id = %s", (status, EVENT_ID))


def _requested_at(db, event_id=EVENT_ID):
    return db.execute(
        "select safety_check_requested_at from public.events where id = %s", (event_id,)
    ).fetchone()[0]


def test_an_event_already_waiting_is_recorded_by_the_migration(database):
    assert _requested_at(database, WAITING_ID) is not None


def test_entering_the_queue_is_recorded(db):
    assert _requested_at(db) is None
    _move(db, "awaiting_safety_check")
    assert _requested_at(db) is not None


@pytest.mark.parametrize("status", ["planning", "confirmed"])
def test_moving_on_normally_clears_it(db, status):
    _move(db, "awaiting_safety_check")
    _move(db, status)
    assert _requested_at(db) is None


@pytest.mark.parametrize("status", ["cancelled", "rejected", "completed"])
def test_ending_in_the_queue_keeps_it(db, status):
    _move(db, "awaiting_safety_check")
    _move(db, status)
    assert _requested_at(db) is not None


def test_a_confirmed_event_cancelled_later_was_never_stuck_in_the_queue(db):
    _move(db, "awaiting_safety_check")
    _move(db, "confirmed")
    _move(db, "cancelled")
    assert _requested_at(db) is None


def test_other_updates_leave_it_alone(db):
    _move(db, "awaiting_safety_check")
    before = _requested_at(db)
    db.execute("update public.events set updated_at = now() where id = %s", (EVENT_ID,))
    db.execute("update public.events set status = status where id = %s", (EVENT_ID,))
    assert _requested_at(db) == before
