import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import { getMyDrafts, getMyEvents } from '../api/events'
import AppShell from '../components/AppShell'
import { useAuth } from '../context/AuthContext'
import { formatDateTime, readableStatus } from '../eventDisplay'

export default function MyEventsPage() {
  const { token } = useAuth()
  // The open tab lives in the URL (?tab=drafts), so a link can open the
  // Drafts tab directly and the back button returns to the same tab.
  const [searchParams, setSearchParams] = useSearchParams()
  const tab = searchParams.get('tab') === 'drafts' ? 'drafts' : 'submitted'

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

  return (
    <AppShell>
      <div className="content">
        <Link to="/dashboard" className="backlink">
          ← Dashboard
        </Link>

        <div className="content__header">
          <h1>My event requests</h1>
          <p className="lead">
            The event requests you have submitted, and drafts you can
            continue later.
          </p>
        </div>

        <div className="form-actions" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'submitted'}
            className={
              tab === 'submitted'
                ? 'button button--small'
                : 'button button--small button--secondary'
            }
            onClick={() => setSearchParams({})}
          >
            Submitted ({events.length})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'drafts'}
            className={
              tab === 'drafts'
                ? 'button button--small'
                : 'button button--small button--secondary'
            }
            onClick={() => setSearchParams({ tab: 'drafts' })}
          >
            Drafts ({drafts.length})
          </button>
        </div>

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        {tab === 'submitted' && !error && events.length === 0 && (
          <section className="stack stack--tight">
            <p className="note">
              You have not submitted any event requests yet.
            </p>
            <div className="form-actions">
              <Link to="/my-events/new" className="button">
                Request an Event
              </Link>
            </div>
          </section>
        )}

        {tab === 'submitted' && events.length > 0 && (
          <section className="stack stack--tight">
            <h2 className="section-title">Submitted requests</h2>

            <div className="choices">
              {events.map((event) => (
                <Link
                  key={event.id}
                  to={`/my-events/${event.id}`}
                  className="choice"
                >
                  <span className="choice__text">
                    <span className="choice__title">{event.name}</span>
                    <span className="choice__description">
                      {formatDateTime(event.start_time)}
                      {' · '}
                      <span className="tag">
                        {readableStatus(event.status)}
                      </span>
                    </span>
                  </span>
                  <span className="choice__arrow" aria-hidden="true">
                    →
                  </span>
                </Link>
              ))}
            </div>
          </section>
        )}

        {tab === 'drafts' && !error && drafts.length === 0 && (
          <section className="stack stack--tight">
            <p className="note">
              You have no saved drafts. Use &ldquo;Save as draft&rdquo; on
              an event request to finish it later.
            </p>
            <div className="form-actions">
              <Link to="/my-events/new" className="button">
                Request an Event
              </Link>
            </div>
          </section>
        )}

        {tab === 'drafts' && drafts.length > 0 && (
          <section className="stack stack--tight">
            <h2 className="section-title">Drafts</h2>

            <div className="choices">
              {drafts.map((draft) => (
                <Link
                  key={draft.id}
                  to={`/my-events/drafts/${draft.id}`}
                  className="choice"
                >
                  <span className="choice__text">
                    <span className="choice__title">{draft.name}</span>
                    <span className="choice__description">
                      Last edited {formatDateTime(draft.updated_at)}
                    </span>
                  </span>
                  <span className="choice__arrow" aria-hidden="true">
                    →
                  </span>
                </Link>
              ))}
            </div>
          </section>
        )}
      </div>
    </AppShell>
  )
}
