// The Coordinator's assigned event requests, split into tabs by whether
// they are waiting on the Coordinator. DashboardPage loads the events and
// passes them in.

import { Link, useSearchParams } from 'react-router-dom'

import {
  COORDINATOR_EVENT_TABS as TABS,
  coordinatorEventsForTab,
} from '../coordinatorEventTabs'
import { equipmentBadge, venueBadge } from '../coordinatorEventView'
import {
  formatDateRange,
  formatSessionSummary,
} from '../eventDisplay'
import { openRequestBadges, statusLabel } from '../eventStatus'

export default function AssignedRequestTabs({ events }) {
  // The open tab lives in the URL (?tab=waiting), so the back button
  // returns to the same tab. "Needs my action" is the default.
  const [searchParams, setSearchParams] = useSearchParams()
  const tab = TABS.find((t) => t.id === searchParams.get('tab')) ?? TABS[0]
  const tabEvents = coordinatorEventsForTab(tab.id, events)

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
            {t.label} ({coordinatorEventsForTab(t.id, events).length})
          </button>
        ))}
      </div>

      {tabEvents.length === 0 ? (
        <p className="note">{tab.empty}</p>
      ) : (
        <div className="choices">
          {tabEvents.map((event) => {
            const venue = venueBadge(event.venue_bookings)
            const equipment = equipmentBadge(event.equipment_requests)

            return (
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
                    {formatSessionSummary(event)}
                  </span>
                  <span className="event-card__tags">
                    <span className="tag">{statusLabel(event.status)}</span>
                    {openRequestBadges(event, 'coordinator').map((badge) => (
                      <span
                        key={badge.kind}
                        className={badge.yourTurn ? 'tag tag--your-turn' : 'tag'}
                      >
                        {badge.label}
                      </span>
                    ))}
                    {event.status !== 'cancelled' && (
                      <>
                        <span className={venue.className}>{venue.label}</span>
                        {equipment && <span className={equipment.className}>{equipment.label}</span>}
                      </>
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
