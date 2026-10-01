"""Data shape for notifications."""

from datetime import datetime

from pydantic import BaseModel


class Notification(BaseModel):
    """A row of the `notifications` table.

    event_id is null for notifications that are not about a specific event.
    """

    id: str
    user_id: str
    event_id: str | None = None
    type: str
    title: str
    body: str
    is_read: bool = False
    created_at: datetime | None = None
