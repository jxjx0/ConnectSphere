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
  organiserEventsForTab,
  organiserTabCount,
} from '../organiserEventTabs'

function OrganiserShell({ children }) {
  return (
    <div className="organiser-ui">
      <AppShell>{children}</AppShell>
    </div>
  )
}

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
      <OrganiserShell>
        <p className="page-state">Loading your event requests…</p>
      </OrganiserShell>
    )
  }

  const tab = ORGANISER_EVENT_TABS.find((item) => item.id === requestedTab)
    || ORGANISER_EVENT_TABS.find((item) => item.id === defaultOrganiserTab(events))
  const tabEvents = organiserEventsForTab(tab.id, events, drafts)

  return (
    <OrganiserShell>
      <div className="content organiser-events">
        <Link to="/dashboard" className="organiser-events__back">
          ← Dashboard
        </Link>
        <div className="content__header">
          <p className="organiser-request__eyebrow">Organiser workspace</p>
          <h1>My event requests</h1>
          <p className="lead">
            See what needs your reply, follow your requests, or continue a saved draft.
          </p>
        </div>

        <div
          className="organiser-events__tabs"
          role="group"
          aria-label="Filter events by status"
        >
          {ORGANISER_EVENT_TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={tab.id === item.id}
              className="organiser-events__tab"
              onClick={() => setSearchParams({ tab: item.id })}
            >
              <span>{item.label}</span>
              <span className="organiser-events__count">
                {organiserTabCount(item.id, events, drafts)}
              </span>
            </button>
          ))}
        </div>

        <div
          className="organiser-events__panel"
        >
          {error && <p className="form-error" role="alert">{error}</p>}

          {!error && tabEvents.length === 0 && (
            <section className="organiser-events__empty">
              <h2>{tab.label}</h2>
              <p>{tab.empty}</p>
              {tab.id === 'drafts' && (
                <p>
                  Use “Save as draft” on an event request to finish it later.
                </p>
              )}
              {(tab.id === 'drafts' || tab.id === 'in-progress') && (
                <Link to="/my-events/new" className="button">
                  Request an event
                </Link>
              )}
            </section>
          )}

          {!error && tabEvents.length > 0 && (
            <section className="organiser-events__results">
              <div className="organiser-events__results-heading">
                <h2>{tab.label}</h2>
                <p>
                  {tabEvents.length} {tabEvents.length === 1 ? 'request' : 'requests'}
                </p>
              </div>
              <div className="organiser-events__grid">
                {tabEvents.map((item) => {
                  const isDraft = tab.id === 'drafts'
                  return (
                    <Link
                      key={item.id}
                      to={isDraft ? `/my-events/drafts/${item.id}` : `/my-events/${item.id}`}
                      className="organiser-events__card"
                    >
                      <span className="organiser-events__card-header">
                        <span className="organiser-events__card-title">
                          {item.name}
                        </span>
                        <span className="organiser-events__arrow" aria-hidden="true">
                          →
                        </span>
                      </span>
                      {isDraft ? (
                        <span className="organiser-events__card-meta">
                          <span className="organiser-events__status">Draft</span>
                          <span>Last edited {formatDateTime(item.updated_at)}</span>
                        </span>
                      ) : (
                        <>
                          <span className="organiser-events__card-meta">
                            <span>{formatDateRange(item.start_time, item.end_time)}</span>
                            <span>{formatSessionSummary(item)}</span>
                          </span>
                          <span className="organiser-events__statuses">
                            <span className="organiser-events__status">
                              {statusLabel(item.status)}
                            </span>
                            {openRequestBadges(item, 'organiser').map((badge) => (
                              <span
                                key={badge.kind}
                                className={badge.yourTurn
                                  ? 'organiser-events__status organiser-events__status--attention'
                                  : 'organiser-events__status'}
                              >
                                {badge.label}
                              </span>
                            ))}
                          </span>
                        </>
                      )}
                    </Link>
                  )
                })}
              </div>
            </section>
          )}
        </div>
      </div>
    </OrganiserShell>
  )
}
