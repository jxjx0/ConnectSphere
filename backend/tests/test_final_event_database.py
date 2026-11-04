"""Current event migration chain on disposable PostgreSQL, including real RLS."""

from contextlib import contextmanager
import json
import os
from pathlib import Path
from uuid import UUID, uuid4

import pytest


ROOT = Path(__file__).resolve().parents[2]
ORGANISER = UUID(int=1)
COORDINATOR = UUID(int=2)
OTHER_COORDINATOR = UUID(int=3)
ATTENDEE = UUID(int=4)
EVENT = UUID(int=10)
SESSION = UUID(int=11)
MIGRATIONS = (
    "events.sql", "event_drafts.sql", "event_review.sql", "event_sessions.sql",
    "event_change_requests.sql", "event_change_request_sessions.sql",
    "event_change_review.sql", "event_statuses.sql",
    "event_clarifications.sql", "event_cancellation_requests.sql",
    "event_registration.sql", "attendee_registrations.sql", "event_cancellation_review.sql",
    "event_request_expiry.sql", "event_completion.sql", "event_status_badges.sql",
    "change_request_in_safety_check.sql", "registration_withdrawal.sql",
    "event_safety_queue_tracking.sql",
)


@contextmanager
def event_database(*, broad_table_defaults=False):
    url = os.environ.get("CANCELLATION_TEST_DATABASE_URL")
    if not url:
        pytest.skip("CANCELLATION_TEST_DATABASE_URL is not configured")
    psycopg = pytest.importorskip("psycopg")
    name = "final_event_test_" + uuid4().hex
    with psycopg.connect(url, autocommit=True) as admin:
        admin.execute(f"create database {name}")
        for role in ("anon", "authenticated", "service_role"):
            if not admin.execute("select 1 from pg_roles where rolname = %s", (role,)).fetchone():
                admin.execute(f"create role {role}" + (" bypassrls" if role == "service_role" else ""))
    connection = psycopg.connect(psycopg.conninfo.make_conninfo(url, dbname=name), autocommit=True)
    try:
        connection.execute((ROOT / "backend/tests/sql/event_workflow_dependencies.sql").read_text())
        if broad_table_defaults:
            # Exercise the migration against an installer that grants broad
            # application-role permissions to every new public table.
            connection.execute("alter default privileges in schema public grant all on tables to anon, authenticated, service_role")
        for migration in MIGRATIONS:
            connection.execute((ROOT / "database" / migration).read_text(encoding="utf-8"))
        for user, role in ((ORGANISER, "organiser"), (COORDINATOR, "coordinator"),
                           (OTHER_COORDINATOR, "coordinator"), (ATTENDEE, "attendee")):
            connection.execute("insert into public.profiles values (%s, %s, 'Test user')", (user, role))
        yield connection
    finally:
        connection.close()
        with psycopg.connect(url, autocommit=True) as admin:
            admin.execute(f"drop database {name}")


@pytest.fixture(scope="module")
def final_database():
    with event_database() as connection:
        yield connection


def test_current_migration_chain_rebuilds_without_unversioned_prerequisites():
    with event_database() as connection:
        assert connection.execute("select to_regprocedure('public.complete_ended_events()') is not null").fetchone() == (True,)


@pytest.fixture
def db(final_database):
    with final_database.transaction(force_rollback=True):
        yield final_database


@contextmanager
def signed_in(db, user, role="authenticated"):
    assert role in {"anon", "authenticated", "service_role"}
    with db.transaction():
        db.execute("select set_config('request.jwt.claim.sub', %s, true)", (str(user) if user else "",))
        db.execute(f"set local role {role}")
        yield
        db.execute("reset role")


def event(db, status="confirmed", end="-1 hour", start="-2 hours"):
    db.execute("""
        insert into public.events(id, organiser_id, coordinator_id, name, description,
            purpose, category, start_time, end_time, expected_attendance, status)
        values (%s,%s,%s,'Workshop','Original','Learning','workshop',
            now()+%s::interval,now()+%s::interval,20,%s)
    """, (EVENT, ORGANISER, COORDINATOR, start, end, status))
    db.execute("""
        insert into public.event_sessions(id,event_id,name,start_time,end_time,expected_attendance)
        select %s,id,'Main',start_time,end_time,expected_attendance from public.events where id=%s
    """, (SESSION, EVENT))


def complete(db):
    with signed_in(db, None, "service_role"):
        return db.execute("select public.complete_ended_events()").fetchone()[0]


def state(db):
    return db.execute("select status, completed_at, updated_at from public.events where id=%s", (EVENT,)).fetchone()


def change(db, attendance=20):
    start, end = db.execute("select start_time, end_time from public.event_sessions where id=%s", (SESSION,)).fetchone()
    return {"name": "Workshop", "description": "Revised", "purpose": "Learning",
            "category": "workshop", "reason_for_change": "Updated plans", "sessions": [{
                "session_id": str(SESSION), "name": "Main", "start_time": start.isoformat(),
                "end_time": end.isoformat(), "expected_attendance": attendance,
            }]}


def submit_change(db, attendance=20):
    payload = change(db, attendance)
    with signed_in(db, ORGANISER):
        return db.execute("select public.submit_session_change_request(%s,%s::jsonb)",
                          (EVENT, json.dumps(payload))).fetchone()[0]


def test_final_completion_uses_processing_time_and_is_idempotent(db):
    event(db)
    now = db.execute("select now()").fetchone()[0]
    assert complete(db) == 1
    assert state(db) == ("completed", now, now)
    assert complete(db) == 0
    assert state(db) == ("completed", now, now)


@pytest.mark.parametrize("status", ["draft", "under_review", "planning", "awaiting_safety_check", "rejected", "cancelled", "completed"])
def test_final_completion_never_completes_an_unconfirmed_stage(db, status):
    event(db, status)
    before = state(db)
    assert complete(db) == 0
    assert state(db) == before


@pytest.mark.parametrize("end", ["0 seconds", "1 hour"])
def test_completion_waits_until_strictly_after_the_last_session(db, end):
    event(db, end=end)
    before = state(db)
    assert complete(db) == 0
    assert state(db) == before


@pytest.mark.parametrize("role,user", [("anon", None), ("authenticated", ORGANISER), ("authenticated", COORDINATOR), ("authenticated", ATTENDEE)])
def test_completion_is_not_an_application_user_action(db, role, user):
    event(db)
    before = state(db)
    with pytest.raises(Exception, match="permission denied"):
        with signed_in(db, user, role):
            db.execute("select public.complete_ended_events()")
    assert state(db) == before


def test_completion_expires_all_open_request_types_and_closes_them(db):
    event(db)
    submit_change(db)
    with signed_in(db, ORGANISER):
        db.execute("select public.submit_event_cancellation_request(%s,'Cancel')", (EVENT,))
    db.execute("insert into public.event_clarifications(event_id,organiser_id,coordinator_id,coordinator_notes) values (%s,%s,%s,'Explain')", (EVENT, ORGANISER, COORDINATOR))
    now = db.execute("select now()").fetchone()[0]
    assert complete(db) == 1
    assert state(db)[0] == "completed"
    for table in ("event_change_requests", "event_cancellation_requests", "event_clarifications"):
        assert db.execute(f"select status,closed_at,closed_by from public.{table} where event_id=%s", (EVENT,)).fetchall() == [("expired", now, None)]


@pytest.mark.parametrize("status", ["under_review", "planning", "awaiting_safety_check", "confirmed"])
def test_final_change_submission_preserves_the_workflow_stage(db, status):
    event(db, status, end="1 day")
    request = submit_change(db)
    assert state(db)[0] == status
    assert db.execute("select event_id,status,description from public.event_change_requests where id=%s", (request,)).fetchone() == (EVENT, "pending", "Revised")


@pytest.mark.parametrize("user", [ATTENDEE, OTHER_COORDINATOR])
def test_unrelated_users_cannot_submit_or_review_someone_elses_change(db, user):
    event(db, "awaiting_safety_check", end="1 day")
    request = submit_change(db)
    before = state(db)
    for sql, params in (("select public.submit_session_change_request(%s,%s::jsonb)", (EVENT, json.dumps(change(db)))),
                        ("select public.approve_session_change_request(%s)", (EVENT,))):
        with pytest.raises(Exception, match="Only|not found"):
            with signed_in(db, user):
                db.execute(sql, params)
    assert state(db) == before
    assert db.execute("select status from public.event_change_requests where id=%s", (request,)).fetchone() == ("pending",)


@pytest.mark.parametrize("attendance,expected,returned", [(20,"awaiting_safety_check",False),(30,"planning",True)])
def test_final_change_approval_rechecks_materiality_in_the_safety_queue(db, attendance, expected, returned):
    event(db, "awaiting_safety_check", end="1 day", start="1 hour")
    request = submit_change(db, attendance)
    with signed_in(db, COORDINATOR):
        result = db.execute("select public.approve_session_change_request(%s)", (EVENT,)).fetchone()[0]
    assert result["returned_to_planning"] is returned
    assert state(db)[0] == expected
    assert db.execute("select status,closed_by from public.event_change_requests where id=%s", (request,)).fetchone() == ("approved", COORDINATOR)
    assert db.execute("select description,expected_attendance from public.events where id=%s", (EVENT,)).fetchone() == ("Revised", attendance)


def test_pending_change_blocks_forward_progress_without_changing_the_stage(db):
    event(db, "planning", end="1 day")
    submit_change(db)
    with pytest.raises(Exception, match="Close the open clarification"):
        with db.transaction():
            db.execute("update public.events set status='awaiting_safety_check' where id=%s", (EVENT,))
    assert state(db)[0] == "planning"


def test_proposal_migration_removes_powerful_privileges_even_with_broad_defaults():
    with event_database(broad_table_defaults=True) as connection:
        import psycopg

        privileges = connection.execute("""
            select case when acl.grantee = 0 then 'PUBLIC'
                        else pg_get_userbyid(acl.grantee) end, acl.privilege_type
            from pg_class relation
            cross join lateral aclexplode(relation.relacl) acl
            where relation.oid = 'public.event_change_request_sessions'::regclass
              and acl.grantee <> relation.relowner
        """).fetchall()
        assert privileges == [("authenticated", "SELECT")]
        for role, user in (("anon", None), ("authenticated", ORGANISER), ("service_role", None)):
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                with signed_in(connection, user, role):
                    connection.execute("truncate public.event_change_request_sessions")


@pytest.mark.parametrize("user,visible", [
    (ORGANISER, True), (COORDINATOR, True), (OTHER_COORDINATOR, False), (ATTENDEE, False),
])
def test_proposal_reads_follow_the_parent_request_rls(db, user, visible):
    event(db, "planning", end="1 day", start="1 hour")
    request = submit_change(db)
    with signed_in(db, user):
        rows = db.execute("select name, session_id from public.event_change_request_sessions where change_request_id=%s", (request,)).fetchall()
    assert rows == ([("Main", SESSION)] if visible else [])


def test_coordinator_can_reject_via_rpc_without_direct_proposal_write_privileges(db):
    event(db, "planning", end="1 day", start="1 hour")
    request = submit_change(db)
    with signed_in(db, COORDINATOR):
        db.execute("select public.reject_event_change_request(%s,%s)", (EVENT, "Resources unavailable"))
    assert db.execute("select status, closed_by, decision_reason from public.event_change_requests where id=%s", (request,)).fetchone() == ("rejected", COORDINATOR, "Resources unavailable")
    with signed_in(db, ORGANISER):
        assert db.execute("select name from public.event_change_request_sessions where change_request_id=%s", (request,)).fetchall() == [("Main",)]
