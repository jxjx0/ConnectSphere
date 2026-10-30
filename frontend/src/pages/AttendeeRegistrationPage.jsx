import { useEffect, useState } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'

import { getMyRegistration } from '../api/events'
import AppShell from '../components/AppShell'
import { useAuth } from '../context/AuthContext'
import { formatDateRange, formatDateTime, readableStatus } from '../eventDisplay'

// The confirmation shown straight after registering, and the page each
// entry in My registrations opens.
export default function AttendeeRegistrationPage() {
  const { token } = useAuth()
  const { registrationId } = useParams()
  // Only set when arriving from the registration form.
  const { justRegistered, emailSent } = useLocation().state ?? {}

  const [registration, setRegistration] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getMyRegistration(registrationId, token)
      .then((data) => setRegistration(data.registration))
      .catch((caught) => setError(caught.message))
      .finally(() => setLoading(false))
  }, [registrationId, token])

  if (loading) {
    return (
      <AppShell>
        <p className="page-state">Loading your registration…</p>
      </AppShell>
    )
  }

  if (error) {
    return (
      <AppShell>
        <div className="page-state">
          <p>{error}</p>
          <Link to="/attendee/registrations">Back to my registrations</Link>
        </div>
      </AppShell>
    )
  }

  return (
    <AppShell>
      <div className="content">
        <Link to="/attendee/registrations" className="backlink">← My registrations</Link>

        <div className="content__header">
          <h1>{justRegistered ? 'Registration successful' : 'Your registration'}</h1>
          <p className="lead">
            You are registered for <strong>{registration.event_name}</strong>.
          </p>
        </div>

        {justRegistered && (
          <p className="form-success" role="status">
            Your spot is secured.
            {emailSent
              ? ` A confirmation email has been sent to ${registration.email}.`
              : ' We could not send a confirmation email right now, but your'
                + ' registration is saved and you can always find it here.'}
          </p>
        )}

        {registration.event_status !== 'confirmed' && (
          <p className="note">
            This event is now {readableStatus(registration.event_status).toLowerCase()}.
          </p>
        )}

        <dl className="detail-list">
          <div className="detail-list__row">
            <dt>Event</dt>
            <dd>{registration.event_name}</dd>
          </div>
          <div className="detail-list__row">
            <dt>When</dt>
            <dd>{formatDateRange(registration.event_start_time, registration.event_end_time)}</dd>
          </div>
          <div className="detail-list__row">
            <dt>Full name</dt>
            <dd>{registration.full_name}</dd>
          </div>
          <div className="detail-list__row">
            <dt>Email</dt>
            <dd>{registration.email}</dd>
          </div>
          <div className="detail-list__row">
            <dt>Address</dt>
            <dd>{registration.address}</dd>
          </div>
          <div className="detail-list__row">
            <dt>Contact number</dt>
            <dd>{registration.contact_number}</dd>
          </div>
          <div className="detail-list__row">
            <dt>Registered</dt>
            <dd>{formatDateTime(registration.created_at)}</dd>
          </div>
          <div className="detail-list__row">
            <dt>Reference</dt>
            <dd>{registration.id}</dd>
          </div>
        </dl>

        <div className="form-actions">
          <Link to="/attendee/registrations" className="button">
            View my registrations
          </Link>
          <Link to="/attendee/events" className="button button--secondary">
            Browse more events
          </Link>
        </div>
      </div>
    </AppShell>
  )
}
