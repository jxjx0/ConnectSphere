import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import {
  getMyEvent,
  getMyEventClarifications,
  getMyEventRegistrationCount,
  respondToEventClarification,
  submitEventCancellationRequest,
} from '../api/events'
import AppShell from '../components/AppShell'
import EventStatusPanel from '../components/EventStatusPanel'
import RequestHistory from '../components/RequestHistory'
import SessionList from '../components/SessionList'
import { useAuth } from '../context/AuthContext'
import { categoryLabel } from '../eventCategories'
import {
  CHANGEABLE_STATUSES,
  CANCELLABLE_STATUSES,
  formatDateRange,
  formatDateTime,
  formatSessionSummary,
  optional,
} from '../eventDisplay'
import { statusLabel } from '../eventStatus'
import { REGISTRATION_STATUSES, signUpSummary } from '../eventRegistration'

function Answer({ label, value, wide }) {
  return (
    <div className={wide ? 'answer answer--wide' : 'answer'}>
      <dt>{label}</dt>
      <dd data-empty={!value}>{optional(value)}</dd>
    </div>
  )
}

function OrganiserShell({ children }) {
  return (
    <div className="organiser-ui">
      <AppShell>{children}</AppShell>
    </div>
  )
}

export default function MyEventDetailPage() {
  const { token } = useAuth()
  const { eventId } = useParams()

  const [event, setEvent] = useState(null)
  const [clarifications, setClarifications] = useState([])
  const [responseText, setResponseText] = useState('')
  const [responseError, setResponseError] = useState('')
  const [responding, setResponding] = useState(false)
  const [cancellationReason, setCancellationReason] = useState('')
  const [cancellationError, setCancellationError] = useState('')
  const [cancellationFormOpen, setCancellationFormOpen] = useState(false)
  const [cancellationSubmitting, setCancellationSubmitting] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  // Declared last: page tests set the states above by their position.
  const [registrationCount, setRegistrationCount] = useState(null)
  const [registrationCountError, setRegistrationCountError] = useState('')

  useEffect(() => {
    getMyEvent(eventId, token)
      .then((data) => setEvent(data.event))
      .catch((caught) => setError(caught.message))
      .finally(() => setLoading(false))

    getMyEventClarifications(eventId, token)
      .then((data) => setClarifications(data.clarifications))
      .catch((caught) => setHistoryError(caught.message))
  }, [eventId, token])

  // Attendees can only sign up once the event is published.
  const isPublished = Boolean(event?.published_at)
  useEffect(() => {
    // Clear the previous event's count so it is never shown for this one.
    setRegistrationCount(null)
    setRegistrationCountError('')
    if (!isPublished) return undefined

    let active = true
    getMyEventRegistrationCount(eventId, token)
      .then((data) => {
        if (active) setRegistrationCount(data.registration_count)
      })
      .catch((caught) => {
        if (active) setRegistrationCountError(caught.message)
      })
    return () => {
      active = false
    }
  }, [eventId, token, isPublished])

  async function submitClarificationResponse(eventTarget) {
    eventTarget.preventDefault()
    setResponseError('')
    setResponding(true)
    try {
      const data = await respondToEventClarification(
        eventId, responseText, token,
      )
      setClarifications((history) => history.map((item) => (
        item.id === data.clarification.id ? data.clarification : item
      )))
      setResponseText('')
      // Reload so the clarification badge clears.
      const eventData = await getMyEvent(eventId, token)
      setEvent(eventData.event)
    } catch (caught) {
      setResponseError(caught.message)
    } finally {
      setResponding(false)
    }
  }

  async function submitCancellationRequest(eventTarget) {
    eventTarget.preventDefault()
    const reason = cancellationReason.trim()
    if (!reason) {
      setCancellationError('A reason for cancellation is required.')
      return
    }

    setCancellationError('')
    setCancellationSubmitting(true)
    try {
      const data = await submitEventCancellationRequest(eventId, reason, token)
      setEvent((current) => ({
        ...current,
        cancellation_request: data.cancellation_request,
        cancellation_requests: [data.cancellation_request, ...(current.cancellation_requests || [])],
        has_pending_cancellation_request: true,
      }))
      setCancellationReason('')
      setCancellationFormOpen(false)
    } catch (caught) {
      setCancellationError(caught.message)
    } finally {
      setCancellationSubmitting(false)
    }
  }

  if (loading) {
    return (
      <OrganiserShell>
        <p className="page-state">Loading this event request…</p>
      </OrganiserShell>
    )
  }

  // A request belonging to another Organiser comes back as "not found",
  // which is deliberate -- see get_my_event in event_service.py.
  if (error) {
    return (
      <OrganiserShell>
        <div className="page-state">
          <p>{error}</p>
          <Link to="/my-events">Back to my event requests</Link>
        </div>
      </OrganiserShell>
    )
  }

  const openClarification = clarifications.find((item) => item.status === 'pending')
  const pendingChange = event.change_request?.status === 'pending' ? event.change_request : null
  const pendingCancellation = event.cancellation_request?.status === 'pending'
    ? event.cancellation_request
    : null
  // A pending cancellation pauses new change requests.
  const canRequestChange = CHANGEABLE_STATUSES.includes(event.status)
    && !pendingChange && !pendingCancellation
  const canRequestCancellation = CANCELLABLE_STATUSES.includes(event.status)
    && !pendingCancellation

  return (
    <OrganiserShell>
      <div className="content organiser-event-detail">
        <Link to="/my-events" className="organiser-event-detail__back">
          ← My event requests
        </Link>

        <header className="record-head organiser-event-detail__header">
          <p className="organiser-request__eyebrow">Event overview</p>
          <h1 className="record-head__title">{event.name}</h1>
          <p className="record-head__meta">
            {categoryLabel(event.category, event.category_other)}
            <span className="record-head__dot" aria-hidden="true">
              ·
            </span>
            {formatDateRange(event.start_time, event.end_time)}
            <span className="record-head__dot" aria-hidden="true">
              ·
            </span>
            {formatSessionSummary(event)}
          </p>
        </header>

        <div className="organiser-event-detail__progress">
          <EventStatusPanel event={event} role="organiser" />
        </div>

        {/* Open requests come first: one of them may be waiting on you. */}
        {openClarification && (
          <section className="stack stack--tight organiser-event-detail__notice">
            <h2 className="section-title">The Coordinator has a question</h2>
            <article className="notice">
              <p><strong>Coordinator · {formatDateTime(openClarification.created_at)}</strong></p>
              <p>{openClarification.coordinator_notes}</p>
            </article>
            <form className="stack stack--tight" onSubmit={submitClarificationResponse}>
              <label className="field">
                <span className="field__label">Your reply</span>
                <textarea
                  value={responseText}
                  onChange={(e) => setResponseText(e.target.value)}
                  rows={3}
                  maxLength={5000}
                  required
                  placeholder="Provide the requested information or updates."
                />
              </label>
              {responseError && <p className="form-error" role="alert">{responseError}</p>}
              <div className="form-actions">
                <button className="button" disabled={responding}>
                  {responding ? 'Sending…' : 'Send reply'}
                </button>
              </div>
            </form>
          </section>
        )}

        {pendingChange && (
          <section className="stack stack--tight organiser-event-detail__notice">
            <h2 className="section-title">Your change request</h2>
            <p className="notice" role="status">
              Waiting for the Coordinator to review it. You can submit another
              request after this one has been reviewed.
            </p>
            <p><strong>Reason for change:</strong> {pendingChange.reason_for_change}</p>
          </section>
        )}

        {pendingCancellation && (
          <section className="stack stack--tight organiser-event-detail__notice">
            <h2 className="section-title">Your cancellation request</h2>
            <p className="notice" role="status">
              Waiting for the Coordinator to review it.
            </p>
            <p><strong>Your reason:</strong> {pendingCancellation.reason}</p>
          </section>
        )}

        {historyError && (
          <p className="note organiser-event-detail__history-error" role="status">
            {historyError}
          </p>
        )}

        <section className="stack stack--tight organiser-event-detail__section organiser-event-detail__coordinator">
          <h2 className="section-title">Who is handling this</h2>

          <dl className="answers">
            <div className="answers--paired">
              <Answer
                label="Event Coordinator"
                value={event.coordinator_name}
              />
              <Answer
                label="Current stage"
                value={statusLabel(event.status)}
              />
            </div>
          </dl>
        </section>

        <section className="stack stack--tight organiser-event-detail__section organiser-event-detail__brief">
          <h2 className="section-title">What you asked for</h2>

          <dl className="answers">
            <Answer label="Purpose" value={event.purpose} wide />
            <Answer label="Description" value={event.description} wide />
            <Answer
              label="Accessibility requirements"
              value={event.accessibility_requirements}
              wide
            />
          </dl>
        </section>

        {/* Time, attendance, location, layout and equipment belong to
            each session (T7-276). */}
        <div className="organiser-event-detail__sessions">
          <SessionList event={event} />
        </div>

        {REGISTRATION_STATUSES.includes(event.status) && (
          <section className="stack stack--tight organiser-event-detail__section organiser-event-detail__registration">
            <h2 className="section-title">Attendee registration</h2>
            <dl className="answers">
              <div className="answers--paired">
                <Answer
                  label="Registration period"
                  value={event.registration_opens_at && `${formatDateTime(event.registration_opens_at)} – ${formatDateTime(event.registration_closes_at)}`}
                />
                <Answer label="Attendee capacity" value={event.attendee_capacity} />
              </div>
              {registrationCount !== null && (
                <Answer
                  label="Signed up"
                  value={signUpSummary(registrationCount, event.attendee_capacity)}
                />
              )}
            </dl>
            {registrationCountError && (
              <p className="note" role="status">{registrationCountError}</p>
            )}
            <p className="note">
              {event.published_at
                ? `Published ${formatDateTime(event.published_at)}.`
                : 'Not published yet.'}
            </p>
            <Link to={`/my-events/${event.id}/registration`} className="button">
              {event.registration_opens_at ? 'Edit registration and preview' : 'Set up registration'}
            </Link>
          </section>
        )}

        {(canRequestChange || canRequestCancellation) && (
          <section className="stack stack--tight organiser-event-detail__section organiser-event-detail__actions">
            {cancellationFormOpen ? (
              <>
                <h2 className="section-title">Request cancellation</h2>
                <form
                  className="stack stack--tight"
                  onSubmit={submitCancellationRequest}
                >
                  <label className="field">
                    <span className="field__label">Reason for cancellation</span>
                    <textarea
                      value={cancellationReason}
                      onChange={(change) => {
                        setCancellationReason(change.target.value)
                        setCancellationError('')
                      }}
                      rows={3}
                      required
                    />
                  </label>
                  {cancellationError && (
                    <p className="form-error" role="alert">
                      {cancellationError}
                    </p>
                  )}
                  <div className="form-actions">
                    <button className="button" disabled={cancellationSubmitting}>
                      {cancellationSubmitting ? 'Submitting…' : 'Submit cancellation request'}
                    </button>
                    <button
                      className="button button--secondary"
                      type="button"
                      disabled={cancellationSubmitting}
                      onClick={() => {
                        setCancellationFormOpen(false)
                        setCancellationError('')
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              </>
            ) : (
              <div className="form-actions">
                {canRequestChange && (
                  <Link
                    to={`/my-events/${event.id}/change-request`}
                    className="button"
                  >
                    Request for change
                  </Link>
                )}
                {canRequestCancellation && (
                  <button
                    className="button button--secondary"
                    type="button"
                    onClick={() => setCancellationFormOpen(true)}
                  >
                    Request cancellation
                  </button>
                )}
              </div>
            )}
          </section>
        )}

        <div className="organiser-event-detail__history">
          <RequestHistory clarifications={clarifications} event={event} role="organiser" />
        </div>

        <p className="record-foot organiser-event-detail__footer">
          Submitted {formatDateTime(event.created_at)}
        </p>
      </div>
    </OrganiserShell>
  )
}
