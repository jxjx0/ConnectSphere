import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import {
  approveAssignedCancellationRequest,
  approveAssignedChangeRequest,
  approveAssignedEvent,
  getAssignedEventClarifications,
  getAssignedEventRequest,
  rejectAssignedCancellationRequest,
  rejectAssignedChangeRequest,
  requestEventClarification,
  rejectAssignedEvent,

} from '../api/events'
import AppShell from '../components/AppShell'
import CancelArrangementForm from '../components/CancelArrangementForm'
import EquipmentRequestCard from '../components/EquipmentRequestCard'
import EventStatusPanel from '../components/EventStatusPanel'
import RequestHistory from '../components/RequestHistory'
import SessionList from '../components/SessionList'
import { useAuth } from '../context/AuthContext'
import { categoryLabel } from '../eventCategories'
import {
  formatDateRange,
  formatDateTime,
  formatSessionSummary,
  optional,
  readableStatus,
  sessionsOf,
} from '../eventDisplay'
import { cancelVenueBooking, getVenueBookingsForEvent } from '../api/venues'
import { cancelEquipmentRequest, getEventEquipmentRequests } from '../api/equipmentRequests'
import { canCancelEquipmentRequest, canCancelVenueBooking } from '../cancelArrangements'
import {
  safetyCheckChecklist,
  venueTagClass,
  visibleVenueBookings,
} from '../coordinatorEventView'
import { sessionsWithoutEquipmentRequest } from '../equipmentRequestEligibility'
import { sessionChanges, sessionsNeedingRebooking } from '../changeRequestSessions'
import { ACTIVE_STATUSES, forwardBlocker } from '../eventStatus'

import { requestSafetyCheck } from '../api/events'

// Event-level details a change request can change. Time, attendance and
// space and equipment needs belong to the sessions (T7-280).
const CHANGE_FIELDS = [
  { key: 'name', label: 'Event name' },
  { key: 'description', label: 'Description' },
  { key: 'purpose', label: 'Purpose' },
  { key: 'category', label: 'Category' },
  { key: 'category_other', label: 'Other category details' },
  { key: 'accessibility_requirements', label: 'Accessibility needs' },
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

function sessionSummary(session) {
  return `${formatDateRange(session.start_time, session.end_time)} · ${session.expected_attendance} attendees`
}

// The proposed sessions compared with the current ones (T7-280).
function ProposedSessionChanges({ event }) {
  const { added, removed, edited } = sessionChanges(sessionsOf(event), event.change_request.sessions)
  if (!added.length && !removed.length && !edited.length) {
    return <p className="note">No session changes.</p>
  }
  return (
    <div className="stack stack--tight">
      {edited.map(({ session, fields }) => (
        <div className="session-card" key={session.id}>
          <h3>Changed: {session.name}</h3>
          <dl className="answers">
            {fields.map(({ key, label, before, after }) => (
              <div className="answer answer--wide" key={key}>
                <dt>{label}</dt>
                <dd>{displayChangeValue(key, before)}{' → '}{displayChangeValue(key, after)}</dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
      {added.map((session) => (
        <div className="session-card" key={`new-${session.id}`}>
          <h3>Added: {session.name}</h3>
          <p className="note">{sessionSummary(session)}</p>
          {session.equipment_requirements && <p className="note">Equipment: {session.equipment_requirements}</p>}
        </div>
      ))}
      {removed.map((session) => (
        <div className="session-card" key={`removed-${session.id}`}>
          <h3>Removed: {session.name}</h3>
          <p className="note">{sessionSummary(session)}</p>
        </div>
      ))}
    </div>
  )
}

// Pending bookings of sessions the pending change moves or removes; the
// Coordinator chooses which to cancel when approving (T7-281).
function pendingBookingsAffectedBy(event, venueBookings) {
  if (event.change_request?.status !== 'pending') return []
  const sessionIds = sessionsNeedingRebooking(sessionsOf(event), event.change_request.sessions)
  return venueBookings.filter((booking) =>
    booking.status === 'PENDING_VENUE_APPROVAL' && sessionIds.includes(booking.session_id))
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
    case 'AFFECTED_BY_UNAVAILABILITY':
    case 'AFFECTED_BY_SESSION_CHANGE':
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
  const [equipmentRequests, setEquipmentRequests] = useState([])
  const [equipmentRequestError, setEquipmentRequestError] = useState('')

  const [submittingSafety, setSubmittingSafety] = useState(false)
  const [safetyError, setSafetyError] = useState('')
  const [hasActiveHold, setHasActiveHold] = useState(false)
  const [venueError, setVenueError] = useState('')
  const [safetyDecision, setSafetyDecision] = useState(null)
  // Pending bookings the Coordinator unticked, so they stay pending when the
  // change is approved. Everything else listed is cancelled (T7-281).
  const [keptPendingIds, setKeptPendingIds] = useState(() => new Set())

  useEffect(() => {
    let active = true

    Promise.all([
      getAssignedEventRequest(eventId, token),
      getVenueBookingsForEvent(eventId, token).catch(caught => ({ bookings: [], error: caught.message })),
      getEventEquipmentRequests(eventId, token).catch((caught) => {
        if (active) setEquipmentRequestError(caught.message)
        return null
      }),
    ])
      .then(([data, bookingData, requestData]) => {
        if (!active) return
        setEvent(data.event)
        setOrganiser(data.organiser)
        setSafetyDecision(data.safety_decision ?? null)
        setVenueBookings(bookingData.bookings || [])
        setHasActiveHold(bookingData.has_active_venue_hold === true)
        setVenueError(bookingData.error || '')
        if (requestData) setEquipmentRequests(requestData.requests || [])
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
      setEvent((current) => ({ ...current, has_open_clarification: true }))
      setClarificationNotes('')
      setShowClarificationForm(false)
    } catch (caught) {
      setClarificationError(caught.message)
    } finally {
      setClarifying(false)
    }
  }


  // Reload the event, its arrangements and its clarifications: a decision
  // can change the status, the badges, sessions, bookings and equipment,
  // and ending the event expires any open clarification.
  async function reloadEvent() {
    const [data, bookingData, requestData, clarificationData] = await Promise.all([
      getAssignedEventRequest(eventId, token),
      getVenueBookingsForEvent(eventId, token),
      getEventEquipmentRequests(eventId, token),
      getAssignedEventClarifications(eventId, token),
    ])
    setEvent(data.event)
    setVenueBookings(bookingData.bookings || [])
    setEquipmentRequests(requestData.requests || [])
    setClarifications(clarificationData.clarifications)
  }

  // kind is 'event' (accept or reject the request), 'change' or
  // 'cancellation'.
  async function decide(kind, decision) {
    const trimmedReason = rejectionReason.trim()
    if (kind === 'cancellation' && !trimmedReason) {
      setDecisionError('Give a decision reason before approving or rejecting this cancellation request.')
      return
    }
    if (kind === 'change' && decision === 'reject' && !trimmedReason) {
      setDecisionError('Give a reason for rejecting this change request.')
      return
    }
    const confirmation = {
      cancellation: decision === 'reject'
        ? 'Reject this cancellation request?'
        : 'Approve this cancellation request and cancel the event?',
      change: decision === 'reject' ? 'Reject this proposed change?' : null,
      event: decision === 'reject' ? 'Reject this event request?' : null,
    }[kind]
    if (confirmation && !window.confirm(confirmation)) {
      return
    }

    setDecisionError('')
    setDeciding(true)
    try {
      if (kind === 'cancellation') {
        if (decision === 'approve') {
          await approveAssignedCancellationRequest(eventId, trimmedReason, token)
        } else {
          await rejectAssignedCancellationRequest(eventId, trimmedReason, token)
        }
      } else if (kind === 'change') {
        if (decision === 'approve') {
          await approveAssignedChangeRequest(
            eventId,
            pendingBookingsAffectedBy(event, venueBookings)
              .filter((booking) => !keptPendingIds.has(booking.booking_id))
              .map((booking) => booking.booking_id),
            token,
          )
        } else {
          await rejectAssignedChangeRequest(eventId, trimmedReason, token)
        }
      } else if (decision === 'approve') {
        await approveAssignedEvent(eventId, token)
      } else {
        await rejectAssignedEvent(eventId, token)
      }
      setRejectionReason('')
      await reloadEvent()
    } catch (caught) {
      setDecisionError(caught.message)
      // 409: someone else already decided, or a request is still open.
      // Reload so the page shows the current state instead of buttons that
      // will keep failing.
      if (caught.status === 409) {
        try {
          await reloadEvent()
        } catch {
          // Keep the decision error on screen; the page can be refreshed.
        }
      }
    } finally {
      setDeciding(false)
    }
  }



  // T7-282. The database returns the bare row, so keep the venue and
  // session names already on screen.
  async function cancelBooking(booking, reason) {
    const data = await cancelVenueBooking(booking.booking_id, reason, token)
    setVenueBookings((current) => current.map((item) => (
      item.booking_id === booking.booking_id
        ? { ...item, ...data.booking, venues: item.venues, session: item.session }
        : item
    )))
  }

  async function cancelRequest(request, reason) {
    const data = await cancelEquipmentRequest(request.id, reason, token)
    setEquipmentRequests((current) => current.map((item) => (
      item.id === request.id
        ? { ...item, ...data.request, event: item.event, session: item.session, items: item.items, equipment_bookings: [] }
        : item
    )))
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
          <Link to="/dashboard">← Back</Link>
        </div>
      </AppShell>
    )
  }


  const pendingBookingsToCancel = pendingBookingsAffectedBy(event, venueBookings)
  const blocker = forwardBlocker(event, 'coordinator')
  const pendingChange = event.change_request?.status === 'pending' ? event.change_request : null
  // A change to sessions alone has no event details to compare.
  const changedFields = pendingChange
    ? CHANGE_FIELDS.filter(({ key }) => normalizedValue(key, event[key])
      !== normalizedValue(key, pendingChange[key]))
    : []
  const pendingCancellation = event.cancellation_request?.status === 'pending'
    ? event.cancellation_request
    : null
  const openClarification = clarifications.find((item) => item.status === 'pending')
  // Questions can be asked at any active stage, one at a time, and not while
  // a cancellation is waiting for review.
  const canAskClarification = ACTIVE_STATUSES.includes(event.status)
    && !event.has_open_clarification && !pendingCancellation

  const shownVenueBookings = visibleVenueBookings(event, venueBookings)
  const safetyChecklist = safetyCheckChecklist(event, venueBookings, equipmentRequests)
  // Each session has one equipment request, so hide the link once every
  // session has one (or while we can't tell because loading them failed).
  const canRequestEquipment = !equipmentRequestError
    && sessionsWithoutEquipmentRequest(event, equipmentRequests).length > 0
  // A cancelled request no longer belongs to its session, which can
  // request again; it is listed separately (T7-282).
  const equipmentRequestFor = (sessionId) => (
    equipmentRequests.find((request) => request.session_id === sessionId
      && request.status !== 'Cancelled')
  )
  const cancelledRequests = equipmentRequests.filter((request) => request.status === 'Cancelled')
  // Requests made before sessions existed are for the whole event.
  const eventLevelRequests = equipmentRequests.filter((request) => !request.session_id
    && request.status !== 'Cancelled')
  const sessionName = (sessionId) => (
    sessionsOf(event).find((session) => session.id === sessionId)?.name || 'Whole event'
  )
  const equipmentCancelAction = (request) => canCancelEquipmentRequest(event, request) && (
    <CancelArrangementForm
      label="Cancel equipment request"
      confirmMessage="Cancel this equipment request? Any equipment reserved for it will be released."
      onCancel={(reason) => cancelRequest(request, reason)}
    />
  )

  return (
    <AppShell>
      <div className="content">
        <Link to="/dashboard" className="backlink">
          ← Back
        </Link>

        <header className="record-head">
          <h1 className="record-head__title">{event.name}</h1>
          <p className="record-head__meta">
            {categoryLabel(event.category, event.category_other)}
            <span className="record-head__dot" aria-hidden="true">·</span>
            {formatDateRange(event.start_time, event.end_time)}
            <span className="record-head__dot" aria-hidden="true">·</span>
            {formatSessionSummary(event)}
          </p>

        </header>

        <EventStatusPanel event={event} role="coordinator" />

        {venueError && <p role="alert">Unable to load venue arrangements. Please refresh and try again.</p>}
        {/* Venues are requested only after the request is approved: an
            Under review event can be held by Venue Staff but not booked. */}
        {hasActiveHold && event.status === 'confirmed' && (
          <div className="form-actions">
            <Link to={`/venues/search?eventId=${encodeURIComponent(eventId)}`} className="button">
              Find / Request Venue
            </Link>
          </div>
        )}
        {event.status === 'planning' && (
          <div className="stack stack--tight">
            {['CHANGES_REQUESTED', 'REJECTED'].includes(safetyDecision?.decision) && (
              <div className="notice" role="status">
                <p>
                  <strong>
                    {safetyDecision.decision === 'REJECTED'
                      ? 'Safety check rejected'
                      : 'Safety Officer requested changes'}
                  </strong>
                  {safetyDecision.created_at && <> on {formatDateTime(safetyDecision.created_at)}</>}.
                  {safetyDecision.decision === 'REJECTED'
                    && ' Venue and equipment reservations were released.'}
                </p>
                {safetyDecision.reason && <p>Reason: {safetyDecision.reason}</p>}
                <p>Update the arrangements, then request the safety check again.</p>
              </div>
            )}
            <div className="form-actions">
              <Link to={`/venues/search?eventId=${encodeURIComponent(eventId)}`} className="button">
                {venueBookings.length > 0 ? 'Find / Request Additional Venue' : 'Find Venue'}
              </Link>

              {canRequestEquipment && (
                <Link
                  to={`/equipment-requests?eventId=${encodeURIComponent(eventId)}`}
                  className="button button--secondary"
                >
                  Request Equipment
                </Link>
              )}

              <button
                type="button"
                className={safetyChecklist.length === 0 ? 'button' : 'button button--secondary'}
                disabled={submittingSafety || safetyChecklist.length > 0 || Boolean(blocker)}
                onClick={async () => {
                  setSubmittingSafety(true)
                  setSafetyError('')
                  try {
                    await requestSafetyCheck(eventId, token)
                    setEvent((prev) => ({
                      ...prev,
                      status: 'awaiting_safety_check',
                    }))
                  } catch (err) {
                    setSafetyError(err.message || 'Failed to request safety check')
                  } finally {
                    setSubmittingSafety(false)
                  }
                }}
              >
                {submittingSafety ? 'Requesting...' : 'Request Safety Check'}
              </button>
            </div>

            {blocker && <p className="note">{blocker}</p>}
            {safetyChecklist.length > 0 ? (
              <>
                <p className="note">To request the safety check:</p>
                <ul className="next-steps">
                  {safetyChecklist.map((item) => <li key={item}>{item}</li>)}
                </ul>
              </>
            ) : (
              !blocker && <p className="note">Everything is ready for the safety check.</p>
            )}
            {safetyError && <p className="form-error" role="alert">{safetyError}</p>}
          </div>
        )}


        {/* Open requests and decisions come first: they are what needs doing. */}
        {event.status === 'under_review' && (
          <section className="stack stack--tight">
            <h2 className="section-title">Review decision</h2>
            {decisionError && !pendingChange && !pendingCancellation && (
              <p className="form-error" role="alert">{decisionError}</p>
            )}
            {blocker && <p className="note">{blocker}</p>}
            <div className="form-actions">
              <button
                type="button"
                className="button"
                onClick={() => decide('event', 'approve')}
                disabled={deciding || Boolean(blocker)}
              >
                {deciding ? 'Saving…' : 'Approve'}
              </button>
              <button
                type="button"
                className="button button--secondary"
                onClick={() => decide('event', 'reject')}
                disabled={deciding}
              >
                Reject
              </button>
            </div>
          </section>
        )}

        {pendingCancellation && (
          <section className="stack stack--tight">
            <h2 className="section-title">Review cancellation request</h2>
            <p><strong>Organiser reason:</strong> {pendingCancellation.reason}</p>
            {decisionError && (
              <p className="form-error" role="alert">{decisionError}</p>
            )}
            <label className="field">
              <span>Coordinator decision reason (required)</span>
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
                onClick={() => decide('cancellation', 'approve')}
                disabled={deciding}
              >
                {deciding ? 'Saving…' : 'Approve cancellation'}
              </button>
              <button
                type="button"
                className="button button--secondary"
                onClick={() => decide('cancellation', 'reject')}
                disabled={deciding}
              >
                Reject cancellation
              </button>
            </div>
          </section>
        )}

        {pendingChange && (
          <section className="stack stack--tight">
            <h2 className="section-title">Review proposed changes</h2>
            <p><strong>Reason for change:</strong> {pendingChange.reason_for_change}</p>
            {changedFields.length > 0 && (
              <dl className="answers">
                {changedFields.map(({ key, label }) => (
                  <div className="answer answer--wide" key={key}>
                    <dt>{label}</dt>
                    <dd>
                      {displayChangeValue(key, event[key], event.category_other)}
                      {' → '}
                      {displayChangeValue(
                        key,
                        pendingChange[key],
                        pendingChange.category_other,
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
            <h3>Sessions</h3>
            <ProposedSessionChanges event={event} />
            {decisionError && !pendingCancellation && (
              <p className="form-error" role="alert">{decisionError}</p>
            )}
            {pendingCancellation ? (
              <p className="note">Review the cancellation request first.</p>
            ) : (
              <>
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
                {pendingBookingsToCancel.length > 0 && (
                  <fieldset className="stack stack--tight">
                    <legend>Pending venue bookings for moved or removed sessions</legend>
                    <p className="note">
                      Ticked bookings are cancelled when you approve. Unticked ones stay pending.
                      Approved bookings and equipment for these sessions are kept but marked as
                      affected, so you can cancel and book them again.
                    </p>
                    {pendingBookingsToCancel.map((booking) => (
                      <label key={booking.booking_id} style={{ display: 'block' }}>
                        <input
                          type="checkbox"
                          checked={!keptPendingIds.has(booking.booking_id)}
                          onChange={(change) => setKeptPendingIds((current) => {
                            const next = new Set(current)
                            if (change.target.checked) next.delete(booking.booking_id)
                            else next.add(booking.booking_id)
                            return next
                          })}
                        />
                        {' '}Cancel {booking.venues?.name || 'venue'} for {booking.session?.name || 'its session'}
                        {' '}({formatDateTime(booking.start_at)} – {formatDateTime(booking.end_at)})
                      </label>
                    ))}
                  </fieldset>
                )}
                <div className="form-actions">
                  <button
                    type="button"
                    className="button"
                    onClick={() => decide('change', 'approve')}
                    disabled={deciding}
                  >
                    {deciding ? 'Saving…' : 'Approve and apply changes'}
                  </button>
                  <button
                    type="button"
                    className="button button--secondary"
                    onClick={() => decide('change', 'reject')}
                    disabled={deciding}
                  >
                    Reject change request
                  </button>
                </div>
              </>
            )}
          </section>
        )}

        {openClarification && (
          <section className="stack stack--tight">
            <h2 className="section-title">Your question to the Organiser</h2>
            <article className="notice">
              <p><strong>You · {formatDateTime(openClarification.created_at)}</strong></p>
              <p>{openClarification.coordinator_notes}</p>
              <p className="note">Waiting for the Organiser's reply.</p>
            </article>
          </section>
        )}

        {canAskClarification && (
          <section className="stack stack--tight">
            {!showClarificationForm ? (
              <div className="form-actions">
                <button
                  type="button"
                  className="button button--secondary"
                  onClick={() => setShowClarificationForm(true)}
                >
                  Request Clarification
                </button>
              </div>
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

        {event.status === 'confirmed' && canRequestEquipment && (
          <div className="form-actions">
            <Link
              to={`/equipment-requests?eventId=${encodeURIComponent(eventId)}`}
              className="button button--secondary"
            >
              Request Equipment
            </Link>
          </div>
        )}

        {/* Time, attendance, location, layout and equipment belong to each
            session (T7-277). */}
        <SessionList event={event} />

        {event.status !== 'under_review' && (
        <section className="stack stack--tight">
          <h2 className="section-title">
            Venue Booking Requests ({shownVenueBookings.length})
          </h2>
          {shownVenueBookings.length === 0 ? (
            <p className="note">No venue booking requests have been submitted for this event yet.</p>
          ) : (
            <ul className="stack stack--tight" style={{ listStyle: 'none', paddingLeft: 0, margin: 0 }}>
              {shownVenueBookings.map((booking) => {
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
                      <span className={venueTagClass(booking.status)}>
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
                      {/* Every booking is for a session (T7-278), so one without a
                          session lost it when a change request removed it. */}
                      {(booking.session?.name || !booking.session_id) && (
                        <div>
                          <span className="note" style={{ display: 'block' }}>Session:</span>
                          <span style={{ color: 'var(--ink)' }}>{booking.session?.name || 'Removed session'}</span>
                        </div>
                      )}
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

                    {booking.status === 'AFFECTED_BY_UNAVAILABILITY' && (
                      <p className="form-error" role="status">
                        Originally approved. Venue now unavailable. Please arrange another venue.
                      </p>
                    )}
                    {booking.status === 'AFFECTED_BY_SESSION_CHANGE' && (
                      <p className="form-error" role="status">
                        {booking.session_id
                          ? 'Its session was moved by an approved change request.'
                          : 'Its session was removed by an approved change request.'}
                        {' '}Cancel this booking, then book a venue again if needed.
                      </p>
                    )}
                    {booking.status === 'REJECTED' && booking.rejection_reason && (
                      <div className="form-error" style={{ marginTop: 'var(--space-3)', maxWidth: 'none' }}>
                        <strong>Rejection Reason:</strong> {booking.rejection_reason}
                      </div>
                    )}
                    {booking.status === 'REJECTED' && event.status === 'planning' && (
                      <p className="note" style={{ marginTop: 'var(--space-3)' }}>
                        Use Find Venue above to request another venue for this session.
                      </p>
                    )}
                    {booking.status === 'CANCELLED' && booking.cancellation_reason && (
                      <p className="note" style={{ marginTop: 'var(--space-3)' }}>
                        <strong>Cancellation reason:</strong> {booking.cancellation_reason}
                      </p>
                    )}
                    {canCancelVenueBooking(event, booking) && (
                      <div className="form-actions" style={{ marginTop: 'var(--space-3)' }}>
                        <CancelArrangementForm
                          label="Cancel booking"
                          confirmMessage="Cancel this venue booking? The venue will be released for other events."
                          onCancel={(reason) => cancelBooking(booking, reason)}
                        />
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </section>
        )}

        {(event.status === 'planning' || equipmentRequests.length > 0 || equipmentRequestError) && (
          <section className="stack stack--tight">
            <h2 className="section-title">Equipment requests</h2>
            {equipmentRequestError ? (
              <p className="form-error" role="alert">{equipmentRequestError}</p>
            ) : (
              <>
                <p className="note">One request per session, for the session's own start and end.</p>
                <ul className="stack stack--tight" style={{ listStyle: 'none', paddingLeft: 0, margin: 0 }}>
                  {sessionsOf(event).map((session) => {
                    const request = equipmentRequestFor(session.id)
                    const canRequest = !request && canRequestEquipment
                      && ['planning', 'confirmed'].includes(event.status)
                    return (
                      <li key={session.id}>
                        <EquipmentRequestCard
                          title={session.name}
                          request={request}
                          timing={session}
                          needs={session.equipment_requirements}
                          actions={canRequest ? (
                            <Link
                              to={`/equipment-requests?eventId=${encodeURIComponent(eventId)}&sessionId=${encodeURIComponent(session.id)}`}
                              className="button button--secondary"
                            >
                              Request equipment for this session
                            </Link>
                          ) : request && equipmentCancelAction(request)}
                        />
                      </li>
                    )
                  })}
                  {eventLevelRequests.map((request) => (
                    <li key={request.id}>
                      <EquipmentRequestCard
                        title={request.status === 'Affected by Session Change' ? 'Removed session' : 'Whole event'}
                        request={request}
                        timing={event}
                        actions={equipmentCancelAction(request)}
                      />
                    </li>
                  ))}
                  {cancelledRequests.map((request) => (
                    <li key={request.id}>
                      <EquipmentRequestCard
                        title={`${sessionName(request.session_id)} (cancelled)`}
                        request={request}
                        timing={request.session || event}
                      />
                    </li>
                  ))}
                </ul>
              </>
            )}
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

        {historyError && <p className="note" role="status">{historyError}</p>}

        <section className="stack stack--tight">
          <h2 className="section-title">Request details</h2>
          <dl className="answers">
            <Answer label="Submitted" value={formatDateTime(event.created_at)} />
            <Answer label="Purpose" value={event.purpose} />
            <Answer label="Description" value={event.description} />
            <Answer label="Category" value={categoryLabel(event.category, event.category_other)} />
            <Answer label="Accessibility needs" value={event.accessibility_requirements} />
          </dl>
        </section>

        <RequestHistory clarifications={clarifications} event={event} role="coordinator" />
      </div>
    </AppShell>
  )
}
