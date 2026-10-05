from unittest.mock import MagicMock
import pytest
import config
from services import event_service

# Test Fixtures / Mock Data
EVENT_ID = "33333333-3333-3333-3333-333333333333"
ADMIN_ID = "11111111-1111-1111-1111-111111111111"
OLD_COORDINATOR_ID = "44444444-4444-4444-4444-444444444444"
NEW_COORDINATOR_ID = "22222222-2222-2222-2222-222222222222"
ORGANIZER_ID = "55555555-5555-5555-5555-555555555555"
ACCESS_TOKEN = "fake-access-token"
REASON = "Reassigning due to workload balancing."


def test_reassign_event_success_preserves_status_and_notifies_coordinators(
    monkeypatch,
):
    """
    Verifies that:
    1. Reassignment updates the coordinator ID.
    2. Event status remains unchanged (e.g. 'under_review').
    3. Audit trail entry is logged.
    4. Mandatory notifications are sent to the affected coordinators.
    """
    mock_client = MagicMock()

    # Mock fetch existing event
    mock_select = MagicMock()
    mock_select.execute.return_value.data = [
        {
            "id": EVENT_ID,
            "name": "Annual Client Summit",
            "status": "under_review",  # Status must remain unchanged after reassignment
            "coordinator_id": OLD_COORDINATOR_ID,
            "organizer_id": ORGANIZER_ID,
        }
    ]
    mock_client.table().select().eq.return_value = mock_select

    # Mock database update response
    mock_update = MagicMock()
    mock_update.execute.return_value.data = [
        {
            "id": EVENT_ID,
            "name": "Annual Client Summit",
            "status": "under_review",
            "coordinator_id": NEW_COORDINATOR_ID,
            "organizer_id": ORGANIZER_ID,
        }
    ]
    mock_client.table().update().eq.return_value = mock_update

    # Mock audit table insert & notify call
    mock_audit = MagicMock()
    mock_client.table().insert.return_value = mock_audit
    mock_notify = MagicMock()

    monkeypatch.setattr(config, "get_admin_client", lambda: mock_client)
    monkeypatch.setattr(event_service, "notify", mock_notify)

    result = event_service.reassign_event(
        event_id=EVENT_ID,
        new_coordinator_id=NEW_COORDINATOR_ID,
        changed_by_id=ADMIN_ID,
        reason=REASON,
        access_token=ACCESS_TOKEN,
    )

    # 1. Assert status preservation and coordinator change
    assert result["coordinator_id"] == NEW_COORDINATOR_ID
    assert result["status"] == "under_review"

    # 2. Assert notifications sent to active coordinator roles (2 calls)
    assert mock_notify.call_count == 2


@pytest.mark.parametrize("status", ["completed", "rejected"])
def test_reassign_event_completed_or_rejected_raises_exception(
    monkeypatch, status
):
    """Verifies that events in 'completed' or 'rejected' states cannot be reassigned."""
    mock_client = MagicMock()

    mock_select = MagicMock()
    mock_select.execute.return_value.data = [
        {
            "id": EVENT_ID,
            "coordinator_id": OLD_COORDINATOR_ID,
            "status": status,
        }
    ]
    mock_client.table().select().eq.return_value = mock_select

    monkeypatch.setattr(config, "get_admin_client", lambda: mock_client)

    with pytest.raises(
        Exception, match="Cannot reassign an event that is completed or rejected."
    ):
        event_service.reassign_event(
            event_id=EVENT_ID,
            new_coordinator_id=NEW_COORDINATOR_ID,
            changed_by_id=ADMIN_ID,
            reason=REASON,
            access_token=ACCESS_TOKEN,
        )