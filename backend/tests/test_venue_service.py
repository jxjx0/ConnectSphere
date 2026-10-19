"""Exercise real venue persistence logic with only the Supabase boundary replaced."""

from types import SimpleNamespace
from unittest.mock import Mock, call
from uuid import uuid4

import pytest
from postgrest import APIError as PostgrestAPIError

import config
from models.venue import Venue, VenueCreateRequest, VenueUpdateRequest
from models.venue_audit import VenueEditHistory
from services import venue_service
from services.auth_service import AuthError


@pytest.fixture
def venue_request(venue_payload):
    return VenueCreateRequest(**venue_payload)


@pytest.fixture
def venue_record(venue_request):
    return {"id": str(uuid4()), **venue_request.model_dump(mode="json")}


@pytest.fixture
def access_token():
    return f"test-token-{uuid4()}"


@pytest.fixture
def database(monkeypatch):
    client = Mock(spec=["table", "rpc"])
    client.rpc.return_value.execute.return_value = SimpleNamespace(data=[])
    factory = Mock(return_value=client)
    monkeypatch.setattr(config, "get_user_client", factory)
    return client, factory


def query_returning(rows):
    """Provide responses and record requests without implementing database logic."""
    methods = ["insert", "update", "select", "eq", "order", "in_", "execute"]
    query = Mock(spec=methods)
    for name in methods[:-1]:
        getattr(query, name).return_value = query
    query.execute.return_value = SimpleNamespace(data=rows)
    return query


@pytest.mark.parametrize("setup,turnaround", [(0, 0), (30, 45)])
def test_buffer_create_read_update_round_trip(database, access_token, venue_payload, setup, turnaround):
    client, _ = database
    stored = {"id": str(uuid4())}
    query = query_returning([])

    def write(payload):
        stored.update(payload)
        return query

    query.insert.side_effect = write
    query.update.side_effect = write
    query.execute.side_effect = lambda: SimpleNamespace(data=[dict(stored)])
    client.table.return_value = query
    request = VenueCreateRequest(**{
        **venue_payload, "setup_time_minutes": setup, "turnaround_time_minutes": turnaround,
    })
    created = venue_service.create_venue(access_token, request)
    assert (created.setup_time_minutes, created.turnaround_time_minutes) == (setup, turnaround)
    assert venue_service.list_venues(access_token)[0] == created

    # Legacy callers need not know about buffers to rename a venue safely.
    renamed = VenueUpdateRequest(**{**venue_payload, "name": "Renamed Hall"})
    updated = venue_service.update_venue(access_token, created.id, renamed)
    assert updated.name == "Renamed Hall"
    assert (updated.setup_time_minutes, updated.turnaround_time_minutes) == (setup, turnaround)
    assert "setup_time_minutes" not in query.update.call_args.args[0]

    # Explicit zero is a real update, not an omitted value.
    reset = VenueUpdateRequest(**{**venue_payload, "setup_time_minutes": 0})
    updated = venue_service.update_venue(access_token, created.id, reset)
    assert updated.setup_time_minutes == 0
    assert updated.turnaround_time_minutes == turnaround


def test_buffer_history_values_are_returned(database, access_token, history_record):
    client, _ = database
    record = {
        **history_record,
        "changed_fields": ["setup_time_minutes", "turnaround_time_minutes"],
        "old_values": {"setup_time_minutes": 0, "turnaround_time_minutes": 0},
        "new_values": {"setup_time_minutes": 30, "turnaround_time_minutes": 45},
    }
    tables = {
        "venue_edit_history": query_returning([record]),
        "profiles": query_returning([{"id": record["changed_by"], "full_name": "Venue Staff"}]),
    }
    client.table.side_effect = tables.__getitem__
    result = venue_service.get_venue_history(access_token, record["venue_id"])[0]
    assert result.changed_fields == record["changed_fields"]
    assert result.old_values == record["old_values"]
    assert result.new_values == record["new_values"]


def call_service(operation, access_token, venue_record, venue_request):
    if operation == "create":
        return venue_service.create_venue(access_token, venue_request)
    if operation == "update":
        update = VenueUpdateRequest(**venue_request.model_dump())
        return venue_service.update_venue(access_token, venue_record["id"], update)
    if operation == "history":
        return venue_service.get_venue_history(access_token, venue_record["id"])
    if operation == "list":
        return venue_service.list_venues(access_token)
    raise ValueError(f"Unknown venue operation: {operation}")


def test_create_persists_validated_fields_using_the_callers_client(
    database, access_token, venue_request, venue_record
):
    client, factory = database
    query = query_returning([venue_record])
    client.table.return_value = query

    venue = venue_service.create_venue(access_token, venue_request)

    factory.assert_called_once_with(access_token)
    client.table.assert_called_once_with("venues")
    query.insert.assert_called_once_with(venue_request.model_dump(mode="json"))
    query.execute.assert_called_once_with()
    assert isinstance(venue, Venue)
    assert venue.model_dump(mode="json") == venue_record


def test_update_only_targets_the_requested_venue(
    database, access_token, venue_request, venue_record
):
    client, factory = database
    update = VenueUpdateRequest(
        **{**venue_request.model_dump(), "name": "Renamed Hall"}
    )
    updated_record = {"id": venue_record["id"], **update.model_dump(mode="json")}
    query = query_returning([updated_record])
    client.table.return_value = query

    venue = venue_service.update_venue(access_token, venue_record["id"], update)

    factory.assert_called_once_with(access_token)
    assert client.table.call_args_list == [call("venues"), call("venues")]
    query.select.assert_called_once_with("setup_time_minutes, turnaround_time_minutes")
    query.update.assert_called_once_with(update.model_dump(mode="json"))
    assert query.eq.call_args_list == [call("id", venue_record["id"])] * 2
    assert query.execute.call_count == 2
    assert venue.model_dump(mode="json") == updated_record


@pytest.mark.parametrize("rows", [None, []], ids=["null", "empty"])
@pytest.mark.parametrize(
    "operation,status,message",
    [
        ("create", 502, "Venue was not created."),
        ("update", 404, "Venue was not found."),
    ],
)
def test_missing_write_results_raise_an_explicit_error(
    database, access_token, venue_request, venue_record,
    rows, operation, status, message
):
    client, _ = database
    client.table.return_value = query_returning(rows)

    with pytest.raises(AuthError) as caught:
        call_service(operation, access_token, venue_record, venue_request)

    assert caught.value.status_code == status
    assert caught.value.message == message


@pytest.mark.parametrize("operation", ["create", "update", "list", "history"])
@pytest.mark.parametrize(
    "code,status,message",
    [
        ("23505", 409, "A venue with this name already exists."),
        ("23502", 400, "Venue data violates a database validation rule."),
        ("23514", 400, "Venue data violates a database validation rule."),
        ("22P02", 400, "Venue data violates a database validation rule."),
        ("42501", 403, "You do not have permission to perform this venue action."),
        ("PGRST301", 403, "You do not have permission to perform this venue action."),
        ("08006", 502, "Unable to access the venue catalogue."),
    ],
)
def test_database_errors_are_translated_without_leaking_internal_details(
    database, access_token, venue_request, venue_record,
    operation, code, status, message
):
    client, _ = database
    query = query_returning([])
    database_error = PostgrestAPIError(
        {"code": code, "message": "Private database detail"}
    )
    query.execute.side_effect = database_error
    client.table.return_value = query

    with pytest.raises(AuthError) as caught:
        call_service(operation, access_token, venue_record, venue_request)

    assert caught.value.status_code == status
    assert caught.value.message == message
    assert "Private database detail" not in str(caught.value)
    assert caught.value.__cause__ is database_error


@pytest.mark.parametrize("operation", ["create", "update", "list", "history"])
def test_unexpected_errors_are_not_swallowed(
    database, access_token, venue_request, venue_record, operation
):
    client, _ = database
    query = query_returning([])
    unexpected = RuntimeError("Unexpected client failure")
    query.execute.side_effect = unexpected
    client.table.return_value = query

    with pytest.raises(RuntimeError) as caught:
        call_service(operation, access_token, venue_record, venue_request)

    assert caught.value is unexpected


@pytest.mark.parametrize("has_venues", [False, True], ids=["empty", "populated"])
def test_listing_requests_name_order_and_returns_venue_models(
    database, access_token, venue_record, has_venues
):
    client, factory = database
    rows = (
        [venue_record, {**venue_record, "id": str(uuid4()), "name": "Second Hall"}]
        if has_venues
        else []
    )
    query = query_returning(rows)
    client.table.return_value = query

    venues = venue_service.list_venues(access_token)

    factory.assert_called_once_with(access_token)
    client.table.assert_called_once_with("venues")
    query.select.assert_called_once_with("*")
    query.order.assert_called_once_with("name")
    query.execute.assert_called_once_with()
    assert all(isinstance(venue, Venue) for venue in venues)
    assert [venue.model_dump(mode="json") for venue in venues] == rows


@pytest.fixture
def history_record(venue_record):
    return {
        "id": str(uuid4()),
        "venue_id": venue_record["id"],
        "changed_by": str(uuid4()),
        "changed_at": "2026-01-15T10:00:00Z",
        "changed_fields": ["name"],
        "old_values": {"name": venue_record["name"]},
        "new_values": {"name": "Renamed Hall"},
    }


def test_empty_history_does_not_request_profiles(database, access_token, venue_record):
    client, factory = database
    query = query_returning([])
    client.table.return_value = query

    history = venue_service.get_venue_history(access_token, venue_record["id"])

    assert history == []
    factory.assert_called_once_with(access_token)
    client.table.assert_called_once_with("venue_edit_history")
    query.select.assert_called_once_with("*")
    query.eq.assert_called_once_with("venue_id", venue_record["id"])
    query.order.assert_called_once_with("changed_at", desc=True)
    query.execute.assert_called_once_with()


def test_history_resolves_each_distinct_editor_with_one_profile_lookup(
    database, access_token, venue_record, history_record
):
    client, factory = database
    other_editor = str(uuid4())
    rows = [
        history_record,
        {**history_record, "id": str(uuid4()), "changed_by": other_editor},
        {**history_record, "id": str(uuid4())},
    ]
    history_query = query_returning(rows)
    profiles_query = query_returning(
        [
            {"id": history_record["changed_by"], "full_name": "Alex Tan"},
            {"id": other_editor, "full_name": "Sam Lee"},
        ]
    )
    tables = {"venue_edit_history": history_query, "profiles": profiles_query}
    client.table.side_effect = tables.__getitem__

    history = venue_service.get_venue_history(access_token, venue_record["id"])

    factory.assert_called_once_with(access_token)
    assert client.table.call_count == 2
    history_query.eq.assert_called_once_with("venue_id", venue_record["id"])
    history_query.order.assert_called_once_with("changed_at", desc=True)
    profiles_query.select.assert_called_once_with("id, full_name")
    profiles_query.in_.assert_called_once()
    history_query.execute.assert_called_once_with()
    profiles_query.execute.assert_called_once_with()
    field, user_ids = profiles_query.in_.call_args.args
    assert field == "id"
    assert set(user_ids) == {history_record["changed_by"], other_editor}
    assert len(user_ids) == 2
    assert all(isinstance(record, VenueEditHistory) for record in history)
    assert [record.id for record in history] == [row["id"] for row in rows]
    assert [record.changed_by_name for record in history] == [
        "Alex Tan",
        "Sam Lee",
        "Alex Tan",
    ]
    for record, row in zip(history, rows):
        assert record.venue_id == row["venue_id"]
        assert record.changed_fields == row["changed_fields"]
        assert record.old_values == row["old_values"]
        assert record.new_values == row["new_values"]


@pytest.mark.parametrize("profile", ["missing", "no-name", "blank-name", "null-name"])
def test_history_retains_the_record_when_an_editor_name_is_unavailable(
    database, access_token, venue_record, history_record, profile
):
    client, _ = database
    profile_rows = {
        "missing": [],
        "no-name": [{"id": history_record["changed_by"]}],
        "blank-name": [{"id": history_record["changed_by"], "full_name": ""}],
        "null-name": [{"id": history_record["changed_by"], "full_name": None}],
    }
    tables = {
        "venue_edit_history": query_returning([history_record]),
        "profiles": query_returning(profile_rows[profile]),
    }
    client.table.side_effect = tables.__getitem__

    history = venue_service.get_venue_history(access_token, venue_record["id"])

    assert len(history) == 1
    assert history[0].id == history_record["id"]
    assert history[0].changed_by_name == "Unknown user"


def test_profile_lookup_errors_are_translated(
    database, access_token, venue_record, history_record
):
    client, _ = database
    profiles = query_returning([])
    database_error = PostgrestAPIError(
        {"code": "42501", "message": "Private profile detail"}
    )
    profiles.execute.side_effect = database_error
    tables = {
        "venue_edit_history": query_returning([history_record]),
        "profiles": profiles,
    }
    client.table.side_effect = tables.__getitem__

    with pytest.raises(AuthError) as caught:
        venue_service.get_venue_history(access_token, venue_record["id"])

    assert caught.value.status_code == 403
    assert caught.value.message == (
        "You do not have permission to perform this venue action."
    )
    assert caught.value.__cause__ is database_error
