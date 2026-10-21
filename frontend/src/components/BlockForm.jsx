import { useEffect, useRef, useState } from 'react'

import { useAuth } from '../context/AuthContext'
import { createVenueBlock, createVenueHold, getVenueHoldEvents } from '../api/venues'
import { venueBlockPayload, venueHoldPayload } from '../venueBlock.js'
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
  const [type, setType] = useState('operational_block')
  const [events, setEvents] = useState(null)
  const [eventId, setEventId] = useState('')
  const [expiryDate, setExpiryDate] = useState('')
  const [expiryTime, setExpiryTime] = useState('')
  const [eventsError, setEventsError] = useState('')
  const isHold = type === 'tentative_hold'

  useEffect(() => {
    if (!isHold) return
    let cancelled = false
    setEvents(null)
    setEventsError('')
    getVenueHoldEvents(token).then(({ events }) => {
      if (!Array.isArray(events)) throw new Error('Unable to load events.')
      if (!cancelled) setEvents(events)
    }).catch(error => { if (!cancelled) setEventsError(error.message) })
    return () => { cancelled = true }
  }, [isHold, token])

  async function handleSubmit(event) {
    event.preventDefault()
    setError('')

    setSubmitting(true)

    try {
      if (isHold) {
        const payload = venueHoldPayload({ startDate, startTime, endDate, endTime, eventId, expiryDate, expiryTime }, venue.setup_time_minutes)
        const data = await createVenueHold(venue.id, payload, token)
        if (!data?.hold?.hold_id) throw new Error('Hold creation unconfirmed. Refresh before trying again.')
        setOutcome(data)
        onCreated?.()
        return
      }
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

  if (outcome?.hold) {
    return renderModal(<section className="form stack stack--tight">
      <h2 className="venue-block-dialog__title" id="blockVenueTitle" tabIndex={-1} autoFocus>Tentative Hold</h2>
      <strong>{venue.name}</strong>
      <p role="status">Hold created.</p>
      <p>{formatDateRange(outcome.hold.start_at, outcome.hold.end_at)}</p>
      <p className="note">Expires: {new Date(outcome.hold.expires_at).toLocaleString()}</p>
      <p className="note">{outcome.notification_status === 'saved' ? 'Coordinator notified.' : 'Coordinator could not be notified. Please follow up.'}</p>
      <button type="button" className="button button--secondary" onClick={onClose}>Close</button>
    </section>)
  }

  if (outcome) {
    const impact = outcome.booking_impact
    const verified = impact?.status === 'verified' && Array.isArray(impact.affected_bookings)
    const identified = verified || (impact?.status === 'partial'
      && Array.isArray(impact.affected_bookings) && impact.affected_bookings.length > 0)
    const affected = identified ? impact.affected_bookings : []
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
        {identified && <section className="progress venue-block-dialog__impact">
          <h3 className="note">Booking impact</h3>
          <p>
            {affected.length === 0
              ? 'No existing bookings are affected.'
              : `${affected.length} existing booking${affected.length === 1 ? '' : 's'} affected.`}
          </p>
          {affected.length > 0 && <ul>{affected.map((booking, index) => (
            <li key={booking.booking_id || index}>
              {booking.event_name || 'Affected venue booking'}
              {booking.effective_start && booking.effective_end && <span className="note">
                {' — '}{formatDateRange(booking.effective_start, booking.effective_end)}
              </span>}
              {booking.status_update !== 'updated' && <span className="note">
                {' — '}{booking.status_update === 'failed' ? 'Booking status unchanged. Please follow up.'
                  : booking.status_update === 'not_updated' ? 'Booking may have changed. Refresh to review.'
                    : 'Booking status unconfirmed. Refresh to review.'}
              </span>}
              {booking.notification_status !== 'saved' && <span className="note">
                {' — '}{booking.notification_status === 'missing_coordinator' ? 'No Coordinator assigned. Please follow up.'
                  : booking.notification_status === 'failed' ? 'Coordinator could not be notified. Please follow up.'
                    : booking.notification_status === 'not_required' ? 'Coordinator not notified.'
                      : 'Notification unconfirmed. Please follow up.'}
              </span>}
            </li>
          ))}</ul>}
          {affected.length > 0 && <p className="note">
            {verified && affected.every((booking) => booking.status_update === 'updated' && booking.notification_status === 'saved')
              ? (affected.length === 1 ? 'Coordinator notified.' : 'Coordinators notified.')
              : 'Please follow up on the items above.'}
          </p>}
        </section>}
        {!identified && <p className="note" role="status">Impact check unavailable. Review existing bookings.</p>}
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
          <h2 className="venue-block-dialog__title" id="blockVenueTitle">Block / Tentative Hold</h2>
        </header>
        <p><strong>Selected venue:</strong> {venue.name}</p>

        <fieldset className="venue-block-dialog__types" disabled={submitting}>
          <legend>Type</legend>
          <div className="venue-block-dialog__type-options">
            {[
              ['operational_block', 'Operational Unavailability'],
              ['tentative_hold', 'Tentative Hold'],
            ].map(([value, label]) => <label key={value} className={type === value ? 'is-selected' : ''}>
              <input type="radio" name="venueBlockType" value={value} checked={type === value}
                onChange={() => { setType(value); setError('') }} />
              <span>{label}</span>
            </label>)}
          </div>
        </fieldset>
        {isHold && <div className="field">
          <label htmlFor="holdEvent">Hold this venue for which event?</label>
          <select id="holdEvent" aria-describedby="holdEventHint" required disabled={submitting || !events} value={eventId}
            onChange={event => setEventId(event.target.value)}>
            <option value="">{events ? 'Select an event' : 'Loading events…'}</option>
            {events?.map(event => <option key={event.id} value={event.id}>{event.name}</option>)}
          </select>
          <p id="holdEventHint" className="field__hint">Choose the event that will use this venue. Its Coordinator will be notified.</p>
          {events?.length === 0 && <p className="note">No upcoming events with an assigned Coordinator.</p>}
          {eventsError && <p role="alert" className="field__error">{eventsError}</p>}
        </div>}

        <div className="field">
          <label>{isHold ? 'Hold period' : 'Blocked period'}</label>

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

        {isHold ? <div className="field">
          <label>Expiry</label>
          <div className="repeater__row repeater__row--equal">
            <div className="repeater__field">
              <label htmlFor="holdExpiryDate">Expiry date</label>
              <input id="holdExpiryDate" type="date" required disabled={submitting} value={expiryDate}
                onChange={event => setExpiryDate(event.target.value)} />
            </div>
            <div className="repeater__field">
              <label htmlFor="holdExpiryTime">Expiry time</label>
              <input id="holdExpiryTime" type="time" required disabled={submitting} value={expiryTime}
                onChange={event => setExpiryTime(event.target.value)} />
            </div>
          </div>
          <p className="note">Local time. Expiry must be no later than setup begins.</p>
        </div> : <div className="field">
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
        </div>}

        {error && (
          <p className="field__error" role="alert">
            {error}
          </p>
        )}

        <div className="form-actions">
          <button
            type="submit"
            className="button"
            disabled={submitting || (isHold && !events?.length)}
          >
            {submitting ? 'Submitting...' : isHold ? 'Create hold' : 'Block Venue'}
          </button>

          <button
            type="button"
            className="button button--secondary"
            disabled={submitting}
            onClick={onClose}
          >
            Cancel
          </button>
        </div>
      </form>
    </section>
  )
}
