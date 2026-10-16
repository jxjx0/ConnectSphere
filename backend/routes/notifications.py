"""Notification inbox endpoints. Thin handlers: call the service, return JSON."""

from uuid import UUID

from flask import Blueprint, g, jsonify

from routes.auth import require_auth
from services import notification_service
from services.auth_service import AuthError

notifications_bp = Blueprint("notifications", __name__, url_prefix="/notifications")


@notifications_bp.get("")
@require_auth
def list_notifications():
    notifications = notification_service.list_notifications(g.access_token)
    unread_count = notification_service.count_unread(g.access_token)
    return (
        jsonify(
            {
                "notifications": [
                    notification.model_dump(mode="json")
                    for notification in notifications
                ],
                "unread_count": unread_count,
            }
        ),
        200,
    )


@notifications_bp.patch("/<notification_id>/read")
@require_auth
def mark_notification_read(notification_id):
    # A malformed id cannot match any notification, so treat it as not found
    # rather than sending it to the database.
    try:
        UUID(notification_id)
    except ValueError:
        raise AuthError("Notification not found.", status_code=404)

    notification = notification_service.mark_read(g.access_token, notification_id)
    return jsonify({"notification": notification.model_dump(mode="json")}), 200
