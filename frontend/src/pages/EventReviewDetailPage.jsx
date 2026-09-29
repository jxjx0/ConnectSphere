import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import {
  approveAssignedEvent,
  getAssignedEventRequest,
  getEventSupportingDocuments,
  rejectAssignedEvent,
} from '../api/events'
import AppShell from '../components/AppShell'
import { useAuth } from '../context/AuthContext'
import { formatDateRange, optional, readableStatus } from '../eventDisplay'

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
  const [documents, setDocuments] = useState([])
  const [documentsError, setDocumentsError] = useState('')
  const [error, setError] = useState('')
  const [decisionError, setDecisionError] = useState('')
  const [deciding, setDeciding] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true

    getAssignedEventRequest(eventId, token)
      .then((data) => {
        if (active) setEvent(data.event)
      })
      .catch((caught) => {
        if (active) setError(caught.message)
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    getEventSupportingDocuments(eventId, token)
      .then((data) => {
        if (active) setDocuments(data.documents)
      })
      .catch((caught) => {
        if (active) setDocumentsError(caught.message)
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
          <Link to="/event-reviews">Back to assigned requests</Link>
        </div>
      </AppShell>
    )
  }

  return (
    <AppShell>
      <div className="content">
        <Link to="/event-reviews" className="backlink">
          ← Assigned requests
        </Link>

        <header className="record-head">
          <h1 className="record-head__title">{event.name}</h1>
          <p className="record-head__meta">
            {formatDateRange(event.start_time, event.end_time)}
            <span className="record-head__dot" aria-hidden="true">·</span>
            {event.expected_attendance} expected
            <span className="record-head__dot" aria-hidden="true">·</span>
            <span className="tag">{readableStatus(event.status)}</span>
          </p>
        </header>

        <section className="stack stack--tight">
          <h2 className="section-title">Request details</h2>
          <dl className="answers">
            <Answer label="Purpose" value={event.purpose} />
            <Answer label="Preferred dates" value={formatDateRange(event.start_time, event.end_time)} />
            <Answer label="Estimated attendance" value={`${event.expected_attendance} people`} />
            <Answer label="Room layout" value={event.layout_preference} />
            <Answer label="Equipment needs" value={event.equipment_requirements} />
            <Answer label="Accessibility needs" value={event.accessibility_requirements} />
          </dl>
        </section>

        <section className="stack stack--tight">
          <h2 className="section-title">Supporting documents</h2>
          {documentsError ? (
            <p className="note" role="alert">
              Supporting documents could not be loaded: {documentsError}
            </p>
          ) : documents.length === 0 ? (
            <p className="note">No supporting documents attached.</p>
          ) : (
            <div className="choices">
              {documents.map((document) => (
                <a
                  key={document.id}
                  className="choice"
                  href={document.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  <span className="choice__text">
                    <span className="choice__title">{document.file_name}</span>
                    <span className="choice__description">Open supporting document</span>
                  </span>
                  <span className="choice__arrow" aria-hidden="true">↗</span>
                </a>
              ))}
            </div>
          )}
        </section>

        {['submitted', 'under_review'].includes(event.status) && (
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
      </div>
    </AppShell>
  )
}