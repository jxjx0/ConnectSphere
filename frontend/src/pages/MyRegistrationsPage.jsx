import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

import { getMyRegistrations } from '../api/events'
import AttendeeShell from '../components/AttendeeShell'
import AttendeeListTools from '../components/AttendeeListTools'
import { useAuth } from '../context/AuthContext'
import {
  filterRegistrationGroups,
  groupRegistrationsByEvent,
  isPastRegistration,
} from '../attendeeRegistration'
import { formatDateRange } from '../eventDisplay'
import { attendeeEventNote } from '../eventStatus'

export default function MyRegistrationsPage() {
  const { token } = useAuth()
  const [registrations, setRegistrations] = useState([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [reload, setReload] = useState(0)
  const [view, setView] = useState('upcoming')
  // Each event appears once, however many times the attendee registered.
  const groups = groupRegistrationsByEvent(registrations)
  const pastGroups = groups.filter((group) => isPastRegistration(group))
  const visibleGroups = filterRegistrationGroups(groups, query, filter)
    .filter((group) => isPastRegistration(group) === (view === 'past'))

  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    getMyRegistrations(token)
      .then((data) => { if (active) setRegistrations(data.registrations) })
      .catch((caught) => { if (active) setError(caught.message) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [token, reload])

  return (
    <AttendeeShell>
      <div className="content">
        <div className="content__header">
          <h1>Events you have Signed Up for</h1>
        </div>

        <AttendeeListTools
          query={query} onQueryChange={setQuery} filter={filter} onFilterChange={setFilter}
          options={[['all', 'All registrations'], ['registered', 'Registered'], ['withdrawn', 'Withdrawn']]}
          count={loading || error ? null : visibleGroups.length}
        />

        <div className="form-actions" role="group" aria-label="Show registrations for">
          {[['upcoming', 'Upcoming', groups.length - pastGroups.length], ['past', 'Past and cancelled', pastGroups.length]].map(([id, label, count]) => (
            <button
              key={id}
              type="button"
              aria-pressed={view === id}
              className={view === id ? 'button button--small' : 'button button--small button--secondary'}
              onClick={() => setView(id)}
            >
              {label} ({count})
            </button>
          ))}
        </div>

        {loading && <p className="note">Loading your registrations…</p>}
        {error && <div className="stack stack--tight">
          <p className="form-error" role="alert">{error}</p>
          <button type="button" className="button button--secondary" onClick={() => setReload((value) => value + 1)}>Try again</button>
        </div>}
        {!loading && !error && registrations.length === 0 && (
          <p className="note">
            You have not registered for any events yet.{' '}
            <Link to="/attendee/events">Browse events</Link>
          </p>
        )}

        {!loading && !error && registrations.length > 0 && visibleGroups.length === 0 && (
          <p className="attendee-empty">
            {query || filter !== 'all'
              ? 'No registrations match your search. Try another name or clear the filters.'
              : view === 'past' ? 'You have no past or cancelled events.' : 'You have no upcoming events.'}
          </p>
        )}
        <div className="attendee-grid">
          {!loading && !error && visibleGroups.map(({ latest: registration }) => (
            <article className={`session-card${registration.event_status === 'cancelled' ? ' attendee-card--cancelled' : ''}`} key={registration.event_id}>
              <header className="session-card__head">
                {registration.event_status === 'cancelled' && <div><span className="tag tag--cancelled">Event cancelled</span></div>}
                <h2>{registration.event_name}</h2>
                <p className="session-card__meta">
                  {formatDateRange(registration.event_start_time, registration.event_end_time)}
                </p>
              </header>
              <div className="session-card__body">
                <p>
                  <strong>Registration status:</strong>{' '}
                  <span className={`tag tag--${registration.status === 'withdrawn' ? 'withdrawn' : registration.event_status === 'cancelled' ? 'recorded' : 'registered'}`}>{registration.status === 'withdrawn' ? 'Withdrawn' : 'Registered'}</span>
                </p>
                {registration.event_status === 'cancelled' && (
                  <p className="note">This event will no longer take place. Your registration is kept for your records.</p>
                )}
                {registration.event_status !== 'cancelled' && attendeeEventNote(registration.event_status, registration.event_end_time) && (
                  <p className="note">
                    {attendeeEventNote(registration.event_status, registration.event_end_time)}
                  </p>
                )}
                <div className="attendee-card-actions">
                <Link
                  to={`/attendee/registrations/${registration.id}`}
                  className={`button button--small${registration.event_status === 'cancelled' ? ' button--secondary' : ''}`}
                >
                  View registration
                </Link>
                </div>

              </div>
            </article>
          ))}
        </div>
      </div>
    </AttendeeShell>
  )
}
