"""Shared notification service: in-app notification + email via SendGrid.

Other features call notify() whenever something happens that a user should
hear about. notify() never raises: a notification is a side effect, so a
failure here must not undo or break the action that triggered it (for
example, approving an event). Failures are logged instead.

Notifications are sent by the system, not by a user, so notify() uses the
service-role Supabase client (config.get_admin_client). It is the only
place in the backend that does.

The inbox functions (list_notifications, mark_read) run for a logged-in
user, so they use that user's client instead. Row-level security then
limits them to the user's own notifications.
"""

import logging

from postgrest import APIError as PostgrestAPIError
from sendgrid import SendGridAPIClient
from sendgrid.helpers.mail import Mail

import config
from models.notification import Notification
from services.auth_service import AuthError

logger = logging.getLogger(__name__)


def notify(
    user_id: str,
    notification_type: str,
    title: str,
    body: str,
    event_id: str | None = None,
) -> Notification | None:
    """Save an in-app notification for `user_id`, then email it to them.

    The row is saved first, so the in-app notification exists even if the
    email fails. Returns the saved notification, or None if it could not be
    saved.
    """
    # Broad `except Exception` on purpose here and below: Supabase and
    # SendGrid can fail in many ways (network, bad key, unverified sender),
    # and none of them may reach the caller.
    try:
        notification = _save_notification(
            user_id, notification_type, title, body, event_id
        )
    except Exception:
        logger.exception("Could not save notification for user %s", user_id)
        return None

    try:
        email = _get_user_email(user_id)
        send_email(email, title, body)
    except Exception:
        logger.exception(
            "Notification %s was saved but its email failed", notification.id
        )

    return notification


def _save_notification(
    user_id: str,
    notification_type: str,
    title: str,
    body: str,
    event_id: str | None,
) -> Notification:
    """Insert the notification row and return it."""
    client = config.get_admin_client()
    result = (
        client.table("notifications")
        .insert(
            {
                "user_id": user_id,
                "event_id": event_id,
                "type": notification_type,
                "title": title,
                "body": body,
            }
        )
        .execute()
    )
    return Notification(**result.data[0])


def _get_user_email(user_id: str) -> str:
    """Look up a user's email address in Supabase Auth.

    Emails live in Supabase Auth, not in `profiles`, so this needs the
    admin API.
    """
    client = config.get_admin_client()
    response = client.auth.admin.get_user_by_id(user_id)
    if not response.user or not response.user.email:
        raise ValueError(f"User {user_id} has no email address")
    return response.user.email


def send_email(to_email: str, subject: str, body: str) -> None:
    """Send a plain-text email through SendGrid. Raises on failure."""
    if not config.SENDGRID_API_KEY or not config.SENDGRID_FROM_EMAIL:
        raise RuntimeError(
            "Missing SENDGRID_API_KEY or SENDGRID_FROM_EMAIL in backend/.env"
        )
    message = Mail(
        from_email=config.SENDGRID_FROM_EMAIL,
        to_emails=to_email,
        subject=subject,
        plain_text_content=body,
    )
    SendGridAPIClient(config.SENDGRID_API_KEY).send(message)


def list_notifications(access_token: str) -> list[Notification]:
    """Return the logged-in user's notifications, newest first.

    Row-level security only returns rows where user_id is the caller, so
    there is no user_id filter here.
    """
    client = config.get_user_client(access_token)
    try:
        result = (
            client.table("notifications")
            .select("*")
            .order("created_at", desc=True)
            .execute()
        )
    except PostgrestAPIError as error:
        raise AuthError("Unable to load notifications.", status_code=502) from error
    return [Notification(**record) for record in result.data]


def mark_read(access_token: str, notification_id: str) -> Notification:
    """Mark one of the logged-in user's notifications as read.

    Row-level security makes another user's notification invisible here, so
    it updates no rows and is reported as not found, the same as a missing
    one.
    """
    client = config.get_user_client(access_token)
    try:
        result = (
            client.table("notifications")
            .update({"is_read": True})
            .eq("id", notification_id)
            .execute()
        )
    except PostgrestAPIError as error:
        raise AuthError("Unable to update the notification.", status_code=502) from error

    if not result.data:
        raise AuthError("Notification not found.", status_code=404)
    return Notification(**result.data[0])
