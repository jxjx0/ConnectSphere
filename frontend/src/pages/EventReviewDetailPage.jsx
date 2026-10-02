import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import {
  approveAssignedEvent,
  getAssignedEventRequest,
  requestEventClarification,
  rejectAssignedEvent,
} from '../api/events'
import AppShell from '../components/AppShell'
import { useAuth } from '../context/AuthContext'
import { categoryLabel } from '../eventCategories'
import {
  formatDateRange,
  formatDateTime,
  optional,
  readableStatus,
} from '../eventDisplay'

function Answer({ label, value }) {
  return (
    <div className="answer">
      <dt>{label}</dt>
      <dd data-empty={!value}>{optional(value)}</dd>
    </div>
  )
}

export default function EventReviewDetailPage() {
  const { token } = useAuth()
  const { eventId } = useParams()
  const [event, setEvent] = useState(null)
  const [organiser, setOrganiser] = useState(null)
  const [error, setError] = useState('')
  const [decisionError, setDecisionError] = useState('')
  const [deciding, setDeciding] = useState(false)
  const [clarificationNotes, setClarificationNotes] = useState('')
  const [clarificationError, setClarificationError] = useState('')
  const [clarifying, setClarifying] = useState(false)
  const [showClarificationForm, setShowClarificationForm] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true

    getAssignedEventRequest(eventId, token)
      .then((data) => {
        if (!active) return
        setEvent(data.event)
        setOrganiser(data.organiser)
      })
      .catch((caught) => {
        if (active) setError(caught.message)
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => {
      active = false
    }
  }, [eventId, token])

  async function decide(decision) {
    if (decision === 'reject' && !window.confirm('Reject this event request?')) {
      return
    }

    setDecisionError('')
    setDeciding(true)
    try {
      const data = decision === 'approve'
        ? await approveAssignedEvent(eventId, token)
        : await rejectAssignedEvent(eventId, token)
      setEvent(data.event)
    } catch (caught) {
      setDecisionError(caught.message)
    } finally {
      setDeciding(false)
    }
  }

  async function requestClarification(eventTarget) {
    eventTarget.preventDefault()
    setClarificationError('')
    setClarifying(true)
    try {
      const data = await requestEventClarification(
        eventId, clarificationNotes, token,
      )
      setEvent(data.event)
      setClarificationNotes('')
      setShowClarificationForm(false)
    } catch (caught) {
      setClarificationError(caught.message)
    } finally {
      setClarifying(false)
    }
  }

  if (loading) {
    return (
      <AppShell>
        <p className="page-state">Loading this event request…</p>
      </AppShell>
    )
  }

  if (error) {
    return (
      <AppShell>
        <div className="page-state">
          <p>{error}</p>
          <Link to="/dashboard">Back to dashboard</Link>
        </div>
      </AppShell>
    )
  }

  return (
    <AppShell>
      <div className="content">
        <Link to="/dashboard" className="backlink">
          ← Dashboard
        </Link>

        <header className="record-head">
          <h1 className="record-head__title">{event.name}</h1>
          <p className="record-head__meta">
            {categoryLabel(event.category, event.category_other)}
            <span className="record-head__dot" aria-hidden="true">·</span>
            {formatDateRange(event.start_time, event.end_time)}
            <span className="record-head__dot" aria-hidden="true">·</span>
            {event.expected_attendance} expected
            <span className="record-head__dot" aria-hidden="true">·</span>
            <span className="tag">{readableStatus(event.status)}</span>
          </p>
        </header>

        <section className="stack stack--tight">
          <h2 className="section-title">Organiser</h2>
          {organiser ? (
            <dl className="answers">
              <Answer label="Name" value={organiser.full_name} />
              <Answer label="Organisation" value={organiser.organization} />
              <Answer label="Contact number" value={organiser.contact_number} />
            </dl>
          ) : (
            <p className="note">Organiser details are not available.</p>
          )}
        </section>

        {event.clarification_notes && (
          <section className="stack stack--tight">
            <h2 className="section-title">Clarification requested</h2>
            <p className="notice">{event.clarification_notes}</p>
          </section>
        )}

        <section className="stack stack--tight">
          <h2 className="section-title">Request details</h2>
          <dl className="answers">
            <Answer label="Submitted" value={formatDateTime(event.created_at)} />
            <Answer label="Purpose" value={event.purpose} />
            <Answer label="Description" value={event.description} />
            <Answer label="Category" value={categoryLabel(event.category, event.category_other)} />
            <Answer label="Preferred dates" value={formatDateRange(event.start_time, event.end_time)} />
            <Answer label="Estimated attendance" value={`${event.expected_attendance} people`} />
            <Answer label="Preferred location" value={event.location_preference} />
            <Answer label="Room layout" value={event.layout_preference} />
            <Answer label="Equipment needs" value={event.equipment_requirements} />
            <Answer label="Accessibility needs" value={event.accessibility_requirements} />
          </dl>
        </section>

        {event.status === 'under_review' && (
          <section className="stack stack--tight">
            <h2 className="section-title">Review decision</h2>
            {decisionError && (
              <p className="form-error" role="alert">{decisionError}</p>
            )}
            <div className="form-actions">
              <button
                type="button"
                className="button"
                onClick={() => decide('approve')}
                disabled={deciding}
              >
                {deciding ? 'Saving…' : 'Approve'}
              </button>
              <button
                type="button"
                className="button button--secondary"
                onClick={() => decide('reject')}
                disabled={deciding}
              >
                Reject
              </button>
            </div>
          </section>
        )}

        {['under_review', 'planning', 'change_requested'].includes(event.status) && (
          <section className="stack stack--tight">
            {!showClarificationForm ? (
              <button
                type="button"
                className="button button--secondary"
                onClick={() => setShowClarificationForm(true)}
              >
                Request Clarification
              </button>
            ) : (
              <form className="stack stack--tight" onSubmit={requestClarification}>
                <label className="field">
                  <span className="field__label">What needs clarification?</span>
                  <textarea
                    value={clarificationNotes}
                    onChange={(e) => setClarificationNotes(e.target.value)}
                    rows={3}
                    maxLength={5000}
                    required
                    autoFocus
                    placeholder="Describe the information or amendments needed."
                  />
                </label>
                {clarificationError && (
                  <p className="form-error" role="alert">{clarificationError}</p>
                )}
                <div className="form-actions">
                  <button className="button" disabled={clarifying}>
                    {clarifying ? 'Sending…' : 'Send request'}
                  </button>
                  <button
                    type="button"
                    className="button button--secondary"
                    disabled={clarifying}
                    onClick={() => {
                      setShowClarificationForm(false)
                      setClarificationError('')
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </section>
        )}
      </div>
    </AppShell>
  )
}
