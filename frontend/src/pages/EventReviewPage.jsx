import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

import { getAssignedEventRequests } from '../api/events'
import AppShell from '../components/AppShell'
import { useAuth } from '../context/AuthContext'
import { formatDateRange, readableStatus } from '../eventDisplay'

export default function EventReviewPage() {
  const { token } = useAuth()
  const [events, setEvents] = useState([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getAssignedEventRequests(token)
      .then((data) => setEvents(data.events))
      .catch((caught) => setError(caught.message))
      .finally(() => setLoading(false))
  }, [token])

  if (loading) {
    return (
      <AppShell>
        <p className="page-state">Loading assigned event requests…</p>
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
          <h1>Review event requests</h1>
          <p className="lead">Requests assigned to you and awaiting a decision.</p>
        </div>

        {error && <p className="form-error" role="alert">{error}</p>}

        {!error && events.length === 0 && (
          <p className="note">There are no assigned requests awaiting your decision.</p>
        )}

        {events.length > 0 && (
          <section className="stack stack--tight" aria-label="Assigned requests">
            <div className="choices">
              {events.map((event) => (
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
          </section>
        )}
      </div>
    </AppShell>
  )
}