import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import {
  getMyEvent,
  getMyEventArrangements,
  saveEventRegistration,
} from '../api/events'
import AppShell from '../components/AppShell'
import { useAuth } from '../context/AuthContext'
import { categoryLabel } from '../eventCategories'
import { formatDateRange, formatDateTime, optional } from '../eventDisplay'
import {
  REGISTRATION_STATUSES,
  largestAllowedCapacity,
  pendingItems,
  previewSessions,
  registrationFormFrom,
  registrationHasClosed,
  registrationToPayload,
  sessionCapacityNotes,
  validateRegistration,
} from '../eventRegistration'

export default function EventRegistrationPage() {
  const { token } = useAuth()
  const { eventId } = useParams()

  const [event, setEvent] = useState(null)
  const [arrangements, setArrangements] = useState([])
  const [form, setForm] = useState(null)
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [success, setSuccess] = useState('')
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      getMyEvent(eventId, token),
      getMyEventArrangements(eventId, token),
    ])
      .then(([eventData, arrangementData]) => {
        setEvent(eventData.event)
        setArrangements(arrangementData.arrangements)
        setForm(registrationFormFrom(eventData.event, arrangementData.arrangements))
      })
      .catch((caught) => setLoadError(caught.message))
      .finally(() => setLoading(false))
  }, [eventId, token])

  function updateField(name) {
    return (changeEvent) => {
      setForm((current) => ({ ...current, [name]: changeEvent.target.value }))
      setError('')
      setSuccess('')
    }
  }

  async function save(publish) {
    const problem = validateRegistration(form, event, arrangements)
    if (problem) {
      setError(problem)
      return
    }
    setSaving(true)
    setError('')
    setSuccess('')
    try {
      const data = await saveEventRegistration(
        eventId, registrationToPayload(form, publish), token,
      )
      setEvent(data.event)
      setSuccess(publish
        ? 'Your event is published for attendee registration.'
        : 'Registration settings saved.')
    } catch (caught) {
      setError(caught.message)
    } finally {
      setSaving(false)
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
          <Link to="/my-events">Back to my event requests</Link>
        </div>
      </AppShell>
    )
  }

  const backlink = (
    <Link to={`/my-events/${eventId}`} className="backlink">← Event details</Link>
  )

  if (!REGISTRATION_STATUSES.includes(event.status)) {
    return (
      <AppShell>
        <div className="content">
          {backlink}
          <p className="note">
            Registration can be set up once your Coordinator has approved the
            event request.
          </p>
        </div>
      </AppShell>
    )
  }

  const closed = registrationHasClosed(event)
  const pending = pendingItems(event, arrangements)
  const capacityLimit = largestAllowedCapacity(event, arrangements)
  const sessions = previewSessions(event, arrangements)
  const capacityNotes = sessionCapacityNotes(sessions)
  const published = Boolean(event.published_at)

  return (
    <AppShell>
      <div className="content">
        {backlink}

        <div className="content__header">
          <h1>Registration and capacity</h1>
          <p className="lead">
            Choose when attendees can register and how many can attend, then
            preview the event as attendees will see it.
          </p>
        </div>

        {published && (
          <p className="form-success" role="status">
            Published {formatDateTime(event.published_at)}. Attendees can see
            this event.
          </p>
        )}

        {pending.length > 0 && (
          <section className="notice" aria-label="Still pending">
            <p><strong>Waiting for approval before publishing</strong></p>
            <ul>
              {pending.map((item) => <li key={item}>{item}</li>)}
            </ul>
            <p>You can save and preview now, and publish once all of these are approved.</p>
          </section>
        )}

        <form className="form" noValidate onSubmit={(submitEvent) => submitEvent.preventDefault()}>
          <fieldset className="stack stack--tight" disabled={closed || saving}>
            <h2 className="section-title">Registration settings</h2>
            {closed && (
              <p className="note">Registration has closed, so these settings can no longer be edited.</p>
            )}
            <div className="field">
              <label htmlFor="opensAt">Registration opens</label>
              <input id="opensAt" type="datetime-local" value={form.opensAt} onChange={updateField('opensAt')} />
            </div>
            <div className="field">
              <label htmlFor="closesAt">Registration closes</label>
              <input id="closesAt" type="datetime-local" value={form.closesAt} onChange={updateField('closesAt')} />
              <p className="field__hint">Must be before the event starts.</p>
            </div>
            <div className="field">
              <label htmlFor="capacity">Attendee capacity</label>
              <input id="capacity" type="number" min={1} max={capacityLimit ?? undefined} value={form.capacity} onChange={updateField('capacity')} />
              <p className="field__hint">
                {capacityLimit === null
                  ? "The venue limit applies once every session's venue is approved."
                  : `Up to ${capacityLimit}, the combined capacity of the sessions' venues.`}
              </p>
              {capacityNotes.length > 0 && (
                <ul className="field__hint">
                  {capacityNotes.map((note) => <li key={note}>{note}</li>)}
                </ul>
              )}
            </div>
          </fieldset>

          {error && <p className="form-error" role="alert">{error}</p>}
          {success && <p className="form-success" role="status">{success}</p>}

          {!closed && (
            <div className="form-actions">
              <button type="button" className="button button--secondary" disabled={saving} onClick={() => save(false)}>
                {saving ? 'Saving…' : 'Save'}
              </button>
              {!published && (
                <button type="button" className="button" disabled={saving || pending.length > 0} onClick={() => save(true)}>
                  Save and publish
                </button>
              )}
            </div>
          )}
        </form>

        <section className="stack stack--tight" aria-label="Attendee preview">
          <h2 className="section-title">Attendee preview</h2>
          <p className="note">This is what attendees will see, using the settings above.</p>
          <article className="session-card">
            <header className="session-card__head">
              <h3>{event.name}</h3>
              <p className="session-card__meta">
                {categoryLabel(event.category, event.category_other)}
                {' · '}
                {formatDateRange(event.start_time, event.end_time)}
              </p>
            </header>
            <div className="session-card__body">
              <dl className="detail-list detail-list--compact">
                <div className="detail-list__row">
                  <dt>About</dt>
                  <dd>{event.description}</dd>
                </div>
                <div className="detail-list__row">
                  <dt>Accessibility</dt>
                  <dd>{optional(event.accessibility_requirements)}</dd>
                </div>
                <div className="detail-list__row">
                  <dt>Registration</dt>
                  <dd>
                    {form.opensAt && form.closesAt
                      ? `${formatDateTime(form.opensAt)} – ${formatDateTime(form.closesAt)}`
                      : 'Not set yet'}
                  </dd>
                </div>
                <div className="detail-list__row">
                  <dt>Places</dt>
                  <dd>{form.capacity || 'Not set yet'}</dd>
                </div>
              </dl>
            </div>
          </article>

          {sessions.map((session) => (
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
                      {session.venueName
                        ? [session.venueName, session.venueLocation].filter(Boolean).join(', ')
                        : 'To be announced'}
                      {session.venueName && !session.venueConfirmed && ' (pending approval)'}
                    </dd>
                  </div>
                </dl>
              </div>
            </article>
          ))}
        </section>
      </div>
    </AppShell>
  )
}
