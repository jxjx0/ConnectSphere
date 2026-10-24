import { useEffect, useState } from 'react'
import { getAssignedEventRequest, getAssignedEventRequests } from '../api/events'
import { createVenueBooking } from '../api/venues'
import { useAuth } from '../context/AuthContext'
import { preferredLayout } from '../venueSearch'

// A stored timestamp as the date and time inputs want it, in local time.
function localParts(value) {
  const date = new Date(value)
  const pad = (part) => String(part).padStart(2, '0')
  return {
    date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  }
}

// Every venue booking for an event is for one of its sessions (T7-278).
// Pass sessionId when the page has already chosen the session; otherwise
// the Coordinator picks one here, which fills in its times.
export default function BookingForm({ venue, eventId: initialEventId, sessionId: fixedSessionId, initialValues = {}, onClose, onCreated }) {
  const { token } = useAuth()
  const [selectedEventId, setSelectedEventId] = useState(initialEventId || initialValues.eventId || '')
  const [assignedEvents, setAssignedEvents] = useState([])
  const [loadingEvents, setLoadingEvents] = useState(!initialEventId)
  const [selectedSessionId, setSelectedSessionId] = useState(fixedSessionId || '')
  const [eventSessions, setEventSessions] = useState([])

  // Operating hours from venue profile
  const openTime = venue?.operating_hours?.open || ''
  const closeTime = venue?.operating_hours?.close || ''

  const [form, setForm] = useState({
    startDate: initialValues.startDate || '',
    endDate: initialValues.endDate || initialValues.startDate || '',
    startTime: initialValues.startTime || openTime || '',
    endTime: initialValues.endTime || closeTime || '',
    roomLayout: initialValues.layout || (venue?.layouts?.[0]?.name || ''),
  })

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [successMessage, setSuccessMessage] = useState('')

  useEffect(() => {
    if (!initialEventId) {
      getAssignedEventRequests(token)
        .then((data) => {
          const active = (data.events || []).filter((e) =>
            // Venues are requested only once a request is approved.
            ['planning', 'change_requested', 'confirmed'].includes(e.status)
          )
          setAssignedEvents(active)
          if (active.length === 1) setSelectedEventId(active[0].id)
        })
        .catch(() => { })
        .finally(() => setLoadingEvents(false))
    }
  }, [initialEventId, token])

  // Without a session chosen by the page, load the selected event's
  // sessions to choose from.
  useEffect(() => {
    if (fixedSessionId || !selectedEventId) return
    let active = true
    setEventSessions([])
    setSelectedSessionId('')
    getAssignedEventRequest(selectedEventId, token)
      .then((data) => {
        if (!active) return
        const sessions = data.event?.sessions || []
        setEventSessions(sessions)
        if (sessions.length === 1) chooseSession(sessions[0])
      })
      .catch(() => { if (active) setEventSessions([]) })
    return () => { active = false }
  }, [fixedSessionId, selectedEventId, token])

  // Fills in the session's own time, and its preferred layout when this
  // venue offers it. Layout preferences belong to sessions (scope doc 9.1).
  function chooseSession(session) {
    setSelectedSessionId(session.id)
    const layout = preferredLayout(
      session.layout_preference,
      (venue?.layouts || []).map((item) => item.name).filter(Boolean),
    )
    if (layout) setForm((prev) => ({ ...prev, roomLayout: layout }))
    if (!session.start_time || !session.end_time) return
    const start = localParts(session.start_time)
    const end = localParts(session.end_time)
    setForm((prev) => ({
      ...prev,
      startDate: start.date, startTime: start.time,
      endDate: end.date, endTime: end.time,
    }))
  }

  function updateField(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  async function handleSubmit(event) {
    event.preventDefault()
    setError('')
    setSuccessMessage('')

    if (!selectedEventId) {
      setError('An assigned event is required to submit a booking request.')
      return
    }

    if (!selectedSessionId) {
      setError('Choose which session of the event this venue is for.')
      return
    }

    if (openTime && form.startTime < openTime) {
      setError(`Start time cannot be before operating hours opening time (${openTime}).`)
      return
    }

    if (closeTime && form.endTime > closeTime) {
      setError(`End time cannot exceed operating hours closing time (${closeTime}).`)
      return
    }

    setLoading(true)

    const payload = {
      event_id: selectedEventId,
      session_id: selectedSessionId,
      room_layout: form.roomLayout,
      start_at: new Date(`${form.startDate}T${form.startTime}`).toISOString(),
      end_at: new Date(`${form.endDate}T${form.endTime}`).toISOString(),
    }

    try {
      await createVenueBooking(venue.id, payload, token)
      onCreated()
    } catch (err) {
      setError(err.message)
      setLoading(false)
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="booking-modal-title">
      <div className="modal-content stack stack--default">
        <div className="modal-header">
          <h2 id="booking-modal-title">Request Booking: {venue.name}</h2>
          <button type="button" className="button button--secondary button--small" onClick={onClose} disabled={loading}>
            ✕
          </button>
        </div>

        {/* Operating Hours Banner */}
        {openTime && closeTime && (
          <div className="notice notice--info" role="status">
            <p><strong>Operating Hours:</strong> {openTime} – {closeTime}</p>
          </div>
        )}

        {error && <p className="form-error" role="alert">{error}</p>}

        <form className="form stack stack--tight" onSubmit={handleSubmit}>
          <div className="field">
            <label htmlFor="bookingEvent">Assigned Event (Required)</label>
            {initialEventId ? (
              <input
                id="bookingEvent"
                type="text"
                value={initialValues.eventName ? `${initialValues.eventName} (${initialEventId})` : initialEventId}
                readOnly
                style={{ backgroundColor: 'var(--sunken)', cursor: 'not-allowed' }}
              />
            ) : (
              <select
                id="bookingEvent"
                required
                value={selectedEventId}
                onChange={(e) => setSelectedEventId(e.target.value)}
                disabled={loadingEvents || Boolean(successMessage)}
              >
                <option value="">
                  {loadingEvents ? 'Loading assigned events…' : 'Select an assigned event…'}
                </option>
                {assignedEvents.map((evt) => (
                  <option key={evt.id} value={evt.id}>
                    {evt.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="field">
            <label htmlFor="bookingSession">Session (Required)</label>
            {fixedSessionId ? (
              <input
                id="bookingSession"
                type="text"
                value={initialValues.sessionName || fixedSessionId}
                readOnly
                style={{ backgroundColor: 'var(--sunken)', cursor: 'not-allowed' }}
              />
            ) : (
              <select
                id="bookingSession"
                required
                value={selectedSessionId}
                onChange={(e) => {
                  const session = eventSessions.find((item) => item.id === e.target.value)
                  if (session) chooseSession(session)
                  else setSelectedSessionId('')
                }}
                disabled={!selectedEventId || Boolean(successMessage)}
              >
                <option value="">
                  {selectedEventId ? 'Select a session…' : 'Select an event first'}
                </option>
                {eventSessions.map((session) => (
                  <option key={session.id} value={session.id}>
                    {session.name}
                  </option>
                ))}
              </select>
            )}
            <p className="field__hint">
              The booking must cover the whole session; setup and turnaround are added automatically.
            </p>
          </div>

          <div className="field-group" style={{ display: 'flex', gap: '1rem' }}>
            <div className="field" style={{ flex: 1 }}>
              <label htmlFor="startDate">Start Date</label>
              <input
                id="startDate"
                type="date"
                required
                disabled={Boolean(successMessage)}
                value={form.startDate}
                onChange={(e) => setForm({
                  ...form,
                  startDate: e.target.value,
                  endDate: form.endDate && form.endDate >= e.target.value ? form.endDate : e.target.value
                })}
              />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label htmlFor="endDate">End Date</label>
              <input
                id="endDate"
                type="date"
                min={form.startDate}
                value={form.endDate}
                disabled={Boolean(successMessage)}
                onChange={(e) => setForm({ ...form, endDate: e.target.value })}
                required
              />
            </div>
          </div>

          <div className="field-group" style={{ display: 'flex', gap: '1rem' }}>
            <div className="field" style={{ flex: 1 }}>
              <label htmlFor="bookingStart">Start Time</label>
              <input
                id="bookingStart"
                type="time"
                required
                min={openTime || undefined}
                max={closeTime || undefined}
                disabled={Boolean(successMessage)}
                value={form.startTime}
                onChange={(e) => updateField('startTime', e.target.value)}
              />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label htmlFor="bookingEnd">End Time</label>
              <input
                id="bookingEnd"
                type="time"
                required
                min={openTime || undefined}
                max={closeTime || undefined}
                disabled={Boolean(successMessage)}
                value={form.endTime}
                onChange={(e) => updateField('endTime', e.target.value)}
              />
            </div>
          </div>

          <div className="field">
            <label htmlFor="roomLayout">Room Layout</label>
            <select
              id="roomLayout"
              required
              disabled={Boolean(successMessage)}
              value={form.roomLayout}
              onChange={(e) => updateField('roomLayout', e.target.value)}
            >
              <option value="">Select a layout</option>
              {venue.layouts?.map((layout) => (
                <option key={layout.name} value={layout.name}>
                  {layout.name} (Cap: {layout.capacity})
                </option>
              ))}
            </select>
          </div>

          <div className="form-actions" style={{ marginTop: '1rem' }}>
            <button type="submit" className="button button--primary" disabled={loading || Boolean(successMessage)}>
              {loading ? 'Submitting Request…' : 'Submit Request'}
            </button>
            <button type="button" className="button button--secondary" onClick={onClose} disabled={loading}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
