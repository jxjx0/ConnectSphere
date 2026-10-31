import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'

import { getMyRegistrations, getPublishedEvents } from '../api/events'
import AppShell from '../components/AppShell'
import AttendeeTabs from '../components/AttendeeTabs'
import RegistrationWithdrawal from '../components/RegistrationWithdrawal'
import { useAuth } from '../context/AuthContext'
import { registrationAvailability, spotsLeftLabel } from '../attendeeRegistration'
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
  }, [token])

  function updateRegistration(updated) {
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
        {registrationError && <p className="form-error" role="alert">{registrationError}</p>}
        {!loading && !error && events.length === 0 && (
          <p className="note">No events are open to attendees yet.</p>
        )}

        {events.map((event) => {
          const availability = registrationAvailability(event)
          const registration = registrations.find((item) => item.event_id === event.id)
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
                {registration?.status === 'withdrawn' && (
                  <p className="form-success" role="status">Your registration has been withdrawn.</p>
                )}
                <Link to={`/attendee/events/${event.id}`} className="button button--small">
                  View details
                </Link>
                {registration && event.is_registered && (
                  <RegistrationWithdrawal
                    key={registration.id}
                    registration={registration}
                    onUpdate={updateRegistration}
                  />
                )}
              </div>
            </article>
          )
        })}
      </div>
    </AppShell>
  )
}
