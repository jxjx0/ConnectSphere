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
          {tabEvents.map((event) => (
            <Link
              key={event.id}
              to={`/event-reviews/${event.id}`}
              className="choice"
            >
              <span className="choice__text">
                <span className="choice__title">{event.name}</span>
                <span className="choice__description">
                  {formatDateRange(event.start_time, event.end_time)}
                  {' · '}
                  <span className="tag">{readableStatus(event.status)}</span>
                </span>
              </span>
              <span className="choice__arrow" aria-hidden="true">→</span>
            </Link>
          ))}
        </div>
      )}
    </>
  )
}
