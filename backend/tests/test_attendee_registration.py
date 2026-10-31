"""Tests for an Attendee browsing published events and registering for one."""

from types import SimpleNamespace

import pytest
from postgrest import APIError
from pydantic import ValidationError
from supabase import AuthApiError

import config
from fake_supabase import FakeDatabase
from models.attendee_registration import (
    AttendeeRegistration,
    AttendeeRegistrationSubmit,
    PublishedEvent,
)
from models.profile import Profile, Role
from services import attendee_registration_service, auth_service, notification_service
from services.auth_service import AuthError

EVENT_ID = "33333333-3333-3333-3333-333333333333"
ATTENDEE_ID = "44444444-4444-4444-4444-444444444444"
REGISTRATION_ID = "55555555-5555-5555-5555-555555555555"

ATTENDEE = Profile(id=ATTENDEE_ID, full_name="Cara Ng", role=Role.ATTENDEE)
ORGANISER = Profile(
    id="11111111-1111-1111-1111-111111111111",
    full_name="Ada Tan",
    role=Role.ORGANISER,
)
HEADERS = {"Authorization": "Bearer attendee-token"}


def valid_details(**overrides) -> dict:
    return {
        "full_name": "Cara Ng",
        "contact_number": "+65 9123 4567",
        **overrides,
    }


def authenticate_as(monkeypatch, profile: Profile) -> None:
    monkeypatch.setattr(auth_service, "get_user_id", lambda access_token: profile.id)
    monkeypatch.setattr(
        auth_service, "get_profile", lambda access_token, user_id: profile
    )


def _event_row(**overrides) -> dict:
    return {
        "id": EVENT_ID,
        "name": "Annual Client Summit",
        "status": "confirmed",
        "description": "A day of talks.",
        "category": "conference",
        "start_time": "2099-12-01T09:00:00+00:00",
        "end_time": "2099-12-01T17:00:00+00:00",
        "registration_opens_at": "2099-11-01T09:00:00+00:00",
        "registration_closes_at": "2099-11-20T09:00:00+00:00",
        "attendee_capacity": 100,
        "spots_left": 99,
        "is_registered": False,
        "sessions": [
            {
                "id": "66666666-6666-6666-6666-666666666666",
                "name": "Main programme",
                "start_time": "2099-12-01T09:00:00+00:00",
                "end_time": "2099-12-01T17:00:00+00:00",
                "venue_name": "Hall",
                "venue_location": "Campus West",
            }
        ],
        **overrides,
    }


def _registration_row(**overrides) -> dict:
    return {
        "id": REGISTRATION_ID,
        "event_id": EVENT_ID,
        "attendee_id": ATTENDEE_ID,
        **valid_details(),
        "email": "cara@example.com",
        "event_name": "Annual Client Summit",
        "event_start_time": "2099-12-01T01:00:00+00:00",
        "event_end_time": "2099-12-01T09:00:00+00:00",
        "event_status": "confirmed",
        **overrides,
    }


def use_database(monkeypatch, responses) -> FakeDatabase:
    database = FakeDatabase(responses)
    monkeypatch.setattr(config, "get_user_client", lambda access_token: database.client)
    return database


def register(details=None) -> AttendeeRegistration:
    return attendee_registration_service.register_for_event(
        "token", EVENT_ID, AttendeeRegistrationSubmit(**(details or valid_details()))
    )


# --- Model -------------------------------------------------------------------


def test_valid_details_are_trimmed():
    details = AttendeeRegistrationSubmit(**valid_details(full_name="  Cara Ng "))
    assert details.full_name == "Cara Ng"


def test_a_submitted_email_is_ignored():
    # The database always registers under the account email.
    details = AttendeeRegistrationSubmit(**valid_details(email="other@example.com"))
    assert not hasattr(details, "email")


def test_a_missing_or_blank_full_name_is_required():
    missing = valid_details()
    del missing["full_name"]
    for body in (missing, valid_details(full_name="   ")):
        with pytest.raises(ValidationError) as caught:
            AttendeeRegistrationSubmit(**body)
        assert "Full name is required" in str(caught.value)


@pytest.mark.parametrize("contact_number", [None, "", "   "])
def test_the_contact_number_is_optional(contact_number):
    details = AttendeeRegistrationSubmit(
        **valid_details(contact_number=contact_number)
    )
    assert details.contact_number is None


def test_a_missing_contact_number_is_allowed():
    body = valid_details()
    del body["contact_number"]
    assert AttendeeRegistrationSubmit(**body).contact_number is None


def test_a_given_contact_number_is_trimmed():
    details = AttendeeRegistrationSubmit(
        **valid_details(contact_number=" +65 9123 4567 ")
    )
    assert details.contact_number == "+65 9123 4567"


def test_a_submitted_address_is_ignored():
    details = AttendeeRegistrationSubmit(**valid_details(address="1 Orchard Road"))
    assert not hasattr(details, "address")


@pytest.mark.parametrize(
    "field, value, message",
    [
        ("contact_number", "call me", "Contact number must be a valid phone number"),
        ("contact_number", "1" * 31, "Contact number must be a valid phone number"),
        ("full_name", "x" * 121, "Full name must be 120 characters or fewer"),
    ],
)
def test_invalid_formats_are_rejected(field, value, message):
    with pytest.raises(ValidationError) as caught:
        AttendeeRegistrationSubmit(**valid_details(**{field: value}))
    assert message in str(caught.value)


# --- Routes ------------------------------------------------------------------


def test_attendee_can_list_published_events(client, monkeypatch):
    authenticate_as(monkeypatch, ATTENDEE)
    monkeypatch.setattr(
        attendee_registration_service,
        "list_published_events",
        lambda access_token: [PublishedEvent(**_event_row())],
    )

    response = client.get("/attendee/events", headers=HEADERS)

    assert response.status_code == 200
    event = response.get_json()["events"][0]
    assert event["spots_left"] == 99
    assert event["sessions"][0]["venue_name"] == "Hall"


def test_event_details_include_the_account_email_for_prefilling(client, monkeypatch):
    authenticate_as(monkeypatch, ATTENDEE)
    monkeypatch.setattr(
        attendee_registration_service,
        "get_published_event",
        lambda access_token, event_id: PublishedEvent(**_event_row()),
    )
    monkeypatch.setattr(
        attendee_registration_service,
        "get_account_email",
        lambda access_token: "cara@example.com",
    )

    response = client.get(f"/attendee/events/{EVENT_ID}", headers=HEADERS)

    assert response.status_code == 200
    body = response.get_json()
    assert body["event"]["name"] == "Annual Client Summit"
    assert body["account_email"] == "cara@example.com"


@pytest.mark.parametrize(
    "method, path",
    [
        ("get", "/attendee/events"),
        ("get", f"/attendee/events/{EVENT_ID}"),
        ("post", f"/attendee/events/{EVENT_ID}/registrations"),
        ("get", "/attendee/registrations"),
        ("get", f"/attendee/registrations/{REGISTRATION_ID}"),
    ],
)
def test_only_attendees_can_use_attendee_routes(client, monkeypatch, method, path):
    authenticate_as(monkeypatch, ORGANISER)

    response = getattr(client, method)(path, json=valid_details(), headers=HEADERS)

    assert response.status_code == 403
    assert response.get_json()["error"].startswith("Only Attendees can")


def test_attendee_routes_require_a_token(client):
    response = client.get("/attendee/events")
    assert response.status_code == 401


def test_attendee_can_register_and_is_emailed(client, monkeypatch):
    authenticate_as(monkeypatch, ATTENDEE)
    captured = {}

    def register_for_event(access_token, event_id, details):
        captured.update(event_id=event_id, details=details)
        return AttendeeRegistration(**_registration_row())

    def send_confirmation(registration):
        captured["emailed"] = registration.email
        return True

    monkeypatch.setattr(
        attendee_registration_service, "register_for_event", register_for_event
    )
    monkeypatch.setattr(
        attendee_registration_service,
        "send_registration_confirmation",
        send_confirmation,
    )

    response = client.post(
        f"/attendee/events/{EVENT_ID}/registrations",
        json=valid_details(),
        headers=HEADERS,
    )

    assert response.status_code == 201
    body = response.get_json()
    assert body["registration"]["id"] == REGISTRATION_ID
    assert body["email_sent"] is True
    assert captured["event_id"] == EVENT_ID
    assert captured["emailed"] == "cara@example.com"


def test_invalid_details_are_rejected_before_anything_is_saved(client, monkeypatch):
    authenticate_as(monkeypatch, ATTENDEE)

    def must_not_register(*args):
        raise AssertionError("invalid details must not be saved")

    monkeypatch.setattr(
        attendee_registration_service, "register_for_event", must_not_register
    )

    response = client.post(
        f"/attendee/events/{EVENT_ID}/registrations",
        json={"contact_number": "bad"},
        headers=HEADERS,
    )

    assert response.status_code == 400
    errors = response.get_json()["errors"]
    assert errors == [
        "Full name is required",
        "Contact number must be a valid phone number",
    ]


def test_attendee_can_list_their_registrations(client, monkeypatch):
    authenticate_as(monkeypatch, ATTENDEE)
    monkeypatch.setattr(
        attendee_registration_service,
        "list_my_registrations",
        lambda access_token: [AttendeeRegistration(**_registration_row())],
    )

    response = client.get("/attendee/registrations", headers=HEADERS)

    assert response.status_code == 200
    assert response.get_json()["registrations"][0]["event_name"] == "Annual Client Summit"


def test_attendee_can_view_one_registration(client, monkeypatch):
    authenticate_as(monkeypatch, ATTENDEE)
    monkeypatch.setattr(
        attendee_registration_service,
        "get_my_registration",
        lambda access_token, registration_id: AttendeeRegistration(**_registration_row()),
    )

    response = client.get(f"/attendee/registrations/{REGISTRATION_ID}", headers=HEADERS)

    assert response.status_code == 200
    assert response.get_json()["registration"]["id"] == REGISTRATION_ID


# --- Service: events ---------------------------------------------------------


def test_service_lists_published_events(monkeypatch):
    database = use_database(
        monkeypatch, {("rpc:list_published_events", "rpc"): [_event_row()]}
    )

    events = attendee_registration_service.list_published_events("token")

    assert [event.id for event in events] == [EVENT_ID]
    assert database.calls_to("rpc:list_published_events", "rpc")[0].payload == {}


def test_service_gets_one_event_by_id(monkeypatch):
    database = use_database(
        monkeypatch, {("rpc:list_published_events", "rpc"): [_event_row()]}
    )

    event = attendee_registration_service.get_published_event("token", EVENT_ID)

    assert event.id == EVENT_ID
    call = database.calls_to("rpc:list_published_events", "rpc")[0]
    assert call.payload == {"p_event_id": EVENT_ID}


def test_service_exposes_cancelled_status_for_a_published_event_link(monkeypatch):
    use_database(
        monkeypatch,
        {("rpc:list_published_events", "rpc"): [_event_row(status="cancelled")]},
    )

    event = attendee_registration_service.get_published_event("token", EVENT_ID)

    assert event.status == "cancelled"


def test_service_reports_an_unpublished_event_as_not_found(monkeypatch):
    use_database(monkeypatch, {("rpc:list_published_events", "rpc"): []})

    with pytest.raises(AuthError) as caught:
        attendee_registration_service.get_published_event("token", EVENT_ID)

    assert caught.value.status_code == 404


def test_service_translates_errors_when_listing(monkeypatch):
    use_database(
        monkeypatch,
        {("rpc:list_published_events", "rpc"): APIError(
            {"message": "missing function", "code": "PGRST202"}
        )},
    )

    with pytest.raises(AuthError) as caught:
        attendee_registration_service.list_published_events("token")

    assert caught.value.status_code == 503


def test_service_reads_the_account_email(monkeypatch):
    auth = SimpleNamespace(
        get_user=lambda token: SimpleNamespace(
            user=SimpleNamespace(email="cara@example.com")
        )
    )
    monkeypatch.setattr(config, "get_client", lambda: SimpleNamespace(auth=auth))

    assert attendee_registration_service.get_account_email("token") == "cara@example.com"


def test_service_leaves_the_email_blank_when_it_cannot_be_read(monkeypatch):
    def failing_get_user(token):
        raise AuthApiError("expired", 401, None)

    auth = SimpleNamespace(get_user=failing_get_user)
    monkeypatch.setattr(config, "get_client", lambda: SimpleNamespace(auth=auth))

    assert attendee_registration_service.get_account_email("token") is None


# --- Service: registrations --------------------------------------------------


def test_service_registers_through_the_atomic_function(monkeypatch):
    database = use_database(
        monkeypatch,
        {
            ("rpc:register_for_event", "rpc"): REGISTRATION_ID,
            ("rpc:list_my_registrations", "rpc"): [_registration_row()],
        },
    )

    saved = register()

    assert saved.id == REGISTRATION_ID
    assert saved.event_name == "Annual Client Summit"
    call = database.calls_to("rpc:register_for_event", "rpc")[0]
    assert call.payload == {
        "p_event_id": EVENT_ID,
        "p_full_name": "Cara Ng",
        "p_contact_number": "+65 9123 4567",
    }
    loaded = database.calls_to("rpc:list_my_registrations", "rpc")[0]
    assert loaded.payload == {"p_registration_id": REGISTRATION_ID}


def test_service_registers_without_a_contact_number(monkeypatch):
    database = use_database(
        monkeypatch,
        {
            ("rpc:register_for_event", "rpc"): REGISTRATION_ID,
            ("rpc:list_my_registrations", "rpc"): [
                _registration_row(contact_number=None)
            ],
        },
    )

    saved = register({"full_name": "Cara Ng"})

    assert saved.contact_number is None
    call = database.calls_to("rpc:register_for_event", "rpc")[0]
    assert call.payload["p_contact_number"] is None


def test_service_reports_a_saved_registration_that_cannot_be_loaded(monkeypatch):
    use_database(
        monkeypatch,
        {
            ("rpc:register_for_event", "rpc"): REGISTRATION_ID,
            ("rpc:list_my_registrations", "rpc"): [],
        },
    )

    with pytest.raises(AuthError) as caught:
        register()

    assert caught.value.status_code == 502


@pytest.mark.parametrize(
    "database_message, status_code, next_step",
    [
        ("Event is full", 409, "Choose another event"),
        ("Registration has closed", 409, "Choose another event"),
        ("Registration has not opened yet", 409, "Come back once registration opens"),
        ("This account is already registered for the event", 409, "See My registrations"),
        ("This account has no email address", 409, "Contact support"),
        ("Event was not found", 404, "Choose another event"),
        ("Only a signed-in attendee can register for an event", 403,
         "Log in with an Attendee account"),
    ],
)
def test_service_tells_the_attendee_what_to_do_when_refused(
    monkeypatch, database_message, status_code, next_step
):
    use_database(
        monkeypatch,
        {("rpc:register_for_event", "rpc"): APIError(
            {"message": database_message, "code": "P0001"}
        )},
    )

    with pytest.raises(AuthError) as caught:
        register()

    assert caught.value.status_code == status_code
    assert next_step in caught.value.message


@pytest.mark.parametrize(
    "code, status_code",
    [
        ("23505", 409),
        ("22P02", 404),
        ("23514", 400),
        ("42501", 403),
        ("PGRST202", 503),
        ("XX000", 502),
    ],
)
def test_service_translates_database_errors(monkeypatch, code, status_code):
    use_database(
        monkeypatch,
        {("rpc:register_for_event", "rpc"): APIError(
            {"message": "database error", "code": code}
        )},
    )

    with pytest.raises(AuthError) as caught:
        register()

    assert caught.value.status_code == status_code


def test_service_lists_my_registrations(monkeypatch):
    database = use_database(
        monkeypatch, {("rpc:list_my_registrations", "rpc"): [_registration_row()]}
    )

    registrations = attendee_registration_service.list_my_registrations("token")

    assert [item.id for item in registrations] == [REGISTRATION_ID]
    assert database.calls_to("rpc:list_my_registrations", "rpc")[0].payload == {}


def test_service_gets_one_of_my_registrations(monkeypatch):
    use_database(
        monkeypatch, {("rpc:list_my_registrations", "rpc"): [_registration_row()]}
    )

    registration = attendee_registration_service.get_my_registration(
        "token", REGISTRATION_ID
    )

    assert registration.id == REGISTRATION_ID


@pytest.mark.parametrize(
    "response",
    [[], APIError({"message": "invalid input syntax for type uuid", "code": "22P02"})],
)
def test_service_reports_a_missing_registration_as_not_found(monkeypatch, response):
    use_database(monkeypatch, {("rpc:list_my_registrations", "rpc"): response})

    with pytest.raises(AuthError) as caught:
        attendee_registration_service.get_my_registration("token", "not-mine")

    assert caught.value.status_code == 404


def test_service_translates_errors_when_listing_my_registrations(monkeypatch):
    use_database(
        monkeypatch,
        {("rpc:list_my_registrations", "rpc"): APIError(
            {"message": "missing function", "code": "PGRST202"}
        )},
    )

    with pytest.raises(AuthError) as caught:
        attendee_registration_service.list_my_registrations("token")

    assert caught.value.status_code == 503


# --- Organiser: sign-up count ------------------------------------------------

ORGANISER_HEADERS = {"Authorization": "Bearer organiser-token"}


def test_organiser_sees_how_many_attendees_signed_up(client, monkeypatch):
    authenticate_as(monkeypatch, ORGANISER)
    database = use_database(
        monkeypatch, {("rpc:count_event_registrations", "rpc"): 42}
    )

    response = client.get(
        f"/events/{EVENT_ID}/registrations/count", headers=ORGANISER_HEADERS
    )

    assert response.status_code == 200
    assert response.get_json() == {"registration_count": 42}
    assert database.calls_to("rpc:count_event_registrations", "rpc")[0].payload == {
        "p_event_id": EVENT_ID
    }


def test_organiser_sees_zero_before_anyone_signs_up(client, monkeypatch):
    authenticate_as(monkeypatch, ORGANISER)
    use_database(monkeypatch, {("rpc:count_event_registrations", "rpc"): 0})

    response = client.get(
        f"/events/{EVENT_ID}/registrations/count", headers=ORGANISER_HEADERS
    )

    assert response.status_code == 200
    assert response.get_json() == {"registration_count": 0}


def test_sign_up_count_requires_authentication(client):
    response = client.get(f"/events/{EVENT_ID}/registrations/count")
    assert response.status_code == 401


def test_non_organiser_cannot_see_the_sign_up_count(client, monkeypatch):
    authenticate_as(monkeypatch, ATTENDEE)
    database = use_database(monkeypatch, {})

    response = client.get(f"/events/{EVENT_ID}/registrations/count", headers=HEADERS)

    assert response.status_code == 403
    assert database.calls == []


def test_sign_up_count_of_another_organisers_event_is_not_found(monkeypatch):
    # The database function returns null when the event is not the caller's.
    use_database(monkeypatch, {("rpc:count_event_registrations", "rpc"): None})

    with pytest.raises(AuthError) as caught:
        attendee_registration_service.count_event_registrations("token", EVENT_ID)

    assert caught.value.status_code == 404
    assert caught.value.message == "Event request was not found."


@pytest.mark.parametrize(
    "code, status_code",
    [
        ("42883", 503),
        ("PGRST202", 503),
        ("22P02", 404),
        ("42501", 403),
        ("PGRST301", 403),
        ("XX000", 502),
    ],
)
def test_service_translates_errors_when_counting_sign_ups(
    monkeypatch, code, status_code
):
    use_database(
        monkeypatch,
        {("rpc:count_event_registrations", "rpc"): APIError(
            {"message": "database error", "code": code}
        )},
    )

    with pytest.raises(AuthError) as caught:
        attendee_registration_service.count_event_registrations("token", EVENT_ID)

    assert caught.value.status_code == status_code


# --- Confirmation email ------------------------------------------------------


def test_confirmation_is_emailed_to_the_registered_address(monkeypatch):
    sent = {}

    def fake_try_send_email(to_email, subject, body):
        sent.update(to_email=to_email, subject=subject, body=body)
        return True

    monkeypatch.setattr(notification_service, "try_send_email", fake_try_send_email)
    registration = AttendeeRegistration(
        **_registration_row(email="other@example.com")
    )

    assert attendee_registration_service.send_registration_confirmation(registration)
    assert sent["to_email"] == "other@example.com"
    assert sent["subject"] == "Registration confirmed: Annual Client Summit"
    # 01:00 UTC is 09:00 in Singapore.
    assert "Starts: 01 Dec 2099, 09:00" in sent["body"]
    assert REGISTRATION_ID in sent["body"]


def test_confirmation_email_without_event_times_says_to_be_announced(monkeypatch):
    sent = {}
    monkeypatch.setattr(
        notification_service,
        "try_send_email",
        lambda to_email, subject, body: sent.update(body=body) or True,
    )
    registration = AttendeeRegistration(
        **_registration_row(event_start_time=None, event_end_time=None)
    )

    attendee_registration_service.send_registration_confirmation(registration)

    assert "Starts: To be announced" in sent["body"]


def test_confirmation_email_lists_the_details_given(monkeypatch):
    sent = {}
    monkeypatch.setattr(
        notification_service,
        "try_send_email",
        lambda to_email, subject, body: sent.update(body=body) or True,
    )

    attendee_registration_service.send_registration_confirmation(
        AttendeeRegistration(**_registration_row())
    )

    assert "Contact number: +65 9123 4567" in sent["body"]
    assert "Address" not in sent["body"]


def test_confirmation_email_without_a_contact_number_says_not_given(monkeypatch):
    sent = {}
    monkeypatch.setattr(
        notification_service,
        "try_send_email",
        lambda to_email, subject, body: sent.update(body=body) or True,
    )

    attendee_registration_service.send_registration_confirmation(
        AttendeeRegistration(**_registration_row(contact_number=None))
    )

    assert "Contact number: Not given" in sent["body"]


def test_try_send_email_reports_success(monkeypatch):
    monkeypatch.setattr(notification_service, "send_email", lambda *args: None)
    assert notification_service.try_send_email("a@example.com", "Subject", "Body")


def test_try_send_email_never_raises(monkeypatch):
    def failing_send(*args):
        raise RuntimeError("SendGrid is down")

    monkeypatch.setattr(notification_service, "send_email", failing_send)
    assert notification_service.try_send_email("a@example.com", "Subject", "Body") is False
