import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

import { getMyEvents } from '../api/events'
import AppShell from '../components/AppShell'
import { useAuth } from '../context/AuthContext'
import { formatDateTime, readableStatus } from '../eventDisplay'

export default function MyEventsPage() {
  const { token } = useAuth()

  const [events, setEvents] = useState([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getMyEvents(token)
      .then((data) => setEvents(data.events))
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
            The event requests you have submitted, and where each one has
            reached.
          </p>
        </div>

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        {!error && events.length === 0 && (
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

        {events.length > 0 && (
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
      </div>
    </AppShell>
  )
}
