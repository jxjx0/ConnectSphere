import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'

import { getPublishedEvent, registerForEvent } from '../api/events'
import AppShell from '../components/AppShell'
import { useAuth } from '../context/AuthContext'
import {
  EMPTY_REGISTRATION,
  registrationAvailability,
  registrationToPayload,
  spotsLeftLabel,
  validateAttendeeRegistration,
} from '../attendeeRegistration'
import { categoryLabel } from '../eventCategories'
import { formatDateRange, formatDateTime, optional } from '../eventDisplay'

const FIELDS = [
  { name: 'fullName', label: 'Full name', type: 'text', autoComplete: 'name' },
  { name: 'email', label: 'Email', type: 'email', autoComplete: 'email' },
  { name: 'address', label: 'Address', type: 'text', autoComplete: 'street-address' },
  { name: 'contactNumber', label: 'Contact number', type: 'tel', autoComplete: 'tel' },
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

  useEffect(() => {
    getPublishedEvent(eventId, token)
      .then((data) => {
        setEvent(data.event)
        setForm((current) => ({ ...current, email: data.account_email ?? '' }))
      })
      .catch((caught) => setLoadError(caught.message))
      .finally(() => setLoading(false))
  }, [eventId, token])

  function updateField(name) {
    return (changeEvent) => {
      setForm((current) => ({ ...current, [name]: changeEvent.target.value }))
      setErrors([])
    }
  }

  async function handleSubmit(submitEvent) {
    submitEvent.preventDefault()
    const problems = validateAttendeeRegistration(form)
    if (problems.length) {
      setErrors(problems)
      return
    }
    setSubmitting(true)
    setErrors([])
    try {
      const data = await registerForEvent(eventId, registrationToPayload(form), token)
      navigate(`/attendee/registrations/${data.registration.id}`, {
        state: { justRegistered: true, emailSent: data.email_sent },
      })
    } catch (caught) {
      setErrors([caught.message])
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <AppShell>
        <p className="page-state">Loading this event…</p>
      </AppShell>
    )
  }

  if (loadError) {
    return (
      <AppShell>
        <div className="page-state">
          <p>{loadError}</p>
          <Link to="/attendee/events">Back to events</Link>
        </div>
      </AppShell>
    )
  }

  const availability = registrationAvailability(event)

  return (
    <AppShell>
      <div className="content">
        <Link to="/attendee/events" className="backlink">← Events</Link>

        <div className="content__header">
          <h1>{event.name}</h1>
          <p className="lead">
            {categoryLabel(event.category, event.category_other)}
            {' · '}
            {formatDateRange(event.start_time, event.end_time)}
          </p>
        </div>

        <section className="stack stack--tight" aria-label="Event details">
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
              <dt>Registration</dt>
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

        <section className="stack stack--tight" aria-label="Sessions">
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

        <section className="stack stack--tight" aria-label="Register">
          <h2 className="section-title">Register</h2>

          {!availability.open && <p className="note">{availability.message}</p>}
          {event.is_registered && (
            <Link to="/attendee/registrations" className="button button--small">
              View my registrations
            </Link>
          )}

          {availability.open && (
            <form className="form" noValidate onSubmit={handleSubmit}>
              {FIELDS.map((field) => (
                <div className="field" key={field.name}>
                  <label htmlFor={field.name}>{field.label}</label>
                  <input
                    id={field.name}
                    type={field.type}
                    autoComplete={field.autoComplete}
                    value={form[field.name]}
                    onChange={updateField(field.name)}
                    required
                  />
                  {field.name === 'email' && (
                    <p className="field__hint">
                      Your account email. Change it to use a different address;
                      your confirmation email is sent here.
                    </p>
                  )}
                </div>
              ))}

              {errors.length > 0 && (
                <div className="form-error" role="alert">
                  <p>Your registration was not submitted. Please fix the following and try again:</p>
                  <ul>
                    {errors.map((message) => <li key={message}>{message}</li>)}
                  </ul>
                </div>
              )}

              <div className="form-actions">
                <button type="submit" className="button" disabled={submitting}>
                  {submitting ? 'Registering…' : 'Register'}
                </button>
              </div>
            </form>
          )}
        </section>
      </div>
    </AppShell>
  )
}
