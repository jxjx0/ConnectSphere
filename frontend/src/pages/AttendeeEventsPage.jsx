import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'

import { getMyRegistrations, getPublishedEvents } from '../api/events'
import AttendeeShell from '../components/AttendeeShell'
import AttendeeListTools from '../components/AttendeeListTools'
import { useAuth } from '../context/AuthContext'
import { filterAttendeeEvents, registrationAvailability, spotsLeftLabel } from '../attendeeRegistration'
import { categoryLabel } from '../eventCategories'
import { formatDateRange } from '../eventDisplay'

export default function AttendeeEventsPage() {
  const { token } = useAuth()
  const [events, setEvents] = useState([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [registrations, setRegistrations] = useState([])
  const [registrationsLoading, setRegistrationsLoading] = useState(false)
  const [registrationError, setRegistrationError] = useState('')
  const requestScope = useRef(0)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [reload, setReload] = useState(0)
  const visibleEvents = filterAttendeeEvents(events, query, filter)

  useEffect(() => {
    requestScope.current += 1
    const scope = requestScope.current
    setLoading(true)
    setError('')
    setRegistrations([])
    setRegistrationsLoading(false)
    setRegistrationError('')
    getPublishedEvents(token)
      .then((data) => {
        if (scope !== requestScope.current) return
        setEvents(data.events)
        if (data.events.some((event) => event.is_registered)) {
          setRegistrationsLoading(true)
          getMyRegistrations(token)
            .then((owned) => {
              if (scope === requestScope.current) setRegistrations(owned.registrations.filter((item) => item.status === 'registered'))
            })
            .catch((caught) => { if (scope === requestScope.current) setRegistrationError(caught.message) })
            .finally(() => { if (scope === requestScope.current) setRegistrationsLoading(false) })
        }
      })
      .catch((caught) => { if (scope === requestScope.current) setError(caught.message) })
      .finally(() => { if (scope === requestScope.current) setLoading(false) })
    return () => { requestScope.current += 1 }
  }, [token, reload])

  return (
    <AttendeeShell>
      <div className="content">
        <div className="content__header">
          <h1>Sign up for Events here!</h1>
        </div>

        <AttendeeListTools
          query={query} onQueryChange={setQuery} filter={filter} onFilterChange={setFilter}
          options={[['all', 'All events'], ['available', 'Available to register'], ['registered', 'My registered events']]}
          count={loading || error ? null : visibleEvents.length}
        />

        {loading && <p className="note">Loading events…</p>}
        {error && <div className="stack stack--tight">
          <p className="form-error" role="alert">{error}</p>
          <button type="button" className="button button--secondary" onClick={() => setReload((value) => value + 1)}>Try again</button>
        </div>}
        {registrationError && <p className="form-error" role="alert">{registrationError}</p>}
        {!loading && !error && events.length === 0 && (
          <p className="note">No events are open to attendees yet.</p>
        )}

        {!loading && !error && events.length > 0 && visibleEvents.length === 0 && (
          <p className="attendee-empty">No events match your search. Try another name or clear the filters.</p>
        )}
        <div className="attendee-grid">
          {!loading && !error && visibleEvents.map((event) => {
            const availability = registrationAvailability(event)
            const registration = registrations.find((item) => item.event_id === event.id)
            return (
              <article className="session-card" key={event.id}>
                <header className="session-card__head">
                  <div className="attendee-card-labels">
                    <span className="attendee-category">{categoryLabel(event.category, event.category_other)}</span>
                    {event.is_registered && <span className="tag tag--registered">Registered</span>}
                  </div>
                  <h2>{event.name}</h2>
                  <p className="session-card__meta">
                    {formatDateRange(event.start_time, event.end_time)}
                  </p>
                </header>
                <div className="session-card__body">
                  {!event.is_registered && <p>{spotsLeftLabel(event)}</p>}
                  {!availability.open && !event.is_registered && <p className="note">{availability.message}</p>}
                  <div className="attendee-card-actions">
                    {event.is_registered && registrationsLoading ? (
                      <button type="button" className="button button--small" disabled aria-busy="true">
                        Loading registration...
                      </button>
                    ) : (
                      <Link to={event.is_registered && registration
                        ? `/attendee/registrations/${registration.id}` : `/attendee/events/${event.id}`}
                        className="button button--small">
                        {event.is_registered && registration ? 'View registration' : availability.open ? 'View event & register' : 'View event'}
                      </Link>
                    )}
                  </div>
                </div>
              </article>
            )
          })}
        </div>
      </div>
    </AttendeeShell>
  )
}
