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

} from '../api/events'
import AppShell from '../components/AppShell'
import CancelArrangementForm from '../components/CancelArrangementForm'
import EquipmentRequestCard from '../components/EquipmentRequestCard'
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
import { sessionsWithoutEquipmentRequest } from '../equipmentRequestEligibility'
import { sessionChanges, sessionsNeedingRebooking } from '../changeRequestSessions'

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
      if (reviewingChange && decision === 'approve') {
        await approveAssignedChangeRequest(
          eventId,
          pendingBookingsAffectedBy(event, venueBookings)
            .filter((booking) => !keptPendingIds.has(booking.booking_id))
            .map((booking) => booking.booking_id),
          token,
        )
        // Sessions, bookings and equipment may all have changed, so load
        // them again rather than patching the page.
        const [data, bookingData, requestData] = await Promise.all([
          getAssignedEventRequest(eventId, token),
          getVenueBookingsForEvent(eventId, token),
          getEventEquipmentRequests(eventId, token),
        ])
        setEvent(data.event)
        setVenueBookings(bookingData.bookings || [])
        setEquipmentRequests(requestData.requests || [])
      } else if (reviewingChange) {
        const data = await rejectAssignedChangeRequest(eventId, rejectionReason.trim(), token)
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
          <Link to="/dashboard">Back to dashboard</Link>
        </div>
      </AppShell>
    )
  }


  const pendingBookingsToCancel = pendingBookingsAffectedBy(event, venueBookings)

  const liveVenueStatuses = venueBookings
    .map((booking) => (booking.status || '').toUpperCase())
    .filter((status) => !['CANCELLED', 'REJECTED', 'REJECTED_BY_SAFETY'].includes(status))
  const hasApprovedVenue =
    liveVenueStatuses.length > 0 && liveVenueStatuses.every((status) => status === 'APPROVED')
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
          ← Dashboard
        </Link>

        <header className="record-head">
          <h1 className="record-head__title">{event.name}</h1>
          <p className="record-head__meta">
            {categoryLabel(event.category, event.category_other)}
            <span className="record-head__dot" aria-hidden="true">·</span>
            {formatDateRange(event.start_time, event.end_time)}
            <span className="record-head__dot" aria-hidden="true">·</span>
            {formatSessionSummary(event)}
            <span className="record-head__dot" aria-hidden="true">·</span>
            <span className="tag">{readableStatus(event.status)}</span>
          </p>

          {venueError && <p role="alert">Unable to load venue arrangements. Please refresh and try again.</p>}
          {/* Venues are requested only after the request is approved: an
              Under review event can be held by Venue Staff but not booked. */}
          {hasActiveHold && ['change_requested', 'confirmed'].includes(event.status) && (
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
                  className="button button--secondary"
                  disabled={submittingSafety || !hasApprovedVenue}
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

              {!hasApprovedVenue && (
                <p className="note">
                  A safety check can be requested once every session has an approved venue booking (rejected or cancelled ones don't count), every session that needs equipment has an equipment request, and no equipment request is still pending.
                </p>
              )}
              {safetyError && <p className="form-error" role="alert">{safetyError}</p>}
            </div>
          )}

          {event.status === 'awaiting_safety_check' && (
            <div className="stack stack--tight">
              <span className="tag tag--orange">Safety Review Pending</span>
              <p className="note">Waiting for the Safety Officer's review.</p>
            </div>
          )}
        </header>

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

        {event.status !== 'under_review' && (
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
            <Answer label="Accessibility needs" value={event.accessibility_requirements} />
          </dl>
        </section>

        {/* Time, attendance, location, layout and equipment belong to each
            session (T7-277). */}
        <SessionList event={event} />

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
            <h3>Sessions</h3>
            <ProposedSessionChanges event={event} />
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
