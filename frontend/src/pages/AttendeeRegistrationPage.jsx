import { useEffect, useState } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'

import { getMyRegistration, getPublishedEvent } from '../api/events'
import AppShell from '../components/AppShell'
import RegistrationWithdrawal from '../components/RegistrationWithdrawal'
import { useAuth } from '../context/AuthContext'
import { formatDateRange, formatDateTime, optional } from '../eventDisplay'
import { attendeeEventNote } from '../eventStatus'
import { registrationAvailability } from '../attendeeRegistration'

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
  const [canRegisterAgain, setCanRegisterAgain] = useState(false)

  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    getMyRegistration(registrationId, token)
      .then((data) => { if (active) setRegistration(data.registration) })
      .catch((caught) => { if (active) setError(caught.message) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [registrationId, token])

  useEffect(() => {
    let active = true
    setCanRegisterAgain(false)
    if (registration?.status === 'withdrawn') {
      getPublishedEvent(registration.event_id, token)
        .then((data) => {
          if (active) setCanRegisterAgain(registrationAvailability(data.event).open)
        })
        .catch(() => { /* An unavailable event must not hide withdrawal history. */ })
    }
    return () => { active = false }
  }, [registration?.id, registration?.status, token])

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
          <h1>{justRegistered && registration.status !== 'withdrawn' ? 'Registration successful' : 'Your registration'}</h1>
          <p className="lead">
            {registration.status === 'withdrawn' ? 'You withdrew your registration for ' : 'You are registered for '}
            <strong>{registration.event_name}</strong>.
          </p>
        </div>

        {registration.status === 'withdrawn' && (
          <p className="form-success" role="status">
            Your registration is withdrawn. You no longer hold a place at this event.
          </p>
        )}

        {justRegistered && registration.status !== 'withdrawn' && (
          <p className="form-success" role="status">
            Your spot is secured.
            {emailSent
              ? ` A confirmation email has been sent to ${registration.email}.`
              : ' We could not send a confirmation email right now, but your'
                + ' registration is saved and you can always find it here.'}
          </p>
        )}

        {attendeeEventNote(registration.event_status, registration.event_end_time) && (
          <p className="note">
            {attendeeEventNote(registration.event_status, registration.event_end_time)}
          </p>
        )}

        <dl className="detail-list">
          <div className="detail-list__row">
            <dt>Registration status</dt>
            <dd>{registration.status === 'withdrawn' ? 'Withdrawn' : 'Registered'}</dd>
          </div>
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
            <dt>Contact number</dt>
            <dd>{optional(registration.contact_number)}</dd>
          </div>
          <div className="detail-list__row">
            <dt>Registered</dt>
            <dd>{formatDateTime(registration.created_at)}</dd>
          </div>
          {registration.status === 'withdrawn' && (
            <div className="detail-list__row">
              <dt>Withdrawn</dt>
              <dd>{formatDateTime(registration.withdrawn_at)}</dd>
            </div>
          )}
          <div className="detail-list__row">
            <dt>Reference</dt>
            <dd>{registration.id}</dd>
          </div>
        </dl>

        <RegistrationWithdrawal
          key={registration.id}
          registration={registration}
          onUpdate={setRegistration}
        />

        <div className="form-actions">
          {canRegisterAgain && (
            <Link to={`/attendee/events/${registration.event_id}`} className="button">
              Register again
            </Link>
          )}
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
