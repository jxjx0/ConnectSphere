import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import {
  approveAssignedChangeRequest,
  approveAssignedEvent,
  getAssignedEventRequest,
  rejectAssignedChangeRequest,
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

const CHANGE_FIELDS = [
  { key: 'name', label: 'Event name' },
  { key: 'description', label: 'Description' },
  { key: 'purpose', label: 'Purpose' },
  { key: 'category', label: 'Category' },
  { key: 'category_other', label: 'Other category details' },
  { key: 'start_time', label: 'Start time' },
  { key: 'end_time', label: 'End time' },
  { key: 'expected_attendance', label: 'Expected attendance' },
  { key: 'location_preference', label: 'Preferred location' },
  { key: 'layout_preference', label: 'Room layout' },
  { key: 'accessibility_requirements', label: 'Accessibility needs' },
  { key: 'equipment_requirements', label: 'Equipment needs' },
]

function normalizedValue(key, value) {
  if (value == null) return ''
  if (key === 'start_time' || key === 'end_time') {
    return new Date(value).getTime()
  }
  return String(value).trim()
}

function displayChangeValue(key, value, categoryOther) {
  if (key === 'category') return categoryLabel(value, categoryOther)
  if (key === 'start_time' || key === 'end_time') return formatDateTime(value)
  if (key === 'expected_attendance') return `${value} people`
  return optional(value)
}

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
  const [rejectionReason, setRejectionReason] = useState('')
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
    const reviewingChange = event.status === 'change_requested'
    if (reviewingChange && decision === 'reject' && !rejectionReason.trim()) {
      setDecisionError('Give a reason for rejecting this change request.')
      return
    }
    const confirmation = reviewingChange
      ? 'Reject this proposed change?'
      : 'Reject this event request?'
    if (decision === 'reject' && !window.confirm(confirmation)) {
      return
    }

    setDecisionError('')
    setDeciding(true)
    try {
      if (reviewingChange) {
        const data = decision === 'approve'
          ? await approveAssignedChangeRequest(eventId, token)
          : await rejectAssignedChangeRequest(eventId, rejectionReason.trim(), token)
        setEvent({
          ...data.event,
          change_request: data.change_request,
          has_pending_change_request: false,
        })
      } else {
        const data = decision === 'approve'
          ? await approveAssignedEvent(eventId, token)
          : await rejectAssignedEvent(eventId, token)
        setEvent(data.event)
      }
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

        {event.status === 'change_requested'
          && event.change_request?.status === 'pending' && (
          <section className="stack stack--tight">
            <h2 className="section-title">Organiser's proposed changes</h2>
            <p><strong>Reason for change:</strong> {event.change_request.reason_for_change}</p>
            <dl className="answers">
              {CHANGE_FIELDS
                .filter(({ key }) => normalizedValue(key, event[key])
                  !== normalizedValue(key, event.change_request[key]))
                .map(({ key, label }) => (
                  <div className="answer answer--wide" key={key}>
                    <dt>{label}</dt>
                    <dd>
                      {displayChangeValue(key, event[key], event.category_other)}
                      {' → '}
                      {displayChangeValue(
                        key,
                        event.change_request[key],
                        event.change_request.category_other,
                      )}
                    </dd>
                  </div>
                ))}
            </dl>
          </section>
        )}

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

        {event.status === 'change_requested'
          && event.change_request?.status === 'pending' && (
          <section className="stack stack--tight">
            <h2 className="section-title">Review proposed changes</h2>
            {decisionError && (
              <p className="form-error" role="alert">{decisionError}</p>
            )}
            <label className="field">
              <span>Reason for rejection (required if rejecting)</span>
              <textarea
                value={rejectionReason}
                onChange={(change) => {
                  setRejectionReason(change.target.value)
                  setDecisionError('')
                }}
                maxLength={2000}
              />
            </label>
            <div className="form-actions">
              <button
                type="button"
                className="button"
                onClick={() => decide('approve')}
                disabled={deciding}
              >
                {deciding ? 'Saving…' : 'Approve and apply changes'}
              </button>
              <button
                type="button"
                className="button button--secondary"
                onClick={() => decide('reject')}
                disabled={deciding}
              >
                Reject change request
              </button>
            </div>
          </section>
        )}
      </div>
    </AppShell>
  )
}
