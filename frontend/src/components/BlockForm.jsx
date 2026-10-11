import { useEffect, useRef, useState } from 'react'

import { useAuth } from '../context/AuthContext'
import { createVenueBlock } from '../api/venues'
import { venueBlockPayload } from '../venueBlock.js'
import { formatDateRange } from '../eventDisplay.js'


export default function BlockForm({ venue, onClose, onCreated }) {
  const { token } = useAuth()
  const dialogRef = useRef(null)

  useEffect(() => {
    const dialog = dialogRef.current
    const trigger = dialog.ownerDocument.activeElement
    dialog.showModal()
    return () => {
      dialog.close()
      trigger?.focus()
    }
  }, [])

  function renderModal(children) {
    return (
      <dialog ref={dialogRef} className="venue-block-dialog" aria-labelledby="blockVenueTitle" onCancel={onClose}>
        {children}
      </dialog>
    )
  }

  const [startDate, setStartDate] = useState('')
  const [startTime, setStartTime] = useState('')
  const [endDate, setEndDate] = useState('')
  const [endTime, setEndTime] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [outcome, setOutcome] = useState(null)

  async function handleSubmit(event) {
    event.preventDefault()
    setError('')

    setSubmitting(true)

    try {
      const payload = venueBlockPayload({ startDate, startTime, endDate, endTime, reason })
      const data = await createVenueBlock(
        venue.id,
        payload,
        token
      )
      if (!data?.block) throw new Error('Block creation could not be confirmed. Check before submitting again.')
      setOutcome({ ...data, block: { ...payload, ...data.block } })
      onCreated?.()
    } catch (error) {
      setError(error.message)
    } finally {
      setSubmitting(false)
    }
  }

  if (outcome) {
    const impact = outcome.booking_impact
    const verified = impact?.status === 'verified' && Array.isArray(impact.affected_bookings)
    const affected = verified ? impact.affected_bookings : []
    const sameDay = new Date(outcome.block.start_at).toDateString() === new Date(outcome.block.end_at).toDateString()
    const period = formatDateRange(outcome.block.start_at, outcome.block.end_at)
    const periodLines = period.split(sameDay ? ', ' : ' – ')
    return renderModal(
      <section className="form stack stack--tight">
        <h2 className="venue-block-dialog__title" id="blockVenueTitle" tabIndex={-1} autoFocus>Block Venue</h2>
        <p role="status">Block created successfully.</p>
        <div>
          <h3 className="venue-block-dialog__venue">{venue.name}</h3>
          <p className="record-head__meta">
            {periodLines.map((line, index) => <span className="venue-block-dialog__period-line" key={index}>
              {!sameDay && index > 0 ? '→ ' : ''}{line}
            </span>)}
          </p>
        </div>
        <div className="stack stack--tight">
          <h3 className="note">Reason</h3>
          <p className="venue-block-dialog__reason">{outcome.block.block_reason}</p>
        </div>
        {/* TODO: Revisit impact presentation once real booking reads and venue buffers are integrated. */}
        {verified && <section className="progress venue-block-dialog__impact">
          <h3 className="note">Booking impact</h3>
          <p>
            {affected.length === 0
              ? 'No existing bookings are affected.'
              : `${affected.length} existing booking${affected.length === 1 ? '' : 's'} affected.`}
          </p>
              {affected.length > 0 && <ul>{affected.map((booking, index) => (
                <li key={booking.booking_id || index}>{booking.event_name || 'Affected venue booking'}</li>
              ))}</ul>}
        </section>}
        <div className="form-actions">
          <button type="button" className="button button--secondary" onClick={onClose}>Close</button>
        </div>
      </section>
    )
  }

  return renderModal(
    <section className="form">
      <form className="stack stack--tight" onSubmit={handleSubmit}>
        <header className="venue-block-dialog__header">
          <h2 className="venue-block-dialog__title" id="blockVenueTitle">Block Venue</h2>
          <p className="field__hint">
            Specify when and why this venue should be unavailable.
          </p>
        </header>
        <p><strong>Venue:</strong> {venue.name}</p>

        <div className="field">
          <label>Blocked period</label>

          <div className="repeater__row repeater__row--equal">
            <div className="repeater__field">
              <label htmlFor="blockStartDate">Start date</label>
              <input
                id="blockStartDate"
                autoFocus
                type="date"
                disabled={submitting}
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
                disabled={submitting}
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
                disabled={submitting}
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
                disabled={submitting}
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
            disabled={submitting}
            maxLength={500}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Enter reason for blocking this venue"
            required
          />
        </div>

        {error && (
          <p className="field__error" role="alert">
            {error}
          </p>
        )}

        <div className="form-actions">
          <button
            type="submit"
            className="button"
            disabled={submitting}
          >
            {submitting ? 'Submitting...' : 'Block Venue'}
          </button>

          <button
            type="button"
            className="button button--secondary"
            onClick={onClose}
          >
            Cancel
          </button>
        </div>
      </form>
    </section>
  )
}
