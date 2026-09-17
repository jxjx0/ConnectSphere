"""Response shape for venue edit history records."""

from datetime import datetime
from typing import Any

from pydantic import BaseModel


class VenueEditHistory(BaseModel):
    """A persisted change made to a venue profile."""

    id: str
    venue_id: str
    changed_by: str
    changed_at: datetime
    changed_fields: list[str]
    old_values: dict[str, Any]
    new_values: dict[str, Any]
    changed_by_name: str = "Unknown user"
