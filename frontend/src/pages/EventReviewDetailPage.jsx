import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import {
  approveAssignedChangeRequest,
  approveAssignedEvent,
  getAssignedEventClarifications,
  getAssignedEventRequest,
  rejectAssignedChangeRequest,
  requestEventClarification,
  rejectAssignedEvent,

  getCoordinators,
  getEventActivityLogs,
  reassignAssignedEvent,
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
import { getVenueBookingsForEvent } from '../api/venues'

import { requestSafetyCheck } from '../api/events'

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

function getBookingCardStyle(status) {
  switch (status) {
    case 'APPROVED':
      return {
        borderLeft: '3px solid var(--accent)',
        backgroundColor: 'var(--accent-faint)',
      }
    case 'PENDING_VENUE_APPROVAL':
      return {
        borderLeft: '3px solid var(--rule-strong)',
        backgroundColor: 'var(--surface)',
      }
    case 'REJECTED':
      return {
        borderLeft: '3px solid var(--danger)',
        backgroundColor: 'var(--danger-faint)',
      }
    default:
      return {
        borderLeft: '3px solid var(--rule)',
        backgroundColor: 'var(--sunken)',
      }
  }
}

export default function EventReviewDetailPage() {
  const { token } = useAuth()
  const { eventId } = useParams()
  const [event, setEvent] = useState(null)
  const [organiser, setOrganiser] = useState(null)
  const [clarifications, setClarifications] = useState([])
  const [historyError, setHistoryError] = useState('')
  const [error, setError] = useState('')
  const [decisionError, setDecisionError] = useState('')
  const [deciding, setDeciding] = useState(false)
  const [rejectionReason, setRejectionReason] = useState('')
  const [clarificationNotes, setClarificationNotes] = useState('')
  const [clarificationError, setClarificationError] = useState('')
  const [clarifying, setClarifying] = useState(false)
  const [showClarificationForm, setShowClarificationForm] = useState(false)
  const [loading, setLoading] = useState(true)
  const [venueBookings, setVenueBookings] = useState([])

  const [submittingSafety, setSubmittingSafety] = useState(false)

  // --- ADD THIS STATE FOR AUDIT TRAIL & REASSIGNMENT ---
  const [activityLogs, setActivityLogs] = useState([])
  const [showReassignModal, setShowReassignModal] = useState(false)
  const [coordinators, setCoordinators] = useState([])
  const [selectedCoordinator, setSelectedCoordinator] = useState('')
  const [reassignReason, setReassignReason] = useState('')
  const [reassigning, setReassigning] = useState(false)
  const [reassignError, setReassignError] = useState('')
  const [reassignedTo, setReassignedTo] = useState('')

  useEffect(() => {
    let active = true

    Promise.all([
      getAssignedEventRequest(eventId, token),
      getEventActivityLogs(eventId, token).catch(() => ({ logs: [] })),
      getVenueBookingsForEvent(eventId, token).catch(() => ({ bookings: [] })),
    ])
      .then(([data, historyData, bookingData]) => {
        if (!active) return
        setEvent(data.event)
        setOrganiser(data.organiser)
        setActivityLogs(historyData.logs || [])
        setVenueBookings(bookingData.bookings || (bookingData.booking ? [bookingData.booking] : []))
      })
      .catch((caught) => {
        if (active) setError(caught.message)
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    getAssignedEventClarifications(eventId, token)
      .then((data) => {
        if (active) setClarifications(data.clarifications)
      })
      .catch((caught) => {
        if (active) setHistoryError(caught.message)
      })

    return () => {
      active = false
    }
  }, [eventId, token])



  async function requestClarification(eventTarget) {
    eventTarget.preventDefault()
    setClarificationError('')
    setClarifying(true)
    try {
      const data = await requestEventClarification(
        eventId, clarificationNotes, token,
      )
      setClarifications((history) => [...history, data.clarification])
      setEvent((current) => ({
        ...current,
        status: 'awaiting_clarification',
      }))
      setClarificationNotes('')
      setShowClarificationForm(false)
    } catch (caught) {
      setClarificationError(caught.message)
    } finally {
      setClarifying(false)
    }
  }


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
      // 409: someone else already decided. Reload so the page shows the
      // current state instead of buttons that will keep failing.
      if (caught.status === 409) {
        try {
          const data = await getAssignedEventRequest(eventId, token)
          setEvent(data.event)
        } catch {
          // Keep the decision error on screen; the page can be refreshed.
        }
      }
    } finally {
      setDeciding(false)
    }
  }

  async function handleOpenReassignModal() {
    setShowReassignModal(true)
    setReassignError('')
    try {
      const data = await getCoordinators(token)
      const available = (data.coordinators || []).filter(
        (c) => c.id !== event?.coordinator_id
      )
      setCoordinators(available)
    } catch (caught) {
      setReassignError('Failed to load coordinator list.')
    }
  }

  async function handleReassignSubmit(e) {
    e.preventDefault()
    if (!selectedCoordinator) {
      setReassignError('Please select a coordinator.')
      return
    }

    setReassignError('')
    setReassigning(true)

    try {
      await reassignAssignedEvent(
        eventId,
        { newCoordinatorId: selectedCoordinator, reason: reassignReason },
        token
      )
      // The event now belongs to another Coordinator, so this page's
      // actions would all fail. Replace the page with a confirmation.
      const newCoordinator = coordinators.find((c) => c.id === selectedCoordinator)
      setReassignedTo(newCoordinator?.full_name || 'another coordinator')
    } catch (caught) {
      setReassignError(caught.message)
    } finally {
      setReassigning(false)
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

  if (reassignedTo) {
    return (
      <AppShell>
        <div className="page-state">
          <p>
            "{event.name}" has been reassigned to {reassignedTo}. It is no
            longer in your queue.
          </p>
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

          {/* --- ADD THIS BUTTON & MODAL RIGHT HERE --- */}
          {/* {event.status === 'planning' && (
            <div className="form-actions">
              <Link to={`/venues/search?eventId=${encodeURIComponent(eventId)}`} className="button">
                {venueBookings.length > 0 ? 'Find / Request Additional Venue' : 'Find Venue'}
              </Link>
              <Link to={`/safetyreview/${eventId}`} className="button button--secondary">
                Request Safety Check
              </Link>
            </div>
          )} */}

          {event.status === 'planning' && (
            <div className="stack stack--tight">
              <div className="form-actions">
                <Link to={`/venues/search?eventId=${encodeURIComponent(eventId)}`} className="button">
                  {venueBookings.length > 0 ? 'Find / Request Additional Venue' : 'Find Venue'}
                </Link>

                {/* Dynamic Safety Check Status / Button */}
                {event.safety_status === 'pending' ? (
                  <span className="tag tag--orange">Safety Review Pending</span>
                ) : event.safety_status === 'approved' ? (
                  <span className="tag tag--green">Safety Approved</span>
                ) : (
                  <button
                    type="button"
                    className="button button--secondary"
                    disabled={submittingSafety}
                    onClick={async () => {
                      setSubmittingSafety(true)
                      try {
                        await requestSafetyCheck(eventId, token)
                        setEvent((prev) => ({ ...prev, safety_status: 'pending' }))
                      } catch (err) {
                        alert(err.message || 'Failed to request safety check')
                      } finally {
                        setSubmittingSafety(false)
                      }
                    }}
                  >
                    {submittingSafety ? 'Requesting...' : 'Request Safety Check'}
                  </button>
                )}
              </div>

              {/* Success Confirmation */}
              {event.safety_status === 'pending' && (
                <p className="note" style={{ color: 'var(--accent)', marginTop: '0.5rem' }}>
                  ✓ Safety check request submitted successfully!
                </p>
              )}
            </div>
          )}
          {!['completed', 'rejected'].includes(event.status) && (
            <div className="form-actions" style={{ marginTop: '1rem' }}>
              <button
                type="button"
                className="button button--secondary"
                onClick={handleOpenReassignModal}
              >
                Reassign Coordinator
              </button>
            </div>
          )}
        </header>

        {/* --- ADD THIS REASSIGNMENT MODAL JSX --- */}
        {showReassignModal && (
          <section className="stack stack--tight" style={{ border: '1px solid #ccc', padding: '1rem', borderRadius: '8px' }}>
            <h2 className="section-title">Reassign Event Coordinator</h2>
            <form onSubmit={handleReassignSubmit} className="stack stack--tight">
              <div className="field">
                <label htmlFor="coordinatorSelect">Select New Coordinator</label>
                <select
                  id="coordinatorSelect"
                  value={selectedCoordinator}
                  onChange={(e) => setSelectedCoordinator(e.target.value)}
                  required
                >
                  <option value="">Choose a coordinator…</option>
                  {coordinators.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.full_name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="field">
                <label htmlFor="reassignReason">Reason for Reassignment</label>
                <textarea
                  id="reassignReason"
                  rows={3}
                  value={reassignReason}
                  onChange={(e) => setReassignReason(e.target.value)}
                  placeholder="State the reason for reassigning this request."
                  required
                />
              </div>

              {reassignError && (
                <p className="form-error" role="alert">{reassignError}</p>
              )}

              <div className="form-actions">
                <button className="button" disabled={reassigning}>
                  {reassigning ? 'Reassigning…' : 'Confirm Reassignment'}
                </button>
                <button
                  type="button"
                  className="button button--secondary"
                  disabled={reassigning}
                  onClick={() => setShowReassignModal(false)}
                >
                  Cancel
                </button>
              </div>
            </form>
          </section>
        )}

        <section className="stack stack--tight">
          <h2 className="section-title">
            Venue Booking Requests ({venueBookings.length})
          </h2>
          {venueBookings.length === 0 ? (
            <p className="note">No venue booking requests have been submitted for this event yet.</p>
          ) : (
            <ul className="stack stack--tight" style={{ listStyle: 'none', paddingLeft: 0, margin: 0 }}>
              {venueBookings.map((booking) => {
                const cardStyle = getBookingCardStyle(booking.status)
                return (
                  <li
                    key={booking.booking_id}
                    style={{
                      ...cardStyle,
                      borderTop: '1px solid var(--rule)',
                      borderRight: '1px solid var(--rule)',
                      borderBottom: '1px solid var(--rule)',
                      borderRadius: 'var(--radius)',
                      padding: 'var(--space-4)',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--space-2)' }}>
                      <strong style={{ fontSize: '0.9375rem', color: 'var(--ink)' }}>
                        {booking.venues?.name || `Venue ID: ${booking.venue_id}`}
                      </strong>
                      <span className="tag">
                        {readableStatus(booking.status)}
                      </span>
                    </div>

                    <div
                      style={{
                        marginTop: 'var(--space-3)',
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fit, minmax(12rem, 1fr))',
                        gap: 'var(--space-3)',
                        fontSize: '0.8125rem',
                      }}
                    >
                      <div>
                        <span className="note" style={{ display: 'block' }}>Requested Layout:</span>
                        <span style={{ color: 'var(--ink)' }}>{booking.room_layout}</span>
                      </div>
                      <div>
                        <span className="note" style={{ display: 'block' }}>Submitted On:</span>
                        <span style={{ color: 'var(--ink)' }}>{formatDateTime(booking.created_at)}</span>
                      </div>
                      <div style={{ gridColumn: '1 / -1' }}>
                        <span className="note" style={{ display: 'block' }}>Event Period:</span>
                        <span style={{ color: 'var(--ink)' }}>
                          {formatDateTime(booking.start_at)} – {formatDateTime(booking.end_at)}
                        </span>
                      </div>
                      {(booking.setup_buffer_minutes > 0 || booking.teardown_buffer_minutes > 0) && (
                        <div style={{ gridColumn: '1 / -1' }}>
                          <span className="note" style={{ display: 'block' }}>Operational Buffers:</span>
                          <span style={{ color: 'var(--ink)' }}>
                            {booking.setup_buffer_minutes}m setup · {booking.teardown_buffer_minutes}m teardown
                          </span>
                        </div>
                      )}
                    </div>

                    {booking.status === 'REJECTED' && booking.rejection_reason && (
                      <div className="form-error" style={{ marginTop: 'var(--space-3)', maxWidth: 'none' }}>
                        <strong>Rejection Reason:</strong> {booking.rejection_reason}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </section>

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

        {clarifications.length > 0 && (
          <section className="stack stack--tight">
            <h2 className="section-title">Clarification history</h2>
            {clarifications.map((item) => (
              <article className="notice" key={item.id}>
                <p><strong>Coordinator · {formatDateTime(item.requested_at)}</strong></p>
                <p>{item.coordinator_notes}</p>
                {item.organiser_response && (
                  <>
                    <p><strong>Organiser · {formatDateTime(item.responded_at)}</strong></p>
                    <p>{item.organiser_response}</p>
                  </>
                )}
              </article>
            ))}
          </section>
        )}
        {historyError && <p className="note" role="status">{historyError}</p>}

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

        {/* --- ADD THIS AUDIT TRAIL SECTION BEFORE DECISION BUTTONS --- */}
        <section className="stack stack--tight">
          <h2 className="section-title">Audit Trail & Reassignment History</h2>
          {activityLogs.length === 0 ? (
            <p className="note">No reassignments recorded for this event.</p>
          ) : (
            <ul className="stack stack--tight" style={{ listStyle: 'none', paddingLeft: 0 }}>
              {activityLogs.map((log) => (
                <li
                  key={log.id}
                  style={{
                    border: '1px solid #e2e8f0',
                    borderRadius: '6px',
                    padding: '0.75rem 1rem',
                  }}
                >
                  <div>
                    <strong>Reassigned to: </strong>
                    {log.new_coordinator?.full_name || 'Coordinator'}
                    {log.previous_coordinator && (
                      <span> (previously {log.previous_coordinator.full_name})</span>
                    )}
                  </div>
                  <div>
                    <small className="note">
                      By {log.changed_by?.full_name || 'System'} on {formatDateTime(log.created_at)}
                    </small>
                  </div>
                  {log.reason && (
                    <div style={{ marginTop: '0.25rem' }}>
                      <em>Reason: "{log.reason}"</em>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
        {/* Shown while the change is pending, including while a clarification
            is open, so the Coordinator can see what they asked about. */}
        {event.change_request?.status === 'pending' && (
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
