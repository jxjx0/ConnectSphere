"""Tests for the shared notification service.

Supabase and SendGrid are replaced with fakes, so these tests check our own
logic -- especially that a failed email never loses the in-app notification
and never raises to the caller.
"""

from types import SimpleNamespace

import pytest

from services import notification_service

USER_ID = "11111111-1111-1111-1111-111111111111"
EVENT_ID = "44444444-4444-4444-4444-444444444444"

NOTIFICATION_RECORD = {
    "id": "66666666-6666-6666-6666-666666666666",
    "user_id": USER_ID,
    "event_id": EVENT_ID,
    "type": "event_approved",
    "title": "Your event was approved",
    "body": "Your event request has been approved.",
    "is_read": False,
    "created_at": "2026-10-01T09:00:00+00:00",
}


class FakeAdminClient:
    """Stands in for the service-role Supabase client."""

    def __init__(self, email="ada@example.com", insert_error=None):
        self.inserted = []
        self.insert_error = insert_error
        user = SimpleNamespace(email=email) if email else None
        self.auth = SimpleNamespace(
            admin=SimpleNamespace(
                get_user_by_id=lambda user_id: SimpleNamespace(user=user)
            )
        )

    def table(self, name):
        assert name == "notifications"
        return self

    def insert(self, row):
        self.inserted.append(row)
        return self

    def execute(self):
        if self.insert_error:
            raise self.insert_error
        return SimpleNamespace(data=[NOTIFICATION_RECORD])


@pytest.fixture
def sent_emails(monkeypatch):
    """Record emails instead of sending them through SendGrid."""
    sent = []
    monkeypatch.setattr(
        notification_service,
        "send_email",
        lambda to_email, subject, body: sent.append((to_email, subject, body)),
    )
    return sent


def use_admin_client(monkeypatch, client):
    monkeypatch.setattr(
        notification_service.config, "get_admin_client", lambda: client
    )


def call_notify():
    return notification_service.notify(
        USER_ID,
        "event_approved",
        "Your event was approved",
        "Your event request has been approved.",
        event_id=EVENT_ID,
    )


def test_notify_saves_row_and_sends_email(monkeypatch, sent_emails):
    client = FakeAdminClient()
    use_admin_client(monkeypatch, client)

    notification = call_notify()

    assert notification.id == NOTIFICATION_RECORD["id"]
    assert client.inserted == [
        {
            "user_id": USER_ID,
            "event_id": EVENT_ID,
            "type": "event_approved",
            "title": "Your event was approved",
            "body": "Your event request has been approved.",
        }
    ]
    assert sent_emails == [
        (
            "ada@example.com",
            "Your event was approved",
            "Your event request has been approved.",
        )
    ]


def test_notify_role_sends_to_profiles_with_that_role(monkeypatch):
    recipients = [USER_ID, "77777777-7777-7777-7777-777777777777"]
    captured = []

    class FakeProfiles:
        def table(self, name):
            assert name == "profiles"
            return self

        def select(self, columns):
            assert columns == "id"
            return self

        def eq(self, column, value):
            assert (column, value) == ("role", "event_coordinator_lead")
            return self

        def execute(self):
            return SimpleNamespace(data=[{"id": recipient} for recipient in recipients])

    monkeypatch.setattr(
        notification_service.config,
        "get_admin_client",
        lambda: FakeProfiles(),
    )
    monkeypatch.setattr(
        notification_service,
        "notify",
        lambda *args: captured.append(args),
    )

    notification_service.notify_role(
        "event_coordinator_lead",
        "event_submitted",
        "New event request submitted",
        "A new event request 'Summit' has been submitted for assignment.",
        EVENT_ID,
    )

    assert captured == [
        (
            recipient,
            "event_submitted",
            "New event request submitted",
            "A new event request 'Summit' has been submitted for assignment.",
            EVENT_ID,
        )
        for recipient in recipients
    ]


def test_notify_keeps_row_when_email_fails(monkeypatch, caplog):
    use_admin_client(monkeypatch, FakeAdminClient())

    def failing_send(to_email, subject, body):
        raise RuntimeError("SendGrid is down")

    monkeypatch.setattr(notification_service, "send_email", failing_send)

    notification = call_notify()

    assert notification is not None
    assert notification.id == NOTIFICATION_RECORD["id"]
    assert "email failed" in caplog.text


def test_notify_keeps_row_when_user_has_no_email(monkeypatch, sent_emails, caplog):
    use_admin_client(monkeypatch, FakeAdminClient(email=None))

    notification = call_notify()

    assert notification is not None
    assert sent_emails == []
    assert "email failed" in caplog.text


def test_notify_returns_none_and_skips_email_when_save_fails(
    monkeypatch, sent_emails, caplog
):
    use_admin_client(
        monkeypatch, FakeAdminClient(insert_error=RuntimeError("db down"))
    )

    assert call_notify() is None
    assert sent_emails == []
    assert "Could not save notification" in caplog.text


def test_send_email_requires_sendgrid_settings(monkeypatch):
    monkeypatch.setattr(notification_service.config, "SENDGRID_API_KEY", "")

    with pytest.raises(RuntimeError, match="SENDGRID_API_KEY"):
        notification_service.send_email("ada@example.com", "Subject", "Body")
