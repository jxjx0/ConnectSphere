import { useEffect, useState } from 'react'
import { getAssignedEventRequests } from '../api/events'
import { createVenueBooking } from '../api/venues'
import { useAuth } from '../context/AuthContext'

export default function BookingForm({ venue, eventId: initialEventId, initialValues = {}, onClose, onCreated }) {
  const { token } = useAuth()
  const [selectedEventId, setSelectedEventId] = useState(initialEventId || initialValues.eventId || '')
  const [assignedEvents, setAssignedEvents] = useState([])
  const [loadingEvents, setLoadingEvents] = useState(!initialEventId)

  const [form, setForm] = useState({
    startDate: initialValues.startDate || '',
    endDate: initialValues.endDate || initialValues.startDate || '',
    startTime: initialValues.startTime || '',
    endTime: initialValues.endTime || '',
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
            ['under_review', 'planning', 'change_requested'].includes(e.status)
          )
          setAssignedEvents(active)
          if (active.length === 1) setSelectedEventId(active[0].id)
        })
        .catch(() => { })
        .finally(() => setLoadingEvents(false))
    }
  }, [initialEventId, token])

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

    if (!form.startDate || !form.endDate || !form.startTime || !form.endTime) {
      setError('Please provide start date, end date, start time, and end time.')
      return
    }

    setLoading(true)

    const payload = {
      event_id: selectedEventId,
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

        {successMessage && (
          <div className="notice" style={{ backgroundColor: 'var(--accent-faint)', borderColor: 'var(--accent)', color: 'var(--accent)' }} role="status">
            <p><strong>✓ {successMessage}</strong></p>
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
            {initialEventId && (
              <p className="field__hint">Linked to the active event review context.</p>
            )}
          </div>

          <div className="field">
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

          <div className="field">
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

          <div className="field-group" style={{ display: 'flex', gap: '1rem' }}>
            <div className="field" style={{ flex: 1 }}>
              <label htmlFor="bookingStart">Start Time</label>
              <input
                id="bookingStart"
                type="time"
                required
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
              {loading ? (successMessage ? 'Saved!' : 'Submitting Request…') : 'Submit Request'}
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