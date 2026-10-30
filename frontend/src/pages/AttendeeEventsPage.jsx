import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

import { getPublishedEvents } from '../api/events'
import AppShell from '../components/AppShell'
import AttendeeTabs from '../components/AttendeeTabs'
import { useAuth } from '../context/AuthContext'
import { registrationAvailability, spotsLeftLabel } from '../attendeeRegistration'
import { categoryLabel } from '../eventCategories'
import { formatDateRange } from '../eventDisplay'

export default function AttendeeEventsPage() {
  const { token } = useAuth()
  const [events, setEvents] = useState([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getPublishedEvents(token)
      .then((data) => setEvents(data.events))
      .catch((caught) => setError(caught.message))
      .finally(() => setLoading(false))
  }, [token])

  return (
    <AppShell>
      <div className="content">
        <div className="content__header">
          <h1>Events</h1>
          <p className="lead">
            Browse confirmed events and register to secure your spot.
          </p>
        </div>

        <AttendeeTabs current="/attendee/events" />

        {loading && <p className="note">Loading events…</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        {!loading && !error && events.length === 0 && (
          <p className="note">No events are open to attendees yet.</p>
        )}

        {events.map((event) => {
          const availability = registrationAvailability(event)
          return (
            <article className="session-card" key={event.id}>
              <header className="session-card__head">
                <h2>{event.name}</h2>
                <p className="session-card__meta">
                  {categoryLabel(event.category, event.category_other)}
                  {' · '}
                  {formatDateRange(event.start_time, event.end_time)}
                </p>
              </header>
              <div className="session-card__body">
                <p>{spotsLeftLabel(event)}</p>
                {!availability.open && <p className="note">{availability.message}</p>}
                <Link to={`/attendee/events/${event.id}`} className="button button--small">
                  View details
                </Link>
              </div>
            </article>
          )
        })}
      </div>
    </AppShell>
  )
}
