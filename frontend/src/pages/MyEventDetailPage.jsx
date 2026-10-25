import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import {
  getMyEvent,
  getMyEventClarifications,
  respondToEventClarification,
} from '../api/events'
import AppShell from '../components/AppShell'
import SessionList from '../components/SessionList'
import { useAuth } from '../context/AuthContext'
import { categoryLabel } from '../eventCategories'
import {
  CHANGEABLE_STATUSES,
  formatDateRange,
  formatDateTime,
  formatSessionSummary,
  optional,
  progressFor,
  readableStatus,
} from '../eventDisplay'
import { REGISTRATION_STATUSES } from '../eventRegistration'

function Answer({ label, value, wide }) {
  return (
    <div className={wide ? 'answer answer--wide' : 'answer'}>
      <dt>{label}</dt>
      <dd data-empty={!value}>{optional(value)}</dd>
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
  const [historyError, setHistoryError] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getMyEvent(eventId, token)
      .then((data) => setEvent(data.event))
      .catch((caught) => setError(caught.message))
      .finally(() => setLoading(false))

    getMyEventClarifications(eventId, token)
      .then((data) => setClarifications(data.clarifications))
      .catch((caught) => setHistoryError(caught.message))
  }, [eventId, token])

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
      // The event returns to its status before clarification, so reload it.
      const eventData = await getMyEvent(eventId, token)
      setEvent(eventData.event)
    } catch (caught) {
      setResponseError(caught.message)
    } finally {
      setResponding(false)
    }
  }

  if (loading) {
    return (
      <AppShell>
        <p className="page-state">Loading this event request…</p>
      </AppShell>
    )
  }

  // A request belonging to another Organiser comes back as "not found",
  // which is deliberate -- see get_my_event in event_service.py.
  if (error) {
    return (
      <AppShell>
        <div className="page-state">
          <p>{error}</p>
          <Link to="/my-events">Back to my event requests</Link>
        </div>
      </AppShell>
    )
  }

  const progress = progressFor(event.status)

  return (
    <AppShell>
      <div className="content">
        <Link to="/my-events" className="backlink">
          ← My event requests
        </Link>

        <header className="record-head">
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

        <section className="progress" aria-label="Request progress">
          <ol className="track">
            {progress.steps.map((step) => (
              <li
                key={step.status}
                className={`track__step track__step--${step.state}`}
                aria-current={step.state === 'current' ? 'step' : undefined}
              >
                <span className="track__dot" aria-hidden="true" />
                <span className="track__label">{step.label}</span>
              </li>
            ))}
          </ol>

          {progress.notice && <p className="notice">{progress.notice}</p>}

          {progress.next && (
            <p className="progress__next">{progress.next}</p>
          )}
        </section>

        {clarifications.length > 0 && (
          <section className="stack stack--tight">
            <h2 className="section-title">Clarification history</h2>
            <div className="stack stack--tight">
              {clarifications.map((item, index) => (
                <article className="notice" key={item.id}>
                  <p><strong>Coordinator · {formatDateTime(item.requested_at)}</strong></p>
                  <p>{item.coordinator_notes}</p>
                  {item.organiser_response ? (
                    <>
                      <p><strong>You · {formatDateTime(item.responded_at)}</strong></p>
                      <p>{item.organiser_response}</p>
                    </>
                  ) : event.status === 'awaiting_clarification' && index === clarifications.length - 1 ? (
                    <p className="note">Your response is needed.</p>
                  ) : null}
                </article>
              ))}
            </div>
          </section>
        )}

        {historyError && <p className="note" role="status">{historyError}</p>}

        {event.status === 'awaiting_clarification' && (
          <section className="stack stack--tight">
            <h2 className="section-title">Respond to clarification</h2>
            <form className="stack stack--tight" onSubmit={submitClarificationResponse}>
              <label className="field">
                <span className="field__label">Your response</span>
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
                  {responding ? 'Submitting…' : 'Submit response'}
                </button>
              </div>
            </form>
          </section>
        )}

        <section className="stack stack--tight">
          <h2 className="section-title">Who is handling this</h2>

          <dl className="answers">
            <div className="answers--paired">
              <Answer
                label="Event Coordinator"
                value={event.coordinator_name}
              />
              <Answer
                label="Current status"
                value={readableStatus(event.status)}
              />
            </div>
          </dl>
        </section>

        <section className="stack stack--tight">
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
        <SessionList event={event} />

        {REGISTRATION_STATUSES.includes(event.status) && (
          <section className="stack stack--tight">
            <h2 className="section-title">Attendee registration</h2>
            <dl className="answers">
              <div className="answers--paired">
                <Answer
                  label="Registration period"
                  value={event.registration_opens_at && `${formatDateTime(event.registration_opens_at)} – ${formatDateTime(event.registration_closes_at)}`}
                />
                <Answer label="Attendee capacity" value={event.attendee_capacity} />
              </div>
            </dl>
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

        <section className="stack stack--tight">
          {event.change_request && (
            <>
              <h2 className="section-title">Latest change request</h2>
              <p className="note">
                Status: {readableStatus(event.change_request.status)}.
                {' '}Reason for change: {event.change_request.reason_for_change}
              </p>
              {event.change_request.rejection_reason && (
                <p className="form-error" role="status">
                  The Coordinator rejected this change request:
                  {' '}{event.change_request.rejection_reason}
                </p>
              )}
              {event.change_request.status === 'approved' && (
                <p className="form-success" role="status">
                  The Coordinator approved and applied the proposed changes.
                </p>
              )}
            </>
          )}
          {event.has_pending_change_request ? (
            <p className="notice" role="status">
              Your change request is waiting for review. You can submit another
              request after this one has been reviewed.
            </p>
          ) : CHANGEABLE_STATUSES.includes(event.status) ? (
            <Link
              to={`/my-events/${event.id}/change-request`}
              className="button"
            >
              Request for change
            </Link>
          ) : null}
        </section>

        <p className="record-foot">
          Submitted {formatDateTime(event.created_at)}
        </p>
      </div>
    </AppShell>
  )
}
