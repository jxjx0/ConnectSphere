import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

import { getMyRegistrations } from '../api/events'
import AppShell from '../components/AppShell'
import AttendeeTabs from '../components/AttendeeTabs'
import { useAuth } from '../context/AuthContext'
import { formatDateRange, formatDateTime } from '../eventDisplay'
import { attendeeEventNote } from '../eventStatus'

export default function MyRegistrationsPage() {
  const { token } = useAuth()
  const [registrations, setRegistrations] = useState([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getMyRegistrations(token)
      .then((data) => setRegistrations(data.registrations))
      .catch((caught) => setError(caught.message))
      .finally(() => setLoading(false))
  }, [token])

  return (
    <AppShell>
      <div className="content">
        <div className="content__header">
          <h1>My registrations</h1>
          <p className="lead">The events you have registered to attend.</p>
        </div>

        <AttendeeTabs current="/attendee/registrations" />

        {loading && <p className="note">Loading your registrations…</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        {!loading && !error && registrations.length === 0 && (
          <p className="note">
            You have not registered for any events yet.{' '}
            <Link to="/attendee/events">Browse events</Link>
          </p>
        )}

        {registrations.map((registration) => (
          <article className="session-card" key={registration.id}>
            <header className="session-card__head">
              <h2>{registration.event_name}</h2>
              <p className="session-card__meta">
                {formatDateRange(registration.event_start_time, registration.event_end_time)}
              </p>
            </header>
            <div className="session-card__body">
              <p>Registered {formatDateTime(registration.created_at)} as {registration.email}</p>
              {attendeeEventNote(registration.event_status, registration.event_end_time) && (
                <p className="note">
                  {attendeeEventNote(registration.event_status, registration.event_end_time)}
                </p>
              )}
              <Link
                to={`/attendee/registrations/${registration.id}`}
                className="button button--small"
              >
                View registration
              </Link>
            </div>
          </article>
        ))}
      </div>
    </AppShell>
  )
}
