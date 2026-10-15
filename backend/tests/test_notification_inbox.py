"""Tests for the notification inbox (T7-184).

Route tests replace the service functions; service tests replace the
Supabase client. Nothing here reaches Supabase.
"""

from types import SimpleNamespace

import pytest
from postgrest import APIError as PostgrestAPIError

from models.notification import Notification
from services import auth_service, notification_service

USER_ID = "11111111-1111-1111-1111-111111111111"
NOTIFICATION_ID = "44444444-4444-4444-4444-444444444444"
OLDER_ID = "55555555-5555-5555-5555-555555555555"

NEWER_RECORD = {
    "id": NOTIFICATION_ID,
    "user_id": USER_ID,
    "event_id": None,
    "type": "event_approved",
    "title": "Your event was approved",
    "body": "Your event request has been approved.",
    "is_read": False,
    "created_at": "2026-10-16T10:00:00+00:00",
}

OLDER_RECORD = {
    **NEWER_RECORD,
    "id": OLDER_ID,
    "title": "Coordinator assigned",
    "is_read": True,
    "created_at": "2026-10-15T10:00:00+00:00",
}


def authenticate(monkeypatch):
    """Skip real token verification for route tests."""
    monkeypatch.setattr(auth_service, "get_user_id", lambda access_token: USER_ID)


class FakeQuery:
    """Records the calls the service makes and returns a fixed result."""

    def __init__(self, data=None, error=None):
        self.data = data or []
        self.error = error
        self.calls = []

    def __getattr__(self, name):
        def record(*args, **kwargs):
            self.calls.append((name, args, kwargs))
            return self

        return record

    def execute(self):
        if self.error:
            raise self.error
        return SimpleNamespace(data=self.data)


def use_fake_client(monkeypatch, query):
    client = SimpleNamespace(table=lambda name: query)
    monkeypatch.setattr(
        notification_service.config, "get_user_client", lambda token: client
    )


# ============================================================================
# Routes
# ============================================================================


def test_inbox_requires_login(client):
    response = client.get("/notifications")
    assert response.status_code == 401


def test_inbox_lists_notifications_with_unread_count(client, monkeypatch):
    authenticate(monkeypatch)
    monkeypatch.setattr(
        notification_service,
        "list_notifications",
        lambda token: [Notification(**NEWER_RECORD), Notification(**OLDER_RECORD)],
    )

    response = client.get(
        "/notifications", headers={"Authorization": "Bearer token"}
    )

    assert response.status_code == 200
    body = response.get_json()
    assert [n["id"] for n in body["notifications"]] == [NOTIFICATION_ID, OLDER_ID]
    assert body["unread_count"] == 1


def test_empty_inbox_returns_empty_list(client, monkeypatch):
    authenticate(monkeypatch)
    monkeypatch.setattr(notification_service, "list_notifications", lambda token: [])

    response = client.get(
        "/notifications", headers={"Authorization": "Bearer token"}
    )

    assert response.status_code == 200
    assert response.get_json() == {"notifications": [], "unread_count": 0}


def test_mark_read_returns_updated_notification(client, monkeypatch):
    authenticate(monkeypatch)
    monkeypatch.setattr(
        notification_service,
        "mark_read",
        lambda token, notification_id: Notification(
            **{**NEWER_RECORD, "is_read": True}
        ),
    )

    response = client.patch(
        f"/notifications/{NOTIFICATION_ID}/read",
        headers={"Authorization": "Bearer token"},
    )

    assert response.status_code == 200
    assert response.get_json()["notification"]["is_read"] is True


def test_mark_read_requires_login(client):
    response = client.patch(f"/notifications/{NOTIFICATION_ID}/read")
    assert response.status_code == 401


def test_mark_read_with_malformed_id_is_not_found(client, monkeypatch):
    authenticate(monkeypatch)

    response = client.patch(
        "/notifications/not-a-uuid/read",
        headers={"Authorization": "Bearer token"},
    )

    assert response.status_code == 404


# ============================================================================
# Service
# ============================================================================


def test_list_notifications_orders_newest_first(monkeypatch):
    query = FakeQuery(data=[NEWER_RECORD, OLDER_RECORD])
    use_fake_client(monkeypatch, query)

    notifications = notification_service.list_notifications("token")

    assert [n.id for n in notifications] == [NOTIFICATION_ID, OLDER_ID]
    assert ("order", ("created_at",), {"desc": True}) in query.calls


def test_list_notifications_database_error_is_502(monkeypatch):
    query = FakeQuery(error=PostgrestAPIError({"message": "boom"}))
    use_fake_client(monkeypatch, query)

    with pytest.raises(auth_service.AuthError) as error:
        notification_service.list_notifications("token")
    assert error.value.status_code == 502


def test_mark_read_sets_is_read_on_that_notification(monkeypatch):
    query = FakeQuery(data=[{**NEWER_RECORD, "is_read": True}])
    use_fake_client(monkeypatch, query)

    notification = notification_service.mark_read("token", NOTIFICATION_ID)

    assert notification.is_read is True
    assert ("update", ({"is_read": True},), {}) in query.calls
    assert ("eq", ("id", NOTIFICATION_ID), {}) in query.calls


def test_mark_read_on_someone_elses_notification_is_not_found(monkeypatch):
    # Row-level security hides other users' rows, so the update matches nothing.
    query = FakeQuery(data=[])
    use_fake_client(monkeypatch, query)

    with pytest.raises(auth_service.AuthError) as error:
        notification_service.mark_read("token", NOTIFICATION_ID)
    assert error.value.status_code == 404
