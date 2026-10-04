import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import {
  approveAssignedEvent,
  getAssignedEventClarifications,
  getAssignedEventRequest,
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
  const [clarifications, setClarifications] = useState([])
  const [historyError, setHistoryError] = useState('')
  const [error, setError] = useState('')
  const [decisionError, setDecisionError] = useState('')
  const [deciding, setDeciding] = useState(false)
  const [clarificationNotes, setClarificationNotes] = useState('')
  const [clarificationError, setClarificationError] = useState('')
  const [clarifying, setClarifying] = useState(false)
  const [showClarificationForm, setShowClarificationForm] = useState(false)
  const [loading, setLoading] = useState(true)

  // --- ADD THIS STATE FOR AUDIT TRAIL & REASSIGNMENT ---
  const [activityLogs, setActivityLogs] = useState([])
  const [showReassignModal, setShowReassignModal] = useState(false)
  const [coordinators, setCoordinators] = useState([])
  const [selectedCoordinator, setSelectedCoordinator] = useState('')
  const [reassignReason, setReassignReason] = useState('')
  const [reassigning, setReassigning] = useState(false)
  const [reassignError, setReassignError] = useState('')

  useEffect(() => {
    let active = true

    Promise.all([
      getAssignedEventRequest(eventId, token),
      getEventActivityLogs(eventId, token).catch(() => ({ logs: [] })),
    ])
      .then(([data, historyData]) => {
        if (!active) return
        setEvent(data.event)
        setOrganiser(data.organiser)
        setActivityLogs(historyData.logs || [])
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

<<<<<<< HEAD
  //   getAssignedEventRequest(eventId, token)
  //     .then((data) => {
  //       if (!active) return
  //       setEvent(data.event)
  //       setOrganiser(data.organiser)
  //     })
  //     .catch((caught) => {
  //       if (active) setError(caught.message)
  //     })
  //     .finally(() => {
  //       if (active) setLoading(false)
  //     })

  //   return () => {
  //     active = false
  //   }
  // }, [eventId, token])
=======
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
>>>>>>> 5716eff35c999faa6ba3e0235a50a8acc544d984

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

<<<<<<< HEAD
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

  async function loadAuditLogs() {
    try {
      const historyData = await getEventActivityLogs(eventId, token)
      setActivityLogs(historyData.logs || [])
    } catch (err) {
      console.error('Failed to load activity logs:', err)
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
      const data = await reassignAssignedEvent(
        eventId,
        { newCoordinatorId: selectedCoordinator, reason: reassignReason },
        token
      )
      setEvent(data.event)
      setShowReassignModal(false)
      setReassignReason('')
      setSelectedCoordinator('')
      await loadAuditLogs()
    } catch (caught) {
      setReassignError(caught.message)
    } finally {
      setReassigning(false)
    }
  }

=======
>>>>>>> 5716eff35c999faa6ba3e0235a50a8acc544d984
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

          {/* --- ADD THIS BUTTON & MODAL RIGHT HERE --- */}
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
                      {c.full_name} ({c.email || 'Coordinator'})
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
