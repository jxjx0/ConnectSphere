import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import { getMyDrafts, getMyEvents } from '../api/events'
import AppShell from '../components/AppShell'
import { useAuth } from '../context/AuthContext'
import {
  formatDateRange,
  formatDateTime,
  formatSessionSummary,
} from '../eventDisplay'
import { openRequestBadges, statusLabel } from '../eventStatus'
import {
  ORGANISER_EVENT_TABS,
  defaultOrganiserTab,
  needsRegistrationSetup,
  organiserEventsForTab,
  organiserTabCount,
} from '../organiserEventTabs'

export default function MyEventsPage() {
  const { token } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()
  const requestedTab = searchParams.get('tab')

  const [events, setEvents] = useState([])
  const [drafts, setDrafts] = useState([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([getMyEvents(token), getMyDrafts(token)])
      .then(([eventData, draftData]) => {
        setEvents(eventData.events)
        setDrafts(draftData.events)
      })
      .catch((caught) => setError(caught.message))
      .finally(() => setLoading(false))
  }, [token])

  if (loading) {
    return (
      <AppShell>
        <p className="page-state">Loading your event requests…</p>
      </AppShell>
    )
  }

  const tab = ORGANISER_EVENT_TABS.find((item) => item.id === requestedTab)
    || ORGANISER_EVENT_TABS.find((item) => item.id === defaultOrganiserTab(events))
  const tabEvents = organiserEventsForTab(tab.id, events, drafts)

  return (
    <AppShell>
      <div className="content">
        <div className="content__header">
          <h1>My Events</h1>
          <p className="lead">
            See what needs you next, follow your requests, or continue a saved draft.
          </p>
        </div>

        <div className="form-actions" role="tablist" aria-label="Filter events by status">
          {ORGANISER_EVENT_TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab.id === item.id}
              className={tab.id === item.id
                ? 'button button--small'
                : 'button button--small button--secondary'}
              onClick={() => setSearchParams({ tab: item.id })}
            >
              {item.label} ({organiserTabCount(item.id, events, drafts)})
            </button>
          ))}
        </div>

        {error && <p className="form-error" role="alert">{error}</p>}

        {!error && tabEvents.length === 0 && (
          <section className="stack stack--tight">
            <p className="workspace-empty">
              {tab.empty}
              {tab.id === 'drafts' && ' Use "Save as draft" on an event request to finish it later.'}
            </p>
            {(tab.id === 'drafts' || tab.id === 'in-progress') && (
              <div>
                <Link to="/my-events/new" className="button">Request an event</Link>
              </div>
            )}
          </section>
        )}

        {!error && tabEvents.length > 0 && (
          <section className="stack stack--tight">
            <h2 className="section-title">{tab.label} ({tabEvents.length})</h2>
            <div className="choices">
              {tabEvents.map((item) => {
                const isDraft = tab.id === 'drafts'
                return (
                  <Link
                    key={item.id}
                    to={isDraft ? `/my-events/drafts/${item.id}` : `/my-events/${item.id}`}
                    className="choice"
                  >
                    <span className="choice__text">
                      <span className="choice__title">{item.name}</span>
                      <span className="choice__description">
                        {isDraft
                          ? `Last edited ${formatDateTime(item.updated_at)}`
                          : `${formatDateRange(item.start_time, item.end_time)} · ${formatSessionSummary(item)}`}
                      </span>
                      {!isDraft && (
                        <span className="event-card__tags">
                          <span className="tag">{statusLabel(item.status)}</span>
                          {openRequestBadges(item, 'organiser').map((badge) => (
                            <span key={badge.kind} className={badge.yourTurn ? 'tag tag--your-turn' : 'tag'}>
                              {badge.label}
                            </span>
                          ))}
                          {needsRegistrationSetup(item) && (
                            <span className="tag tag--your-turn">Set up registration</span>
                          )}
                        </span>
                      )}
                    </span>
                    <span className="choice__arrow" aria-hidden="true">→</span>
                  </Link>
                )
              })}
            </div>
          </section>
        )}
      </div>
    </AppShell>
  )
}
