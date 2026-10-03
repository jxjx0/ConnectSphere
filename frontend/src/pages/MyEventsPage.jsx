import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import { getMyDrafts, getMyEvents } from '../api/events'
import AppShell from '../components/AppShell'
import { useAuth } from '../context/AuthContext'
import { formatDateTime } from '../eventDisplay'
import {
  ORGANISER_EVENT_TABS,
  organiserEventStatusLabel,
  organiserEventsForTab,
  organiserTabCount,
} from '../organiserEventTabs'

export default function MyEventsPage() {
  const { token } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()
  const requestedTab = searchParams.get('tab')
  const tab = ORGANISER_EVENT_TABS.find((item) => item.id === requestedTab)
    || ORGANISER_EVENT_TABS.find((item) => item.id === 'submitted')

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

  const tabEvents = organiserEventsForTab(tab.id, events, drafts)

  return (
    <AppShell>
      <div className="content">
        <Link to="/dashboard" className="backlink">
          ← Dashboard
        </Link>

        <div className="content__header">
          <h1>My event requests</h1>
          <p className="lead">
            View your event requests by status, or continue a saved draft.
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
              onClick={() => setSearchParams(item.id === 'submitted'
                ? {}
                : { tab: item.id })}
            >
              {item.label} ({organiserTabCount(item.id, events, drafts)})
            </button>
          ))}
        </div>

        {error && <p className="form-error" role="alert">{error}</p>}

        {!error && tabEvents.length === 0 && (
          <section className="stack stack--tight">
            <p className="note">{tab.empty}</p>
            {tab.id === 'drafts' && (
              <p className="note">
                Use “Save as draft” on an event request to finish it later.
              </p>
            )}
            {(tab.id === 'drafts' || tab.id === 'submitted') && (
              <div className="form-actions">
                <Link to="/my-events/new" className="button">
                  Request an Event
                </Link>
              </div>
            )}
          </section>
        )}

        {!error && tabEvents.length > 0 && (
          <section className="stack stack--tight">
            <h2 className="section-title">{tab.label}</h2>
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
                          : <>{formatDateTime(item.start_time)}{' · '}<span className="tag">{organiserEventStatusLabel(item.status, tab.id)}</span></>}
                      </span>
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
