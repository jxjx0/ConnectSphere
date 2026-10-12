import { useState } from 'react'
import { createVenueBooking } from '../api/venues'
import { useAuth } from '../context/AuthContext'

export default function BookingForm({ venue, eventId, initialValues = {}, onClose, onCreated }) {
  const { token } = useAuth()
  const [form, setForm] = useState({
    date: initialValues.date || '',
    startTime: initialValues.startTime || '',
    endTime: initialValues.endTime || '',
    roomLayout: initialValues.layout || (venue?.layouts?.[0]?.name || ''),
    setupBufferMinutes: 0,
    teardownBufferMinutes: 0,
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  function updateField(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  async function handleSubmit(event) {
    event.preventDefault()
    setError('')

    if (!form.date || !form.startTime || !form.endTime) {
      setError('Please provide date, start time, and end time.')
      return
    }

    setLoading(true)

    // Build ISO timestamp strings with timezone offset
    const startAt = new Date(`${form.date}T${form.startTime}`).toISOString()
    const endAt = new Date(`${form.date}T${form.endTime}`).toISOString()

    const payload = {
      event_id: eventId || null,
      room_layout: form.roomLayout,
      start_at: startAt,
      end_at: endAt,
      setup_buffer_minutes: Number(form.setupBufferMinutes) || 0,
      teardown_buffer_minutes: Number(form.teardownBufferMinutes) || 0,
    }

    try {
      await createVenueBooking(venue.id, payload, token)
      onCreated()
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="booking-modal-title">
      <div className="modal-content stack stack--default">
        <div className="modal-header">
          <h2 id="booking-modal-title">Request Booking: {venue.name}</h2>
          <button type="button" className="button button--secondary button--small" onClick={onClose}>
            ✕
          </button>
        </div>

        {error && <p className="form-error" role="alert">{error}</p>}

        <form className="form stack stack--tight" onSubmit={handleSubmit}>
          <div className="field">
            <label htmlFor="bookingDate">Date</label>
            <input
              id="bookingDate"
              type="date"
              required
              value={form.date}
              onChange={(e) => updateField('date', e.target.value)}
            />
          </div>

          <div className="field-group" style={{ display: 'flex', gap: '1rem' }}>
            <div className="field" style={{ flex: 1 }}>
              <label htmlFor="bookingStart">Start Time</label>
              <input
                id="bookingStart"
                type="time"
                required
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

          <div className="field-group" style={{ display: 'flex', gap: '1rem' }}>
            <div className="field" style={{ flex: 1 }}>
              <label htmlFor="setupBuffer">Setup Buffer (mins)</label>
              <input
                id="setupBuffer"
                type="number"
                min="0"
                step="5"
                value={form.setupBufferMinutes}
                onChange={(e) => updateField('setupBufferMinutes', e.target.value)}
              />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label htmlFor="teardownBuffer">Teardown Buffer (mins)</label>
              <input
                id="teardownBuffer"
                type="number"
                min="0"
                step="5"
                value={form.teardownBufferMinutes}
                onChange={(e) => updateField('teardownBufferMinutes', e.target.value)}
              />
            </div>
          </div>

          <div className="form-actions" style={{ marginTop: '1rem' }}>
            <button type="submit" className="button button--primary" disabled={loading}>
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