import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'

import { getMyRegistrations, getPublishedEvent, registerForEvent } from '../api/events'
import AttendeeShell from '../components/AttendeeShell'
import EventCancelledNotice from '../components/EventCancelledNotice'
import RegistrationWithdrawal from '../components/RegistrationWithdrawal'
import RegistrationHistory from '../components/RegistrationHistory'
import { useAuth } from '../context/AuthContext'
import {
  EMPTY_REGISTRATION,
  attendeeRegistrationFieldErrors,
  registrationAvailability,
  registrationStatusLabel,
  registrationToPayload,
  spotsLeftLabel,
  validateAttendeeRegistration,
} from '../attendeeRegistration'
import { categoryLabel } from '../eventCategories'
import { formatDateRange, formatDateTime, optional } from '../eventDisplay'

const FIELDS = [
  { name: 'fullName', label: 'Full name', type: 'text', autoComplete: 'name', required: true },
  { name: 'email', label: 'Email', type: 'email', autoComplete: 'email', readOnly: true },
  { name: 'contactNumber', label: 'Contact number (optional)', type: 'tel', autoComplete: 'tel' },
]

export default function AttendeeEventDetailPage() {
  const { user, token } = useAuth()
  const { eventId } = useParams()
  const navigate = useNavigate()

  const [event, setEvent] = useState(null)
  const [form, setForm] = useState({
    ...EMPTY_REGISTRATION,
    fullName: user.full_name,
    contactNumber: user.contact_number ?? '',
  })
  const [errors, setErrors] = useState([])
  const [loadError, setLoadError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [loading, setLoading] = useState(true)
  const [registration, setRegistration] = useState(null)
  const [registrationError, setRegistrationError] = useState('')
  const [registrationHistory, setRegistrationHistory] = useState([])
  const requestScope = useRef(0)
  const formElement = useRef(null)
  const submitPending = useRef(false)

  useEffect(() => {
    requestScope.current += 1
    const scope = requestScope.current
    setLoading(true)
    setLoadError('')
    setRegistration(null)
    setRegistrationHistory([])
    setRegistrationError('')
    setErrors([])
    setSubmitting(false)
    submitPending.current = false
    getPublishedEvent(eventId, token)
      .then(async (data) => {
        if (scope !== requestScope.current) return
        setEvent(data.event)
        setForm((current) => ({ ...current, email: data.account_email ?? '' }))
        try {
          const owned = await getMyRegistrations(token)
          if (scope !== requestScope.current) return
          setRegistrationHistory(owned.registrations)
          const current = owned.registrations.find(
            (item) => item.event_id === eventId && item.status === 'registered',
          )
          setRegistration(current ?? null)
          if (data.event.is_registered && !current) {
            setRegistrationError('Refresh the page to load your latest registration.')
          }
        } catch (caught) {
          if (scope === requestScope.current) setRegistrationError(caught.message)
        }
      })
      .catch((caught) => { if (scope === requestScope.current) setLoadError(caught.message) })
      .finally(() => { if (scope === requestScope.current) setLoading(false) })
    return () => { requestScope.current += 1 }
  }, [eventId, token])

  function updateRegistration(updated) {
    const scope = requestScope.current
    setRegistration(updated)
    setRegistrationHistory((current) => current.map((item) => item.id === updated.id ? updated : item))
    setRegistrationError('')
    setEvent((current) => ({
      ...current,
      is_registered: updated.status === 'registered',
      status: updated.event_status,
    }))
    // Place counts come from the server after withdrawal, never a local counter.
    getPublishedEvent(eventId, token)
      .then((data) => { if (scope === requestScope.current) setEvent(data.event) })
      .catch(() => {
        if (scope === requestScope.current) {
          setRegistrationError('Your registration was updated. Refresh the page for the latest event availability.')
        }
      })
  }

  function updateField(name) {
    return (changeEvent) => {
      setForm((current) => ({ ...current, [name]: changeEvent.target.value }))
      setErrors([])
    }
  }

  async function handleSubmit(submitEvent) {
    submitEvent.preventDefault()
    if (submitPending.current) return
    const problems = validateAttendeeRegistration(form)
    if (problems.length) {
      setErrors(problems)
      const firstField = Object.keys(attendeeRegistrationFieldErrors(form))[0]
      formElement.current?.querySelector(`#${firstField}`)?.focus()
      return
    }
    const scope = requestScope.current
    submitPending.current = true
    setSubmitting(true)
    setErrors([])
    try {
      const data = await registerForEvent(eventId, registrationToPayload(form), token)
      if (scope !== requestScope.current) return
      navigate(`/attendee/registrations/${data.registration.id}`, {
        state: { justRegistered: true, emailSent: data.email_sent },
      })
    } catch (caught) {
      if (scope === requestScope.current) setErrors([caught.message])
      if (caught.status === 409 && scope === requestScope.current) {
        try {
          const latest = await getPublishedEvent(eventId, token)
          if (scope === requestScope.current) setEvent(latest.event)
        } catch { /* Keep the submission error and entered details available. */ }
      }
    } finally {
      if (scope === requestScope.current) {
        submitPending.current = false
        setSubmitting(false)
      }
    }
  }

  if (loading) {
    return (
      <AttendeeShell>
        <p className="page-state">Loading this event…</p>
      </AttendeeShell>
    )
  }

  if (loadError) {
    return (
      <AttendeeShell>
        <div className="page-state">
          <p>{loadError}</p>
          <Link to="/attendee/events">Back to events</Link>
        </div>
      </AttendeeShell>
    )
  }

  const availability = registrationAvailability(event)
  const fieldProblems = attendeeRegistrationFieldErrors(form)

  return (
    <AttendeeShell>
      <div className="content">
        <Link to="/attendee/events" className="backlink">← Events</Link>

        <div className="content__header">
          <h1>{event.name}</h1>
          <p className="lead">
            {categoryLabel(event.category, event.category_other)}
            {' · '}
            {formatDateRange(event.start_time, event.end_time)}
          </p>
          <p className="record-head__meta">
            <strong>{registrationStatusLabel(event)}</strong>
          </p>
        </div>

        {event.status === 'cancelled' && <EventCancelledNotice hasRegistration={event.is_registered || registrationHistory.some((item) => item.event_id === eventId)} />}
        {availability.open && <a href="#event-registration" className="button attendee-jump">Register for this event</a>}
        <div className="attendee-event-layout">
        <section className="stack stack--tight attendee-panel" aria-label="Event details">
          <dl className="detail-list">
            <div className="detail-list__row">
              <dt>About</dt>
              <dd>{optional(event.description)}</dd>
            </div>
            <div className="detail-list__row">
              <dt>Purpose</dt>
              <dd>{optional(event.purpose)}</dd>
            </div>
            <div className="detail-list__row">
              <dt>Accessibility</dt>
              <dd>{optional(event.accessibility_requirements)}</dd>
            </div>
            <div className="detail-list__row">
              <dt>Registration period</dt>
              <dd>
                {formatDateTime(event.registration_opens_at)}
                {' – '}
                {formatDateTime(event.registration_closes_at)}
              </dd>
            </div>
            <div className="detail-list__row">
              <dt>Places</dt>
              <dd>{spotsLeftLabel(event)} of {event.attendee_capacity}</dd>
            </div>
          </dl>
        </section>

        <section className="stack stack--tight attendee-panel" aria-label="Sessions">
          <h2 className="section-title">Sessions</h2>
          {event.sessions.map((session) => (
            <article className="session-card" key={session.id}>
              <header className="session-card__head">
                <h3>{session.name}</h3>
                <p className="session-card__meta">
                  {formatDateRange(session.start_time, session.end_time)}
                </p>
              </header>
              <div className="session-card__body">
                <dl className="detail-list detail-list--compact">
                  <div className="detail-list__row">
                    <dt>Venue</dt>
                    <dd>
                      {session.venue_name
                        ? [session.venue_name, session.venue_location].filter(Boolean).join(', ')
                        : 'To be announced'}
                    </dd>
                  </div>
                </dl>
              </div>
            </article>
          ))}
        </section>

        <section className="stack stack--tight attendee-panel attendee-register-panel" id="event-registration" aria-label="Register">
          <h2 className="section-title">{event.is_registered ? 'Your place' : 'Register'}</h2>

          {!availability.open && <p className="note">{availability.message}</p>}
          {registration?.status === 'withdrawn' && (
            <p className="form-success" role="status">
              Your registration has been withdrawn. You no longer hold a place at this event.
            </p>
          )}
          {registrationError && <p className="form-error" role="alert">{registrationError}</p>}
          {registration && (
            <RegistrationWithdrawal
              key={registration.id}
              registration={registration}
              onUpdate={updateRegistration}
            />
          )}
          {event.is_registered && (
            <Link to="/attendee/registrations" className="button button--small">
              View my registrations
            </Link>
          )}

          {errors.length > 0 && (
            <div className="form-error" role="alert">
              <p>Your registration was not submitted:</p>
              <ul>{errors.map((message) => <li key={message}>{message}</li>)}</ul>
            </div>
          )}
          {availability.open && (
            <form ref={formElement} className="form" noValidate onSubmit={handleSubmit} aria-busy={submitting}>
              <p className="note">Confirm your details to register for the whole event.</p>
              {FIELDS.map((field) => {
                const fieldError = errors.includes(fieldProblems[field.name]) ? fieldProblems[field.name] : null
                return <div className="field" key={field.name}>
                  <label htmlFor={field.name}>{field.label}</label>
                  <input
                    id={field.name}
                    name={field.name}
                    maxLength={field.name === 'fullName' ? 120 : field.name === 'contactNumber' ? 30 : undefined}
                    disabled={submitting}
                    aria-invalid={Boolean(fieldError)}
                    aria-describedby={fieldError ? `${field.name}-error` : field.name === 'email' ? 'registration-email-hint' : undefined}
                    type={field.type}
                    autoComplete={field.autoComplete}
                    value={form[field.name]}
                    onChange={field.readOnly ? undefined : updateField(field.name)}
                    readOnly={field.readOnly}
                    required={field.required}
                  />
                  {field.name === 'email' && (
                    <p className="field__hint" id="registration-email-hint">
                      Your account email. Your confirmation email is sent here.
                    </p>
                  )}
                  {fieldError && <p className="field__error" id={`${field.name}-error`}>{fieldError}</p>}
                </div>
              })}


              <div className="form-actions">
                <button type="submit" className="button" disabled={submitting}>
                  {submitting ? 'Registering…' : 'Register'}
                </button>
              </div>
            </form>
          )}
        </section>
        <RegistrationHistory registrations={registrationHistory} eventId={eventId} />
        </div>
      </div>
    </AttendeeShell>
  )
}
