import { useEffect, useState } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'

import { getMyRegistration, getMyRegistrations, getPublishedEvent } from '../api/events'
import AttendeeShell from '../components/AttendeeShell'
import EventCancelledNotice from '../components/EventCancelledNotice'
import RegistrationWithdrawal from '../components/RegistrationWithdrawal'
import RegistrationHistory from '../components/RegistrationHistory'
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
  const [justWithdrawn, setJustWithdrawn] = useState(false)
  const [history, setHistory] = useState({ items: [], loading: false, error: '' })
  const [historyReload, setHistoryReload] = useState(0)

  useEffect(() => {
    let active = true
    setJustWithdrawn(false)
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

  useEffect(() => {
    let active = true
    if (!registration?.event_id) return undefined
    setHistory({ items: [], loading: true, error: '' })
    getMyRegistrations(token)
      .then((data) => { if (active) setHistory({ items: data.registrations, loading: false, error: '' }) })
      .catch((caught) => { if (active) setHistory({ items: [], loading: false, error: caught.message }) })
    return () => { active = false }
  }, [registration?.event_id, registration?.status, token, historyReload])

  if (loading) {
    return (
      <AttendeeShell>
        <p className="page-state">Loading your registration…</p>
      </AttendeeShell>
    )
  }

  if (error) {
    return (
      <AttendeeShell>
        <div className="page-state">
          <p>{error}</p>
          <Link to="/attendee/registrations" aria-label="Back to my registrations">&larr; Back</Link>
        </div>
      </AttendeeShell>
    )
  }

  return (
    <AttendeeShell>
      <div className="content">
        <Link to="/attendee/registrations" className="backlink" aria-label="Back to my registrations">&larr; Back</Link>

        <div className="content__header">
          <h1>{justRegistered && registration.status !== 'withdrawn' && registration.event_status !== 'cancelled' ? 'Registration successful' : 'Your registration'}</h1>
          <p className="lead">
            {registration.event_status === 'cancelled' ? 'Your registration record for ' : registration.status === 'withdrawn' ? 'You withdrew your registration for ' : 'You are registered for '}
            <strong>{registration.event_name}</strong>.
          </p>
        </div>

        {registration.event_status === 'cancelled' && <EventCancelledNotice hasRegistration />}
        {justWithdrawn && registration.status === 'withdrawn' && (
          <p className="form-success" role="status">
            Your registration is withdrawn. You no longer hold a place at this event.
          </p>
        )}

        {justRegistered && registration.status !== 'withdrawn' && registration.event_status !== 'cancelled' && (
          <p className="form-success" role="status">
            Your spot is secured.
            {emailSent
              ? ` A confirmation email has been sent to ${registration.email}.`
              : ' We could not send a confirmation email right now, but your'
                + ' registration is saved and you can always find it here.'}
          </p>
        )}

        {registration.event_status !== 'cancelled' && attendeeEventNote(registration.event_status, registration.event_end_time) && (
          <p className="note">
            {attendeeEventNote(registration.event_status, registration.event_end_time)}
          </p>
        )}

        <dl className="detail-list attendee-registration-details">
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

        </dl>

        <section className="attendee-panel attendee-management" aria-label="Manage registration">
          <div className="attendee-management__summary">
            <h2>{registration.event_status === 'cancelled' ? 'Event cancelled' : registration.status === 'withdrawn' ? 'Your place has been released' : 'Manage your registration'}</h2>
            <p className="note">{registration.event_status === 'cancelled'
              ? 'Registration and withdrawal are unavailable for this cancelled event.'
              : registration.status === 'withdrawn'
              ? canRegisterAgain
                ? 'You can register again while registration is open and slots are available.'
                : 'Registration is currently unavailable. You can still view your history below.'
              : registration.can_withdraw
                ? `You can withdraw before ${formatDateTime(registration.event_start_time)}.`
                : 'Withdrawal is no longer available for this registration.'}</p>
          </div>
          <RegistrationWithdrawal
            key={registration.id}
            compact
            registration={registration}
            onUpdate={(updated) => {
              setJustWithdrawn(registration.status !== 'withdrawn' && updated.status === 'withdrawn')
              setRegistration(updated)
            }}
          />
          {canRegisterAgain && (
            <Link to={`/attendee/events/${registration.event_id}`} className="button">Register again</Link>
          )}
        </section>

        <nav className="attendee-related-links" aria-label="Registration navigation">
          <Link to={`/attendee/events/${registration.event_id}`} className="button">View event details</Link>
          <Link to="/attendee/events" className="button button--secondary">Browse more events</Link>
        </nav>

        {history.loading && <p className="note" role="status">Loading registration history...</p>}
        {history.error && <div className="stack stack--tight">
          <p className="form-error" role="alert">Registration history could not be loaded. {history.error}</p>
          <button type="button" className="attendee-text-button" onClick={() => setHistoryReload((current) => current + 1)}>Retry history</button>
        </div>}
        {!history.loading && !history.error && <RegistrationHistory
          registrations={history.items}
          eventId={registration.event_id}
          currentRegistrationId={registration.id}
        />}
      </div>
    </AttendeeShell>
  )
}
