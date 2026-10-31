"""PostgreSQL integration tests for cancellation workflow migrations.

Set CANCELLATION_TEST_DATABASE_URL to a disposable PostgreSQL database. The
CI job supplies a fresh database; the tests execute the real migrations and
RPCs rather than a SQL or Supabase mock.
"""

import os
from pathlib import Path
from uuid import UUID

import pytest


ROOT = Path(__file__).resolve().parents[2]
SCHEMA_SQL = ROOT / "backend" / "tests" / "sql" / "cancellation_review_schema.sql"
REQUEST_MIGRATION = ROOT / "database" / "event_cancellation_requests.sql"
REGISTRATION_MIGRATION = ROOT / "database" / "event_registration.sql"
ATTENDEE_REGISTRATION_MIGRATION = ROOT / "database" / "attendee_registrations.sql"
REVIEW_MIGRATION = ROOT / "database" / "event_cancellation_review.sql"

ORGANISER_ID = "11111111-1111-1111-1111-111111111111"
COORDINATOR_ID = "22222222-2222-2222-2222-222222222222"
EVENT_ID = "33333333-3333-3333-3333-333333333333"
OTHER_EVENT_ID = "44444444-4444-4444-4444-444444444444"
ATTENDEE_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
BOOKING_ID = "55555555-5555-5555-5555-555555555555"
OTHER_BOOKING_ID = "66666666-6666-6666-6666-666666666666"
EQUIPMENT_REQUEST_ID = "77777777-7777-7777-7777-777777777777"
OTHER_EQUIPMENT_REQUEST_ID = "88888888-8888-8888-8888-888888888888"
CHANGE_REQUEST_ID = "99999999-9999-9999-9999-999999999999"


@pytest.fixture(scope="session")
def postgres_connection():
    database_url = os.environ.get("CANCELLATION_TEST_DATABASE_URL")
    if not database_url:
        pytest.skip("CANCELLATION_TEST_DATABASE_URL is not configured")
    psycopg = pytest.importorskip("psycopg")
    connection = psycopg.connect(database_url, autocommit=True)

    connection.execute("create role authenticated")
    connection.execute("create role anon")
    for sql_file in (
        SCHEMA_SQL,
        REQUEST_MIGRATION,
        REGISTRATION_MIGRATION,
        ATTENDEE_REGISTRATION_MIGRATION,
        REVIEW_MIGRATION,
    ):
        connection.execute(sql_file.read_text(encoding="utf-8"))

    yield connection
    connection.close()


@pytest.fixture
def db(postgres_connection):
    postgres_connection.execute(
        """
        truncate table
            auth.users,
            public.event_registrations,
            public.event_safety_reviews,
            public.event_change_requests,
            public.equipment_bookings,
            public.equipment_requests,
            public.venue_tentative_holds,
            public.venue_blocks,
            public.venue_bookings,
            public.event_cancellation_requests,
            public.events,
            public.profiles
        restart identity cascade
        """
    )
    postgres_connection.execute(
        "select set_config('request.jwt.claim.sub', %s, false)",
        (COORDINATOR_ID,),
    )
    postgres_connection.execute(
        "select set_config('test.coordinator_id', %s, false)",
        (COORDINATOR_ID,),
    )
    postgres_connection.execute(
        "select set_config('test.organiser_id', %s, false)",
        (ORGANISER_ID,),
    )
    postgres_connection.execute(
        "insert into public.profiles (id, role) "
        "values (%s, 'organiser'), (%s, 'coordinator'), (%s, 'attendee')",
        (ORGANISER_ID, COORDINATOR_ID, ATTENDEE_ID),
    )
    postgres_connection.execute(
        "insert into auth.users (id, email) values (%s, %s)",
        (ATTENDEE_ID, "attendee@example.com"),
    )
    return postgres_connection


def insert_event(db, event_id=EVENT_ID, status="confirmed"):
    db.execute(
        """
        insert into public.events
            (id, organiser_id, coordinator_id, name, status,
             registration_opens_at, registration_closes_at, published_at)
        values (%s, %s, %s, 'Annual Client Summit', %s,
                now() - interval '1 day', now() + interval '30 days', now())
        """,
        (event_id, ORGANISER_ID, COORDINATOR_ID, status),
    )


def insert_cancellation_request(db, previous_status="confirmed"):
    db.execute(
        """
        insert into public.event_cancellation_requests
            (event_id, organiser_id, reason, previous_event_status)
        values (%s, %s, 'Plans have changed', %s)
        """,
        (EVENT_ID, ORGANISER_ID, previous_status),
    )


def review(db, decision):
    return db.execute(
        """
        select public.review_event_cancellation_request(%s, %s, %s)
        """,
        (EVENT_ID, decision, "Coordinator decision"),
    ).fetchone()[0]


def test_submission_rpc_stores_reason_previous_status_and_rejects_forbidden_status(db):
    insert_event(db, status="planning")
    db.execute(
        "select set_config('request.jwt.claim.sub', %s, false)",
        (ORGANISER_ID,),
    )

    request_id = db.execute(
        "select public.submit_event_cancellation_request(%s, %s)",
        (EVENT_ID, "  Plans have changed  "),
    ).fetchone()[0]
    request = db.execute(
        """
        select reason, previous_event_status, status
        from public.event_cancellation_requests where id = %s
        """,
        (request_id,),
    ).fetchone()
    assert request == ("Plans have changed", "planning", "pending")
    assert db.execute(
        "select status from public.events where id = %s", (EVENT_ID,)
    ).fetchone() == ("cancellation_requested",)
    with pytest.raises(Exception, match="A pending cancellation request already exists"):
        db.execute(
            "select public.submit_event_cancellation_request(%s, %s)",
            (EVENT_ID, "A second request"),
        )

    insert_event(db, event_id=OTHER_EVENT_ID, status="under_review")
    with pytest.raises(Exception, match="Event cannot be cancelled"):
        db.execute(
            "select public.submit_event_cancellation_request(%s, %s)",
            (OTHER_EVENT_ID, "Not allowed"),
        )


def test_approval_releases_event_resources_expires_requests_and_closes_registration(db):
    insert_event(db, status="cancellation_requested")
    insert_event(db, event_id=OTHER_EVENT_ID, status="confirmed")
    insert_cancellation_request(db)
    db.execute(
        "insert into public.venue_bookings (booking_id, event_id, status) "
        "values (%s, %s, 'APPROVED'), (%s, %s, 'APPROVED')",
        (BOOKING_ID, EVENT_ID, OTHER_BOOKING_ID, OTHER_EVENT_ID),
    )
    db.execute(
        """
        insert into public.venue_blocks (booking_id, source_booking_id)
        values (%s, null), (null, %s), (%s, null)
        """,
        (BOOKING_ID, BOOKING_ID, OTHER_BOOKING_ID),
    )
    db.execute(
        "insert into public.venue_tentative_holds (event_id) values (%s), (%s)",
        (EVENT_ID, OTHER_EVENT_ID),
    )
    db.execute(
        "insert into public.equipment_requests (id, event_id, status) "
        "values (%s, %s, 'Approved'), (%s, %s, 'Approved')",
        (
            EQUIPMENT_REQUEST_ID,
            EVENT_ID,
            OTHER_EQUIPMENT_REQUEST_ID,
            OTHER_EVENT_ID,
        ),
    )
    db.execute(
        "insert into public.equipment_bookings (request_id) values (%s), (%s)",
        (EQUIPMENT_REQUEST_ID, OTHER_EQUIPMENT_REQUEST_ID),
    )
    db.execute(
        """
        insert into public.event_change_requests
            (id, event_id, status, rejection_reason)
        values (%s, %s, 'pending', 'old reason'),
               (%s, %s, 'pending', null)
        """,
        (CHANGE_REQUEST_ID, EVENT_ID, OTHER_EVENT_ID, OTHER_EVENT_ID),
    )
    db.execute(
        "insert into public.event_registrations "
        "(event_id, attendee_id, full_name, email) values (%s, %s, %s, %s)",
        (EVENT_ID, ATTENDEE_ID, "Casey Attendee", "attendee@example.com"),
    )

    result = review(db, "approve")
    assert result["event"]["status"] == "cancelled"
    assert result["cancellation_request"]["status"] == "approved"
    assert result["cancellation_request"]["decision_reason"] == "Coordinator decision"
    assert db.execute(
        "select attendee_id, email from public.event_registrations "
        "where event_id = %s",
        (EVENT_ID,),
    ).fetchall() == [(UUID(ATTENDEE_ID), "attendee@example.com")]

    db.execute(
        "select set_config('request.jwt.claim.sub', %s, false)",
        (ATTENDEE_ID,),
    )
    assert db.execute(
        "select id from public.list_published_events()"
    ).fetchall() == [(UUID(OTHER_EVENT_ID),)]
    assert db.execute(
        "select id, status from public.list_published_events(%s)",
        (EVENT_ID,),
    ).fetchall() == [(UUID(EVENT_ID), "cancelled")]
    with pytest.raises(Exception, match="Event was not found"):
        with db.transaction():
            db.execute(
                "select public.register_for_event(%s, %s, %s)",
                (EVENT_ID, "Casey Attendee", None),
            )
    assert db.execute(
        "select count(*) from public.event_registrations where event_id = %s",
        (EVENT_ID,),
    ).fetchone() == (1,)

    assert db.execute(
        "select status, registration_closes_at <= now() from public.events "
        "where id = %s",
        (EVENT_ID,),
    ).fetchone() == ("cancelled", True)
    assert db.execute(
        "select status from public.venue_bookings where booking_id = %s",
        (BOOKING_ID,),
    ).fetchone() == ("CANCELLED",)
    assert db.execute(
        "select status from public.venue_bookings where booking_id = %s",
        (OTHER_BOOKING_ID,),
    ).fetchone() == ("APPROVED",)
    assert db.execute("select count(*) from public.venue_blocks").fetchone() == (1,)
    assert db.execute(
        "select event_id, released_at is not null from public.venue_tentative_holds "
        "order by id"
    ).fetchall() == [(UUID(EVENT_ID), True), (UUID(OTHER_EVENT_ID), False)]
    assert db.execute(
        "select count(*) from public.equipment_bookings where request_id = %s",
        (EQUIPMENT_REQUEST_ID,),
    ).fetchone() == (0,)
    assert db.execute(
        "select count(*) from public.equipment_bookings "
        "where request_id = %s",
        (OTHER_EQUIPMENT_REQUEST_ID,),
    ).fetchone() == (1,)
    assert db.execute(
        "select status from public.equipment_requests where id = %s",
        (EQUIPMENT_REQUEST_ID,),
    ).fetchone() == ("Cancelled",)
    assert db.execute(
        "select status, rejection_reason from public.event_change_requests "
        "where id = %s",
        (CHANGE_REQUEST_ID,),
    ).fetchone() == ("expired", None)
    assert db.execute(
        "select count(*) from public.event_change_requests "
        "where event_id = %s and status = 'pending'",
        (OTHER_EVENT_ID,),
    ).fetchone() == (1,)

    db.execute(
        "select set_config('request.jwt.claim.sub', %s, false)",
        (ORGANISER_ID,),
    )
    with pytest.raises(Exception, match="Registration cannot be set up"):
        db.execute(
            """
            select public.save_event_registration(
                %s, now(), now() + interval '1 day', 10, false
            )
            """,
            (EVENT_ID,),
        )
    db.execute(
        "select set_config('request.jwt.claim.sub', %s, false)",
        (COORDINATOR_ID,),
    )

    with pytest.raises(Exception, match="Registration is closed"):
        with db.transaction():
            db.execute(
                "insert into public.event_registrations (event_id, email) "
                "values (%s, %s)",
                (EVENT_ID, "new@example.com"),
            )
    with pytest.raises(Exception, match="Registration cannot be changed"):
        with db.transaction():
            db.execute(
                "update public.events set registration_closes_at = now() + interval '1 day' "
                "where id = %s",
                (EVENT_ID,),
            )


def test_approval_expires_safety_check_when_it_was_awaiting_review(db):
    insert_event(db, status="cancellation_requested")
    insert_cancellation_request(db, previous_status="awaiting_safety_check")

    review(db, "approve")

    assert db.execute(
        "select decision from public.event_safety_reviews where event_id = %s",
        (EVENT_ID,),
    ).fetchall() == [("EXPIRED",)]


def test_approved_cancellation_closes_registration_and_preserves_attendee_record(db):
    insert_event(db, status="cancellation_requested")
    insert_cancellation_request(db)
    db.execute(
        "insert into public.event_registrations "
        "(event_id, attendee_id, full_name, email) values (%s, %s, %s, %s)",
        (EVENT_ID, ATTENDEE_ID, "Casey Attendee", "attendee@example.com"),
    )

    result = review(db, "approve")
    assert result["event"]["status"] == "cancelled"
    assert db.execute(
        "select status, registration_closes_at <= now() "
        "from public.events where id = %s",
        (EVENT_ID,),
    ).fetchone() == ("cancelled", True)

    db.execute(
        "select set_config('request.jwt.claim.sub', %s, false)",
        (ATTENDEE_ID,),
    )
    with pytest.raises(Exception, match="Event was not found"):
        with db.transaction():
            db.execute(
                "select public.register_for_event(%s, %s, %s)",
                (EVENT_ID, "New Attendee", None),
            )

    assert db.execute(
        "select id, status from public.list_published_events(%s)",
        (EVENT_ID,),
    ).fetchall() == [(UUID(EVENT_ID), "cancelled")]
    assert db.execute(
        "select id from public.list_published_events()"
    ).fetchall() == []
    assert db.execute(
        "select event_name, event_status from public.list_my_registrations()"
    ).fetchall() == [("Annual Client Summit", "cancelled")]
    assert db.execute(
        "select count(*) from public.event_registrations where event_id = %s",
        (EVENT_ID,),
    ).fetchone() == (1,)


def test_only_a_coordinator_can_review_a_cancellation_request(db):
    insert_event(db, status="cancellation_requested")
    insert_cancellation_request(db)
    db.execute(
        "select set_config('request.jwt.claim.sub', %s, false)",
        (ORGANISER_ID,),
    )

    with pytest.raises(Exception, match="Only a Coordinator"):
        review(db, "approve")


def test_rejection_restores_prior_status_without_releasing_resources(db):
    insert_event(db, status="cancellation_requested")
    insert_event(db, event_id=OTHER_EVENT_ID, status="confirmed")
    insert_cancellation_request(db, previous_status="awaiting_safety_check")
    db.execute(
        "insert into public.venue_bookings (booking_id, event_id, status) "
        "values (%s, %s, 'APPROVED')",
        (BOOKING_ID, EVENT_ID),
    )
    db.execute(
        "insert into public.venue_tentative_holds (event_id) values (%s)",
        (EVENT_ID,),
    )
    db.execute(
        "insert into public.equipment_requests (id, event_id, status) "
        "values (%s, %s, 'Approved')",
        (EQUIPMENT_REQUEST_ID, EVENT_ID),
    )
    db.execute(
        "insert into public.equipment_bookings (request_id) values (%s)",
        (EQUIPMENT_REQUEST_ID,),
    )
    db.execute(
        "insert into public.event_change_requests (id, event_id, status) "
        "values (%s, %s, 'pending')",
        (CHANGE_REQUEST_ID, EVENT_ID),
    )

    result = review(db, "reject")
    assert result["event"]["status"] == "awaiting_safety_check"
    assert result["cancellation_request"]["status"] == "rejected"
    assert db.execute(
        "select count(*) from public.event_safety_reviews where event_id = %s",
        (EVENT_ID,),
    ).fetchone() == (0,)
    assert db.execute(
        "select status from public.venue_bookings where booking_id = %s",
        (BOOKING_ID,),
    ).fetchone() == ("APPROVED",)
    assert db.execute(
        "select released_at from public.venue_tentative_holds where event_id = %s",
        (EVENT_ID,),
    ).fetchone() == (None,)
    assert db.execute(
        "select count(*) from public.equipment_bookings where request_id = %s",
        (EQUIPMENT_REQUEST_ID,),
    ).fetchone() == (1,)
    assert db.execute(
        "select status from public.event_change_requests where id = %s",
        (CHANGE_REQUEST_ID,),
    ).fetchone() == ("pending",)
