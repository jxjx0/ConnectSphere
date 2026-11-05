"""Mail configuration and inbox failures without sending messages."""

from unittest.mock import Mock

import pytest
from postgrest import APIError

import config
from services import notification_service as notifications
from services.auth_service import AuthError
from test_notification_inbox import FakeQuery, use_fake_client, NOTIFICATION_ID


@pytest.mark.parametrize("missing", ["SENDGRID_API_KEY", "SENDGRID_FROM_EMAIL"])
def test_mail_requires_complete_configuration_before_contacting_provider(monkeypatch, missing):
    monkeypatch.setattr(config, "SENDGRID_API_KEY", "test-key")
    monkeypatch.setattr(config, "SENDGRID_FROM_EMAIL", "sender@example.com")
    monkeypatch.setattr(config, missing, "")
    provider = Mock()
    monkeypatch.setattr(notifications, "SendGridAPIClient", provider)
    with pytest.raises(RuntimeError, match="Missing SENDGRID_API_KEY or SENDGRID_FROM_EMAIL"):
        notifications.send_email("recipient@example.com", "Subject", "Body")
    provider.assert_not_called()


def test_mail_provider_receives_recipient_subject_body_and_configured_sender(monkeypatch):
    monkeypatch.setattr(config, "SENDGRID_API_KEY", "test-key")
    monkeypatch.setattr(config, "SENDGRID_FROM_EMAIL", "sender@example.com")
    provider = Mock()
    monkeypatch.setattr(notifications, "SendGridAPIClient", provider)
    notifications.send_email("recipient@example.com", "Subject", "Message body")
    provider.assert_called_once_with("test-key")
    message = provider.return_value.send.call_args.args[0].get()
    assert message["from"]["email"] == "sender@example.com"
    assert message["personalizations"][0]["to"] == [{"email": "recipient@example.com"}]
    assert message["subject"] == "Subject"
    assert message["content"] == [{"type": "text/plain", "value": "Message body"}]


@pytest.mark.parametrize("operation", ["count_unread", "mark_read"])
def test_inbox_errors_are_reported_without_claiming_zero_unread_or_success(monkeypatch, operation):
    error = APIError({"code": "42501", "message": "private database details"})
    query = FakeQuery(error=error)
    use_fake_client(monkeypatch, query)
    with pytest.raises(AuthError) as caught:
        if operation == "count_unread":
            notifications.count_unread("token")
        else:
            notifications.mark_read("token", NOTIFICATION_ID)
    assert caught.value.status_code == 502
    assert caught.value.__cause__ is error
    assert "private database details" not in caught.value.message
    if operation == "mark_read":
        assert ("eq", ("id", NOTIFICATION_ID), {}) in query.calls
    else:
        assert ("eq", ("is_read", False), {}) in query.calls


def test_role_notification_lookup_failure_is_logged_without_sending_or_breaking_the_caller(monkeypatch, caplog):
    database = Mock()
    error = APIError({"code": "42501", "message": "role lookup denied"})
    database.table.return_value.select.return_value.eq.return_value.execute.side_effect = error
    monkeypatch.setattr(config, "get_admin_client", lambda: database)
    send = Mock()
    monkeypatch.setattr(notifications, "notify", send)
    result = notifications.notify_role("event_coordinator_lead", "event_submitted", "Submitted", "New request", "event-1")
    assert result is None
    database.table.assert_called_once_with("profiles")
    database.table.return_value.select.return_value.eq.assert_called_once_with("role", "event_coordinator_lead")
    send.assert_not_called()
    assert "Could not notify profiles with role event_coordinator_lead" in caplog.text
    assert caplog.records[-1].exc_info[1] is error
