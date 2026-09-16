import { useState } from 'react'

import { useAuth } from '../context/AuthContext'
import { createVenueBlock } from '../api/venues'


// Creates a Section for blocking form
export default function BlockForm({ venue, onClose }) {
  const { token } = useAuth()

  const [startDate, setStartDate] = useState('')
  const [startTime, setStartTime] = useState('')
  const [endDate, setEndDate] = useState('')
  const [endTime, setEndTime] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(event) {
    event.preventDefault()
    setError('')

    const startAt = `${startDate}T${startTime}`
    const endAt = `${endDate}T${endTime}`

    setSubmitting(true)

    try {
      await createVenueBlock(
        venue.id,
        {
          start_at: startAt,
          end_at: endAt,
          block_reason: reason,
        },
        token
      )

      onClose()
    } catch (error) {
      setError(error.message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className="form">
      <form className="stack stack--tight" onSubmit={handleSubmit}>
        <h2 className="section-title">Block venue</h2>

        <p className="field__hint">
          Specify when and why this venue should be blocked.
        </p>

        <div className="field">
          <label>Venue ID</label>
          <input value={venue.id} disabled />
        </div>

        <div className="field">
          <label>Venue name</label>
          <input value={venue.name} disabled />
        </div>

        <div className="field">
          <label>Blocked period</label>

          <div className="repeater__row repeater__row--equal">
            <div className="repeater__field">
              <label htmlFor="blockStartDate">Start date</label>
              <input
                id="blockStartDate"
                type="date"
                value={startDate}
                onChange={(event) => setStartDate(event.target.value)}
                required
              />
            </div>

            <div className="repeater__field">
              <label htmlFor="blockStartTime">Start time</label>
              <input
                id="blockStartTime"
                type="time"
                value={startTime}
                onChange={(event) => setStartTime(event.target.value)}
                required
              />
            </div>
          </div>

          <div className="repeater__row repeater__row--equal">
            <div className="repeater__field">
              <label htmlFor="blockEndDate">End date</label>
              <input
                id="blockEndDate"
                type="date"
                value={endDate}
                onChange={(event) => setEndDate(event.target.value)}
                required
              />
            </div>

            <div className="repeater__field">
              <label htmlFor="blockEndTime">End time</label>
              <input
                id="blockEndTime"
                type="time"
                value={endTime}
                onChange={(event) => setEndTime(event.target.value)}
                required
              />
            </div>
          </div>
        </div>

        <div className="field">
          <label htmlFor="blockReason">Reason</label>
          <input
            id="blockReason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Enter reason for blocking this venue"
            required
          />
        </div>

        {error && (
          <p className="field__error">
            {error}
          </p>
        )}

        <div className="form-actions">
          <button
            type="submit"
            className="button"
            disabled={submitting}
          >
            {submitting ? 'Submitting...' : 'Submit'}
          </button>

          <button
            type="button"
            className="button button--secondary"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </button>
        </div>
      </form>
    </section>
  )
}
