import React, { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { getSafetyEventDetails } from '../api/events'
import AppShell from '../components/AppShell'
import { useAuth } from '../context/AuthContext'
import { categoryLabel } from '../eventCategories'
import { formatDateRange, formatDateTime, optional } from '../eventDisplay'

function Answer({ label, value }) {
  return (
    <div className="answer">
      <dt>{label}</dt>
      <dd data-empty={!value}>{optional(value)}</dd>
    </div>
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

export default function SafetyReviewDetailPage() {
  const { eventId } = useParams()
  const { token } = useAuth()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!eventId || !token) return

    getSafetyEventDetails(eventId, token)
      .then((res) => setData(res))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [eventId, token])

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
          <Link to="/safetyreview" className="backlink">
            ← Back to Safety Queue
          </Link>
        </div>
      </AppShell>
    )
  }

  if (!data || !data.event) {
    return (
      <AppShell>
        <div className="page-state">
          <p>No event details found.</p>
          <Link to="/safetyreview" className="backlink">
            ← Back to Safety Queue
          </Link>
        </div>
      </AppShell>
    )
  }

  const { event, venue_booking = {}, venue = {}, equipment_items = [], safety_flags = [] } = data

  return (
    <AppShell>
      <div className="content">
        <Link to="/safetyreview" className="backlink">
          ← Back to Safety Queue
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
            <span className="tag tag--orange">Safety Review Pending</span>
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
              label="Expected Attendance"
              value={event.expected_attendance ? `${event.expected_attendance} people` : ''}
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

        {/* Venue Profile & Requested Layout Section */}
        <section className="stack stack--tight">
          <h2 className="section-title">Venue Profile & Requested Layout</h2>
          <dl className="answers">
            <Answer label="Venue Name" value={venue.name || 'No Venue Assigned'} />
            <Answer label="Location" value={venue.location} />
            <Answer label="Capacity Limit" value={venue.capacity ? `${venue.capacity} people` : ''} />
            <Answer
              label="Requested Room Layout"
              value={venue_booking.room_layout || event.layout_preference}
            />
            <Answer
              label="Accessibility Features"
              value={formatList(venue.accessibility || event.accessibility_requirements)}
            />
            <Answer
              label="Facilities Available"
              value={formatList(venue.facilities)}
            />
            <Answer
              label="Operating Hours"
              value={formatOperatingHours(venue.operating_hours)}
            />
          </dl>
        </section>

        {/* Equipment Booked Section */}
        <section className="stack stack--tight">
          <h2 className="section-title">Equipment Booked</h2>
          {equipment_items.length === 0 ? (
            <p className="note">
              No specific technical equipment requested ({optional(event.equipment_requirements)}).
            </p>
          ) : (
            <ul className="stack stack--tight" style={{ listStyle: 'none', paddingLeft: 0, margin: 0 }}>
              {equipment_items.map((item, idx) => (
                <li
                  key={idx}
                  style={{
                    border: '1px solid var(--rule)',
                    borderRadius: 'var(--radius)',
                    padding: 'var(--space-3) var(--space-4)',
                    backgroundColor: 'var(--surface)',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <strong style={{ color: 'var(--ink)' }}>
                      {item.equipment?.name || 'Equipment'} ({item.equipment?.type || 'General'})
                    </strong>
                    <span className="tag">
                      Status: {item.equipment?.maintenance_status || 'Active'}
                    </span>
                  </div>
                  <p className="note" style={{ marginTop: '0.25rem' }}>
                    Quantity requested: <strong>{item.quantity}</strong>
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </AppShell>
  )
}