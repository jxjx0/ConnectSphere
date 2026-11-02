import React, { useEffect, useState } from 'react'
import { useParams, Link, useNavigate, useSearchParams } from 'react-router-dom'
import { getSafetyEventDetails, submitSafetyDecision } from '../api/events'
import AppShell from '../components/AppShell'
import { safetyTabFrom } from '../components/SafetyTabs'
import { useAuth } from '../context/AuthContext'
import { categoryLabel } from '../eventCategories'
import {
  formatDateRange,
  formatDateTime,
  formatSessionSummary,
  optional,
  sessionsOf,
} from '../eventDisplay'
import { statusLabel } from '../eventStatus'
import SessionList from '../components/SessionList'

function Answer({ label, value }) {
  return (
    <div className="answer">
      <dt>{label}</dt>
      <dd data-empty={!value}>{optional(value)}</dd>
    </div>
  )
}

// The venue actually booked for a session: what the Safety Officer checks
// capacity, layout, access and hours against.
function BookedVenue({ booking }) {
  const venue = booking.venue || {}
  const layouts = Array.isArray(venue.layouts) ? venue.layouts : []
  const layout = layouts.find((item) =>
    item.name?.toLowerCase() === booking.room_layout?.toLowerCase())
  const rows = [
    ['Venue', venue.name],
    ['Location', venue.location],
    ['Capacity', venue.capacity ? `${venue.capacity} people` : ''],
    ['Layout', booking.room_layout
      ? `${booking.room_layout}${layout?.capacity ? ` (up to ${layout.capacity})` : ''}`
      : ''],
    ['Accessibility', formatList(venue.accessibility)],
    ['Facilities', formatList(venue.facilities)],
    ['Hours', formatOperatingHours(venue.operating_hours)],
  ]
  return (
    <dl className="detail-list detail-list--compact">
      {rows.map(([label, value]) => (
        <div className="detail-list__row" key={label}>
          <dt>{label}</dt>
          <dd>{optional(value)}</dd>
        </div>
      ))}
    </dl>
  )
}

// Helper to format arrays or JSON strings into human-readable comma-separated lists
function formatList(val) {
  if (!val) return 'None'
  if (Array.isArray(val)) return val.length > 0 ? val.join(', ') : 'None'
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val)
      if (Array.isArray(parsed)) return parsed.length > 0 ? parsed.join(', ') : 'None'
    } catch {
      return val
    }
  }
  return String(val)
}

// Helper to format operating hours objects/JSON strings into readable time ranges
function formatOperatingHours(val) {
  if (!val) return 'N/A'
  let hoursObj = val
  if (typeof val === 'string') {
    try {
      hoursObj = JSON.parse(val)
    } catch {
      return val
    }
  }
  if (typeof hoursObj === 'object' && hoursObj !== null) {
    const open = hoursObj.open || hoursObj.start || ''
    const close = hoursObj.close || hoursObj.end || ''
    if (open && close) return `${open} – ${close}`
  }
  return String(val)
}

// Approved equipment items, one row each: name, type, quantity and
// whether the item is in working order.
function EquipmentItems({ items }) {
  if (items.length === 0) {
    return <p className="note">No approved equipment for this session.</p>
  }
  return (
    <dl className="detail-list detail-list--compact">
      {items.map((item, index) => (
        <div className="detail-list__row" key={`${item.request_id}-${index}`}>
          <dt>{item.equipment?.name || 'Equipment'} × {item.quantity}</dt>
          <dd>
            {item.equipment?.type || 'General'}
            {' · '}
            {item.equipment?.maintenance_status || 'Unknown condition'}
          </dd>
        </div>
      ))}
    </dl>
  )
}

export default function SafetyReviewDetailPage() {
  const { eventId } = useParams()
  const { token } = useAuth()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  // Back returns to the list this event was opened from.
  const fromTab = safetyTabFrom(searchParams.get('from'))
  const backTo = fromTab === 'to-review' ? '/safetyreview' : `/safetyreview?tab=${fromTab}`

  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Safety Officer Action States
  const [activeAction, setActiveAction] = useState(null) // null | 'APPROVED' | 'CHANGES' | 'REJECTED'
  const [notes, setNotes] = useState('')
  const [reason, setReason] = useState('')
  const [actionError, setActionError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!eventId || !token) return

    getSafetyEventDetails(eventId, token)
      .then((res) => setData(res))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [eventId, token])

  const handleDecisionSubmit = async (e, decisionType) => {
    e.preventDefault()
    setActionError('')

    if ((decisionType === 'rejected' || decisionType === 'changes_requested') && !reason.trim()) {
      setActionError(`Please provide a detailed reason when taking this action.`)
      return
    }

    setSubmitting(true)
    try {
      await submitSafetyDecision(
        eventId,
        {
          decision: decisionType,
          notes: notes.trim(),
          reason: reason.trim() || undefined,
        },
        token
      )
      navigate('/safetyreview')
    } catch (err) {
      setActionError(err.message || 'Failed to record decision.')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <AppShell>
        <p className="page-state">Loading safety assessment details…</p>
      </AppShell>
    )
  }

  if (error) {
    return (
      <AppShell>
        <div className="page-state">
          <p className="form-error">{error}</p>
          <Link to={backTo} className="backlink">← Back</Link>
        </div>
      </AppShell>
    )
  }

  if (!data || !data.event) {
    return (
      <AppShell>
        <div className="page-state">
          <p>No event details found.</p>
          <Link to={backTo} className="backlink">← Back</Link>
        </div>
      </AppShell>
    )
  }

  const { event, venue_bookings = [], equipment_items = [], safety_flags = [] } = data
  const awaitingDecision = event.status === 'awaiting_safety_check'
  // Each approved venue belongs to one session (T7-278). An event from
  // before sessions has a single stand-in session that gets every booking;
  // a booking with no matching session is listed separately.
  const hasSessions = Boolean(event.sessions?.length)
  const sessionIds = new Set(sessionsOf(event).map((session) => session.id))
  const bookingsFor = (session) => venue_bookings.filter(
    (booking) => !hasSessions || booking.session_id === session.id,
  )
  const unlinkedBookings = hasSessions
    ? venue_bookings.filter((booking) => !sessionIds.has(booking.session_id))
    : []
  // Approved equipment is grouped the same way: each request is for one
  // session (T7-279).
  const equipmentFor = (session) => equipment_items.filter(
    (item) => !hasSessions || item.session_id === session.id,
  )
  const unlinkedEquipment = hasSessions
    ? equipment_items.filter((item) => !sessionIds.has(item.session_id))
    : []

  return (
    <AppShell>
      <div className="content">
        <Link to={backTo} className="backlink">← Back</Link>

        <header className="record-head">
          <h1 className="record-head__title">{event.name}</h1>
          <p className="record-head__meta">
            {categoryLabel(event.category, event.category_other)}
            <span className="record-head__dot" aria-hidden="true">·</span>
            {formatDateRange(event.start_time, event.end_time)}
            <span className="record-head__dot" aria-hidden="true">·</span>
            {formatSessionSummary(event)}
            <span className="record-head__dot" aria-hidden="true">·</span>
            <span className={awaitingDecision ? 'tag tag--warning' : 'tag'}>
              {awaitingDecision ? 'Waiting for your check' : statusLabel(event.status)}
            </span>
          </p>
        </header>

        {/* Safety Concerns & Clashes Warning Box */}
        {safety_flags && safety_flags.length > 0 && (
          <section className="notice notice--warning stack stack--tight">
            <h2 className="section-title">⚠️ Safety Concerns & Clashes Detected</h2>
            {safety_flags.map((flag, idx) => (
              <p key={idx} className="form-error" style={{ maxWidth: 'none', margin: 0 }}>
                <strong>[{flag.type}]</strong> {flag.message}
              </p>
            ))}
          </section>
        )}

        {/* Event Overview Section */}
        <section className="stack stack--tight">
          <h2 className="section-title">Event Overview</h2>
          <dl className="answers">
            <Answer label="Description" value={event.description} />
            <Answer label="Purpose" value={event.purpose} />
            <Answer
              label="Date & Time"
              value={`${formatDateTime(event.start_time)} – ${formatDateTime(event.end_time)}`}
            />
            <Answer
              label="Sessions and attendance"
              value={formatSessionSummary(event)}
            />
            <Answer
              label="Coordinator in Charge"
              value={event.coordinator?.full_name || 'Unassigned'}
            />
            <Answer
              label="Contact Number"
              value={event.coordinator?.contact_number}
            />
          </dl>
        </section>

        {/* One card per session: what the Organiser asked for, then the venue
            actually booked for it, which is what the safety check is about. */}
        <SessionList
          event={event}
          title="Sessions and what is booked"
          note="Each session shows what the Organiser asked for, then the venue and equipment booked for it."
          extra={(session) => (
            <>
              <h4 className="session-card__label">Booked venue</h4>
              {bookingsFor(session).length === 0
                ? <p className="note">No approved venue for this session.</p>
                : bookingsFor(session).map((booking) => (
                  <BookedVenue key={booking.booking_id} booking={booking} />
                ))}
              <h4 className="session-card__label">Approved equipment</h4>
              <EquipmentItems items={equipmentFor(session)} />
            </>
          )}
        />

        {unlinkedBookings.length > 0 && (
          <section className="stack stack--tight">
            <h2 className="section-title">Other booked venues</h2>
            <p className="note">Approved venues not linked to a session.</p>
            {unlinkedBookings.map((booking) => (
              <BookedVenue key={booking.booking_id} booking={booking} />
            ))}
          </section>
        )}

        {unlinkedEquipment.length > 0 && (
          <section className="stack stack--tight">
            <h2 className="section-title">Other approved equipment</h2>
            <p className="note">Equipment requested for the whole event, not one session.</p>
            <EquipmentItems items={unlinkedEquipment} />
          </section>
        )}

        {/* Safety Assessment & Decision Form Section */}
        {!awaitingDecision ? (
          <p className="note">
            This event is no longer waiting for a safety check, so no decision is needed.
          </p>
        ) : (
        <section className="stack stack--tight" style={{ marginTop: 'var(--space-6)' }}>
          <h2 className="section-title">Safety Officer Decision</h2>

          {actionError && <p className="form-error" role="alert">{actionError}</p>}

          {!activeAction ? (
            <div className="form-actions">
              <button
                type="button"
                className="button"
                onClick={() => {
                  setActiveAction('APPROVED')
                  setActionError('')
                }}
              >
                Approve Event
              </button>
              <button
                type="button"
                className="button button--secondary"
                onClick={() => {
                  setActiveAction('CHANGES')
                  setActionError('')
                }}
              >
                Request Changes
              </button>
              <button
                type="button"
                className="button button--secondary"
                style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}
                onClick={() => {
                  setActiveAction('REJECTED')
                  setActionError('')
                }}
              >
                Reject Event
              </button>
            </div>
          ) : (
            <form
              onSubmit={(e) => {
                const decisionType =
                  activeAction === 'APPROVED'
                    ? 'approved'
                    : activeAction === 'CHANGES'
                    ? 'changes_requested'
                    : 'rejected'
                handleDecisionSubmit(e, decisionType)
              }}
              className="stack stack--tight"
              style={{
                border: '1px solid var(--rule)',
                borderRadius: 'var(--radius)',
                padding: 'var(--space-4)',
                backgroundColor: 'var(--surface)',
              }}
            >
              <h3 style={{ fontSize: '1rem', margin: 0 }}>
                {activeAction === 'APPROVED' && 'Approve Operational Safety Check'}
                {activeAction === 'CHANGES' && 'Request Safety Changes'}
                {activeAction === 'REJECTED' && 'Reject Operational Safety Check'}
              </h3>

              {(activeAction === 'CHANGES' || activeAction === 'REJECTED') && (
                <label className="field">
                  <span className="field__label">
                    {activeAction === 'CHANGES' ? 'Required Safety Changes / Reason' : 'Reason for Rejection'}
                  </span>
                  <textarea
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder={
                      activeAction === 'CHANGES'
                        ? 'Specify necessary adjustments or risk mitigation steps required...'
                        : 'Explain why safety arrangements are unacceptable...'
                    }
                    rows={3}
                    required
                    autoFocus
                  />
                </label>
              )}

              <label className="field">
                <span className="field__label">Internal Safety Notes (Optional)</span>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Notes for records and compliance log..."
                  rows={2}
                />
              </label>

              <div className="form-actions">
                <button
                  type="submit"
                  className="button"
                  style={
                    activeAction === 'REJECTED'
                      ? { backgroundColor: 'var(--danger)', borderColor: 'var(--danger)', color: '#fff' }
                      : undefined
                  }
                  disabled={submitting}
                >
                  {submitting
                    ? 'Submitting…'
                    : activeAction === 'APPROVED'
                    ? 'Confirm Approval'
                    : activeAction === 'CHANGES'
                    ? 'Send Change Request'
                    : 'Confirm Rejection'}
                </button>
                <button
                  type="button"
                  className="button button--secondary"
                  disabled={submitting}
                  onClick={() => {
                    setActiveAction(null)
                    setReason('')
                    setNotes('')
                    setActionError('')
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