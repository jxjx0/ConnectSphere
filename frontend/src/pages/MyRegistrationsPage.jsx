import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

import { getMyRegistrations } from '../api/events'
import AppShell from '../components/AppShell'
import AttendeeTabs from '../components/AttendeeTabs'
import RegistrationWithdrawal from '../components/RegistrationWithdrawal'
import { useAuth } from '../context/AuthContext'
import { groupRegistrationsByEvent } from '../attendeeRegistration'
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
          <p className="lead">View your registration status and history for each event.</p>
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

        {groupRegistrationsByEvent(registrations).map(({ latest: registration, history }) => (
          <article className="session-card" key={registration.event_id}>
            <header className="session-card__head">
              <h2>{registration.event_name}</h2>
              <p className="session-card__meta">
                {formatDateRange(registration.event_start_time, registration.event_end_time)}
              </p>
            </header>
            <div className="session-card__body">
              <p>
                <strong>Registration status:</strong>{' '}
                <span className="tag">{registration.status === 'withdrawn' ? 'Withdrawn' : 'Registered'}</span>
              </p>
              <p>Registered {formatDateTime(registration.created_at)}</p>
              {registration.status === 'withdrawn' && (
                <p>Withdrawn {formatDateTime(registration.withdrawn_at)}</p>
              )}
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
              <RegistrationWithdrawal
                key={registration.id}
                registration={registration}
                onUpdate={(updated) => setRegistrations((current) => current.map(
                  (item) => item.id === updated.id ? updated : item,
                ))}
              />
              {history.length > 0 && (
                <details className="registration-history">
                  <summary>
                    Registration history ({history.length} previous {history.length === 1 ? 'attempt' : 'attempts'})
                  </summary>
                  <ol className="registration-history__list" reversed>
                    {history.map((previous, index) => (
                      <li className="registration-history__item stack stack--tight" key={previous.id}>
                        <h3>Registration attempt {history.length - index}</h3>
                        <p>
                          <span className="tag">{previous.status === 'withdrawn' ? 'Withdrawn' : 'Registered'}</span>
                        </p>
                        <p>Registered {formatDateTime(previous.created_at)}</p>
                        {previous.status === 'withdrawn' && (
                          <p>Withdrawn {formatDateTime(previous.withdrawn_at)}</p>
                        )}
                        <Link to={`/attendee/registrations/${previous.id}`}>
                          View previous registration
                        </Link>
                      </li>
                    ))}
                  </ol>
                </details>
              )}
            </div>
          </article>
        ))}
      </div>
    </AppShell>
  )
}
