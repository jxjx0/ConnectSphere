import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'

import { getMyRegistrations, getPublishedEvents } from '../api/events'
import AttendeeShell from '../components/AttendeeShell'
import AttendeeListTools from '../components/AttendeeListTools'
import RegistrationWithdrawal from '../components/RegistrationWithdrawal'
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
  const [registrationError, setRegistrationError] = useState('')
  const requestScope = useRef(0)
  const latestRefresh = useRef(0)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [notice, setNotice] = useState('')
  const [reload, setReload] = useState(0)
  const visibleEvents = filterAttendeeEvents(events, query, filter)

  useEffect(() => {
    requestScope.current += 1
    const scope = requestScope.current
    setLoading(true)
    setError('')
    setRegistrations([])
    setRegistrationError('')
    getPublishedEvents(token)
      .then(async (data) => {
        if (scope !== requestScope.current) return
        setEvents(data.events)
        if (data.events.some((event) => event.is_registered)) {
          try {
            const owned = await getMyRegistrations(token)
            if (scope === requestScope.current) {
              setRegistrations(owned.registrations.filter((item) => item.status === 'registered'))
            }
          } catch (caught) {
            if (scope === requestScope.current) setRegistrationError(caught.message)
          }
        }
      })
      .catch((caught) => { if (scope === requestScope.current) setError(caught.message) })
      .finally(() => { if (scope === requestScope.current) setLoading(false) })
    return () => { requestScope.current += 1 }
  }, [token, reload])

  function updateRegistration(updated) {
    setNotice(updated.status === 'withdrawn' ? 'Registration withdrawn. You no longer hold a place at this event.' : '')
    const scope = requestScope.current
    const refresh = ++latestRefresh.current
    setRegistrationError('')
    setRegistrations((current) => current.map((item) => item.id === updated.id ? updated : item))
    setEvents((current) => current.map((event) => event.id === updated.event_id
      ? { ...event, is_registered: updated.status === 'registered', status: updated.event_status }
      : event))
    getPublishedEvents(token)
      .then((data) => {
        if (scope === requestScope.current && refresh === latestRefresh.current) setEvents(data.events)
      })
      .catch(() => {
        if (scope === requestScope.current && refresh === latestRefresh.current) {
          setRegistrationError('Your registration was updated. Refresh the page for the latest available places.')
        }
      })
  }

  return (
    <AttendeeShell>
      <div className="content">
        <div className="content__header">
          <p className="attendee-eyebrow">DISCOVER & CONNECT</p>
          <h1>Events</h1>
          <p className="lead">
            Browse events and register to secure your spot.
          </p>
        </div>

        {notice && <p className="form-success" role="status">{notice}</p>}
        {!loading && !error && <AttendeeListTools
          query={query} onQueryChange={setQuery} filter={filter} onFilterChange={setFilter}
          options={[['all', 'All events'], ['available', 'Available to register'], ['registered', 'My registered events']]}
          count={visibleEvents.length}
        />}

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
                    <Link to={event.is_registered && registration
                      ? `/attendee/registrations/${registration.id}` : `/attendee/events/${event.id}`}
                      className="button button--small">
                      {event.is_registered ? 'View registration' : availability.open ? 'View event & register' : 'View event'}
                    </Link>
                  {registration && event.is_registered && (
                    <RegistrationWithdrawal
                      key={registration.id}
                      compact
                      registration={registration}
                      onUpdate={updateRegistration}
                    />
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
