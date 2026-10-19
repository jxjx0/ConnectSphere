import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'

import {
  createEquipmentBooking,
  deleteEquipmentBooking,
  getEquipmentBookings,
  getEquipmentCatalog,
  getEquipmentRequests,
} from '../api/equipmentRequests'
import AppShell from '../components/AppShell'
import { useAuth } from '../context/AuthContext'
import {
  bookingsOnDay,
  defaultBookingWindow,
  monthRange,
  monthWeeks,
  toLocalInputValue,
} from '../equipmentCalendar'
import { formatDateRange } from '../eventDisplay'

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const PENDING = 'Pending Technical Approval'

function formatTime(value) {
  return new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export default function EquipmentBookingsPage() {
  const { equipmentId } = useParams()
  const [searchParams] = useSearchParams()
  const { token } = useAuth()

  const [item, setItem] = useState(null)
  const [requests, setRequests] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const today = new Date()
  const [month, setMonth] = useState({ year: today.getFullYear(), month: today.getMonth() })
  const [bookings, setBookings] = useState([])
  const [bookingsError, setBookingsError] = useState('')
  const [availabilityBookings, setAvailabilityBookings] = useState([])
  const [availabilityChecked, setAvailabilityChecked] = useState(false)
  const [availabilityLoading, setAvailabilityLoading] = useState(false)
  const [availabilityError, setAvailabilityError] = useState('')

  const [requestId, setRequestId] = useState('')
  const [startAt, setStartAt] = useState('')
  const [endAt, setEndAt] = useState('')
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')
  const [formMessage, setFormMessage] = useState('')
  const [removingId, setRemovingId] = useState('')

  const pendingRequests = useMemo(
    () => requests.filter((request) => (
      request.status === PENDING
    )),
    [requests],
  )
  const alreadyAllocated = availabilityBookings.some(
    (booking) => booking.request_id === requestId,
  )
  const hasOverlappingReservation = availabilityBookings.some(
    (booking) => booking.request_id !== requestId,
  )

  const chooseRequest = useCallback((id, requestList) => {
    setRequestId(id)
    const window = defaultBookingWindow(requestList.find((request) => request.id === id))
    if (!window) {
      setStartAt('')
      setEndAt('')
      return
    }
    setStartAt(toLocalInputValue(window.start))
    setEndAt(toLocalInputValue(window.end))
    setMonth({ year: window.start.getFullYear(), month: window.start.getMonth() })
  }, [])

  useEffect(() => {
    Promise.all([getEquipmentCatalog(token), getEquipmentRequests(token)])
      .then(([catalog, requestData]) => {
        const found = catalog.find((entry) => entry.id === equipmentId)
        if (!found) {
          setError('This equipment item was not found.')
          return
        }
        setItem(found)
        setRequests(requestData.requests)
        const preselected = searchParams.get('request')
        if (preselected && requestData.requests.some(
          (request) => (
            request.id === preselected
            && request.status === PENDING
          ),
        )) {
          chooseRequest(preselected, requestData.requests)
        }
      })
      .catch((caught) => setError(caught.message))
      .finally(() => setLoading(false))
  }, [chooseRequest, equipmentId, searchParams, token])

  const loadBookings = useCallback(() => {
    const { from, to } = monthRange(month.year, month.month)
    setBookingsError('')
    return getEquipmentBookings(equipmentId, from, to, token)
      .then((data) => setBookings(data.bookings))
      .catch((caught) => setBookingsError(caught.message))
  }, [equipmentId, month, token])

  useEffect(() => {
    loadBookings()
  }, [loadBookings])

  useEffect(() => {
    if (!requestId || !startAt || !endAt) {
      setAvailabilityBookings([])
      setAvailabilityChecked(false)
      setAvailabilityError('')
      return undefined
    }

    const start = new Date(startAt)
    const end = new Date(endAt)
    if (
      Number.isNaN(start.getTime())
      || Number.isNaN(end.getTime())
      || end <= start
    ) {
      setAvailabilityBookings([])
      setAvailabilityChecked(false)
      setAvailabilityError('')
      return undefined
    }

    let active = true
    setAvailabilityChecked(false)
    setAvailabilityLoading(true)
    setAvailabilityError('')
    getEquipmentBookings(equipmentId, start, end, token)
      .then((data) => {
        if (active) {
          setAvailabilityBookings(data.bookings)
          setAvailabilityChecked(true)
        }
      })
      .catch((caught) => {
        if (active) setAvailabilityError(caught.message)
      })
      .finally(() => {
        if (active) setAvailabilityLoading(false)
      })

    return () => {
      active = false
    }
  }, [equipmentId, endAt, requestId, startAt, token])

  function changeMonth(step) {
    setMonth((current) => {
      const date = new Date(current.year, current.month + step, 1)
      return { year: date.getFullYear(), month: date.getMonth() }
    })
  }

  async function handleSubmit(event) {
    event.preventDefault()
    setFormError('')
    setFormMessage('')

    if (!requestId) {
      setFormError('Choose the equipment request this booking is for.')
      return
    }
    if (!availabilityChecked || alreadyAllocated) {
      setFormError('This equipment is not available for the required event time.')
      return
    }
    const start = new Date(startAt)
    const end = new Date(endAt)
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      setFormError('Enter a start and end time.')
      return
    }
    if (end <= start) {
      setFormError('The end time must be after the start time.')
      return
    }

    setSaving(true)
    try {
      const result = await createEquipmentBooking({
        equipment_id: equipmentId,
        request_id: requestId,
        start_at: start.toISOString(),
        end_at: end.toISOString(),
      }, token)
      setAvailabilityBookings((current) => [...current, result.booking])
      setAvailabilityChecked(true)
      setFormMessage(`${item.name} booked for ${formatDateRange(start, end)}.`)
      setMonth({ year: start.getFullYear(), month: start.getMonth() })
      await loadBookings()
    } catch (caught) {
      setFormError(caught.message)
    } finally {
      setSaving(false)
    }
  }

  async function handleRemove(bookingId) {
    setRemovingId(bookingId)
    setBookingsError('')
    try {
      await deleteEquipmentBooking(bookingId, token)
      setAvailabilityBookings((current) => current.filter(
        (booking) => booking.id !== bookingId,
      ))
      await loadBookings()
    } catch (caught) {
      setBookingsError(caught.message)
    } finally {
      setRemovingId('')
    }
  }

  if (loading) {
    return (
      <AppShell>
        <p className="page-state">Loading equipment bookings…</p>
      </AppShell>
    )
  }

  if (error) {
    return (
      <AppShell>
        <div className="content">
          <Link to="/equipment" className="backlink">← Equipment catalogue</Link>
          {' · '}
          <Link to="/equipment/bookings" className="backlink">Shared bookings calendar</Link>
          <p className="form-error" role="alert">{error}</p>
        </div>
      </AppShell>
    )
  }

  const functional = item.maintenance_status === 'Functional'
  const monthLabel = new Date(month.year, month.month, 1)
    .toLocaleDateString([], { month: 'long', year: 'numeric' })

  return (
    <AppShell>
      <div className="content">
        <Link to="/equipment" className="backlink">← Equipment catalogue</Link>
        <div className="content__header">
          <h1>{item.name} bookings</h1>
          <p className="lead">
            {item.type} · <span className="tag">{item.maintenance_status}</span>
            {' · '}<code>{item.id}</code>
          </p>
        </div>

        <section className="stack stack--tight">
          <div className="booking-calendar__nav">
            <button type="button" className="button button--secondary" onClick={() => changeMonth(-1)}>
              ← Previous
            </button>
            <h2 className="section-title booking-calendar__month">{monthLabel}</h2>
            <button type="button" className="button button--secondary" onClick={() => changeMonth(1)}>
              Next →
            </button>
          </div>

          {bookingsError && <p className="form-error" role="alert">{bookingsError}</p>}

          <div className="booking-calendar" role="table" aria-label={`${item.name} bookings for ${monthLabel}`}>
            <div className="booking-calendar__row" role="row">
              {WEEKDAYS.map((weekday) => (
                <span className="booking-calendar__weekday" role="columnheader" key={weekday}>
                  {weekday}
                </span>
              ))}
            </div>
            {monthWeeks(month.year, month.month).map((week) => (
              <div className="booking-calendar__row" role="row" key={week[0].toISOString()}>
                {week.map((day) => {
                  const dayBookings = bookingsOnDay(bookings, day)
                  const classes = ['booking-calendar__day']
                  if (day.getMonth() !== month.month) classes.push('booking-calendar__day--outside')
                  if (day.toDateString() === today.toDateString()) classes.push('booking-calendar__day--today')
                  if (dayBookings.length > 0) classes.push('booking-calendar__day--booked')
                  return (
                    <div className={classes.join(' ')} role="cell" key={day.toISOString()}>
                      <span className="booking-calendar__date">{day.getDate()}</span>
                      {dayBookings.map((booking) => (
                        <span className="booking-calendar__booking" key={booking.id}>
                          {formatTime(booking.start_at)} {booking.event_name}
                        </span>
                      ))}
                    </div>
                  )
                })}
              </div>
            ))}
          </div>

          <h2 className="section-title">Bookings in {monthLabel}</h2>
          {bookings.length === 0 ? (
            <p className="note">No bookings this month.</p>
          ) : (
            <div className="choices">
              {bookings.map((booking) => (
                <article className="choice equipment-request-card" key={booking.id}>
                  <span className="choice__text">
                    <span className="choice__title">{booking.event_name}</span>
                    <span className="choice__description">
                      {formatDateRange(booking.start_at, booking.end_at)}
                      {' · '}
                      <span className="tag">{booking.request_status}</span>
                    </span>
                  </span>
                  <div className="form-actions">
                    <button
                      type="button"
                      className="button button--secondary"
                      disabled={removingId === booking.id}
                      onClick={() => handleRemove(booking.id)}
                    >
                      {removingId === booking.id ? 'Removing…' : 'Remove booking'}
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        <form className="form" onSubmit={handleSubmit}>
          <h2 className="section-title">Add a booking</h2>
          {!functional && (
            <p className="note" role="status">
              This item is {item.maintenance_status.toLowerCase()} and cannot be allocated.
              Use the notification action below so the Coordinator can arrange an alternative.
            </p>
          )}
          {functional && pendingRequests.length === 0 && (
            <p className="note">There are no pending equipment requests to book this item for.</p>
          )}
          <div className="field">
            <label htmlFor="booking-request">Equipment request</label>
            <select
              id="booking-request"
              value={requestId}
              onChange={(change) => chooseRequest(change.target.value, requests)}
            >
              <option value="">Choose a pending request…</option>
              {pendingRequests.map((request) => (
                <option key={request.id} value={request.id}>
                  {request.event?.name || 'Event'}
                  {' · '}
                  {formatDateRange(request.event?.start_time, request.event?.end_time)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="booking-start">Start</label>
            <input
              id="booking-start"
              type="datetime-local"
              step="1"
              value={startAt}
              disabled={!functional}
              readOnly
            />
          </div>
          <div className="field">
            <label htmlFor="booking-end">End</label>
            <input
              id="booking-end"
              type="datetime-local"
              step="1"
              value={endAt}
              disabled={!functional}
              readOnly
            />
          </div>
          {requestId && (
            <p
              className={availabilityError ? 'form-error' : 'note'}
              role={availabilityError ? 'alert' : 'status'}
            >
              {availabilityError
                || (availabilityLoading
                  ? 'Checking availability for the complete event time…'
                  : availabilityChecked && alreadyAllocated
                    ? 'Already allocated to this request.'
                    : availabilityChecked && hasOverlappingReservation
                        ? 'Unavailable: this equipment overlaps another reservation. Submit to notify the Coordinator.'
                        : !functional
                          ? `Unavailable: this item is ${item.maintenance_status.toLowerCase()}. Submit to notify the Coordinator.`
                        : availabilityChecked
                          ? 'Available for the complete event time, including setup and teardown.'
                          : 'Availability has not been checked.')}
            </p>
          )}
          {formError && <p className="form-error" role="alert">{formError}</p>}
          {formMessage && <p className="form-success" role="status">{formMessage}</p>}
          <div className="form-actions">
            <button
              type="submit"
              className="button"
              disabled={
                saving
                || !availabilityChecked
                || !requestId
                || alreadyAllocated
                || Boolean(availabilityError)
              }
            >
              {saving
                ? 'Saving…'
                : !functional || hasOverlappingReservation
                  ? 'Notify Coordinator — unavailable'
                  : 'Allocate equipment'}
            </button>
            <Link to="/equipment-requests" className="button button--secondary">
              Back to requests
            </Link>
          </div>
        </form>
      </div>
    </AppShell>
  )
}
