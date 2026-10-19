// The Coordinator's assigned event requests, split into tabs by status.
// DashboardPage loads the events and passes them in.

import { Link, useSearchParams } from 'react-router-dom'

import { formatDateRange, readableStatus } from '../eventDisplay'

const TABS = [
  {
    id: 'incoming',
    label: 'Incoming',
    statuses: ['under_review'],
    empty: 'No requests are waiting for your decision.',
  },
  {
    id: 'clarification',
    label: 'Awaiting clarification',
    statuses: ['awaiting_clarification'],
    empty: 'No events are awaiting clarification.',
  },
  {
    id: 'ongoing',
    label: 'Ongoing',
    statuses: ['planning', 'confirmed'],
    empty: 'You have no ongoing events.',
  },
  {
    id: 'change-requested',
    label: 'Change requested',
    statuses: ['change_requested'],
    empty: 'No events are waiting on a change request.',
  },
  {
    id: 'completed',
    label: 'Completed',
    statuses: ['completed'],
    empty: 'You have no completed events.',
  },
  {
    id: 'rejected',
    label: 'Rejected',
    statuses: ['rejected'],
    empty: 'You have not rejected any requests.',
  },
]

// Helper function to derive the venue status badge
function getVenueBadge(venueBookings) {
  if (!venueBookings || venueBookings.length === 0) {
    return {
      label: 'No Venue',
      style: {
        backgroundColor: 'var(--sunken)',
        color: 'var(--ink-faint)',
        borderColor: 'var(--rule)',
      },
    }
  }

  if (venueBookings.some((b) => b.status === 'AFFECTED_BY_UNAVAILABILITY')) {
    return {
      label: 'Venue Affected',
      style: {
        backgroundColor: 'var(--danger-faint)',
        color: 'var(--danger)',
        borderColor: 'var(--danger)',
      },
    }
  }

  const hasApproved = venueBookings.some((b) => b.status === 'APPROVED')
  if (hasApproved) {
    return {
      label: 'Venue Approved',
      style: {
        backgroundColor: 'var(--accent-faint)',
        color: 'var(--accent)',
        borderColor: 'var(--accent)',
      },
    }
  }

  const hasPending = venueBookings.some((b) => b.status === 'PENDING_VENUE_APPROVAL')
  if (hasPending) {
    return {
      label: 'Venue Pending',
      style: {
        backgroundColor: 'var(--surface)',
        color: 'var(--ink)',
        borderColor: 'var(--rule-strong)',
      },
    }
  }

  return {
    label: 'Venue Rejected',
    style: {
      backgroundColor: 'var(--danger-faint)',
      color: 'var(--danger)',
      borderColor: 'var(--danger)',
    },
  }
}

// Helper function for Safety Review Badge
function getSafetyBadge(event) {
  if (!event) return null

  // If the event is safety approved / completed safety check
  if (event.safety_status === 'approved' || event.status === 'safety_approved') {
    return {
      label: 'Safety Approved',
      style: {
        backgroundColor: 'var(--accent-faint)',
        color: 'var(--accent)',
        borderColor: 'var(--accent)',
      },
    }
  }

  // If the safety check was rejected / flagged with issues
  if (event.safety_status === 'rejected' || event.status === 'safety_rejected') {
    return {
      label: 'Safety Concerns Flagged',
      style: {
        backgroundColor: 'var(--danger-faint)',
        color: 'var(--danger)',
        borderColor: 'var(--danger)',
      },
    }
  }

  // Default for all other events that haven't completed safety review yet
  return {
    label: 'Safety check not done',
    style: {
      backgroundColor: 'var(--surface)',
      color: 'var(--ink)',
      borderColor: 'var(--rule-strong)',
    },
  }
}

function getEquipmentBadge(equipmentRequests) {
  const status = equipmentRequests?.[0]?.status?.toLowerCase()
  if (!status) return null

  if (status === 'approved') {
    return {
      label: 'Equipment Approved',
      style: {
        backgroundColor: 'var(--accent-faint)',
        color: 'var(--accent)',
        borderColor: 'var(--accent)',
      },
    }
  }

  if (status === 'rejected') {
    return {
      label: 'Equipment Rejected',
      style: {
        backgroundColor: 'var(--danger-faint)',
        color: 'var(--danger)',
        borderColor: 'var(--danger)',
      },
    }
  }

  return {
    label: 'Equipment Pending',
    style: {
      backgroundColor: 'var(--surface)',
      color: 'var(--ink)',
      borderColor: 'var(--rule-strong)',
    },
  }
}

export default function AssignedRequestTabs({ events }) {
  // The open tab lives in the URL (?tab=ongoing), so the back button
  // returns to the same tab. Incoming is the default.
  const [searchParams, setSearchParams] = useSearchParams()
  const tab = TABS.find((t) => t.id === searchParams.get('tab')) ?? TABS[0]
  const tabEvents = events.filter((event) => tab.statuses.includes(event.status))

  return (
    <>
      <div className="form-actions" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab.id === t.id}
            className={
              tab.id === t.id
                ? 'button button--small'
                : 'button button--small button--secondary'
            }
            onClick={() =>
              setSearchParams(t.id === TABS[0].id ? {} : { tab: t.id })
            }
          >
            {t.label} ({events.filter((event) => t.statuses.includes(event.status)).length})
          </button>
        ))}
      </div>

      {tabEvents.length === 0 ? (
        <p className="note">{tab.empty}</p>
      ) : (
        <div className="choices">
          {tabEvents.map((event) => {
            const venueBadge = getVenueBadge(event.venue_bookings)
            const safetyBadge = getSafetyBadge(event)
            const equipmentBadge = getEquipmentBadge(event.equipment_requests)

            return (
              <Link
                key={event.id}
                to={`/event-reviews/${event.id}`}
                className="choice"
              >
                <span className="choice__text">
                  <span className="choice__title">{event.name}</span>
                  <span className="choice__description" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap', marginTop: 'var(--space-1)' }}>
                    <span>{formatDateRange(event.start_time, event.end_time)}</span>
                    <span aria-hidden="true">·</span>
                    <span className="tag">{readableStatus(event.status)}</span>
                    <span className="tag" style={venueBadge.style}>
                      {venueBadge.label}
                    </span>
                    {safetyBadge && (
                      <span className="tag" style={safetyBadge.style}>
                        {safetyBadge.label}
                      </span>
                    )}
                    {equipmentBadge && (
                      <span className="tag" style={equipmentBadge.style}>
                        {equipmentBadge.label}
                      </span>
                    )}
                  </span>
                </span>
                <span className="choice__arrow" aria-hidden="true">→</span>
              </Link>
            )
          })}
        </div>
      )}
    </>
  )
}
