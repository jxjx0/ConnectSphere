import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'

import {
  createEquipmentBooking,
  deleteEquipmentBooking,
  getEquipmentBookings,
  getEquipmentCatalog,
  getEquipmentRequests,
} from '../api/equipmentRequests'
import TechSupportShell from '../components/TechSupportShell'
import EquipmentMonthCalendar, { stepMonth } from '../components/EquipmentMonthCalendar'
import { useAuth } from '../context/AuthContext'
import {
  defaultBookingWindow,
  monthRange,
  toLocalInputValue,
} from '../equipmentCalendar'
import { statusTagClass } from '../equipmentCatalogue'
import { formatDateRange } from '../eventDisplay'
import styles from '../styles/TechSupport.module.css'

const PENDING = 'Pending Technical Approval'

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
        // Fill in the request asked for in the link, or the only one waiting.
        const waiting = requestData.requests.filter((request) => request.status === PENDING)
        const preselected = searchParams.get('request')
        if (waiting.some((request) => request.id === preselected)) {
          chooseRequest(preselected, requestData.requests)
        } else if (waiting.length === 1 && found.maintenance_status === 'Functional') {
          chooseRequest(waiting[0].id, requestData.requests)
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
    if (!window.confirm('Remove this booking?')) return

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
      <TechSupportShell>
        <p className="page-state">Loading equipment bookings…</p>
      </TechSupportShell>
    )
  }

  if (error) {
    return (
      <TechSupportShell>
        <div className="content__header">
          <Link to="/equipment" className="backlink">← Back to Equipment Catalogue</Link>
          <p className="form-error" role="alert">{error}</p>
        </div>
      </TechSupportShell>
    )
  }

  const functional = item.maintenance_status === 'Functional'
  const monthLabel = new Date(month.year, month.month, 1)
    .toLocaleDateString([], { month: 'long', year: 'numeric' })

  return (
    <TechSupportShell>
      <div className={styles.page}>
        <div className="content__header">
          <Link to="/equipment" className="backlink">← Back to Equipment Catalogue</Link>
          <h1>{item.name} bookings</h1>
          <p className="lead">{item.type} · <span className={statusTagClass(item.maintenance_status)}>{item.maintenance_status}</span></p>
          <p className={styles.equipmentId}>{item.id}</p>
        </div>

        <section className="stack stack--tight">
          {bookingsError && <p className="form-error" role="alert">{bookingsError}</p>}
          <EquipmentMonthCalendar
            title={`${item.name} bookings`}
            year={month.year}
            month={month.month}
            bookings={bookings}
            describe={(booking) => booking.event_name}
            onChangeMonth={(step) => setMonth((current) => stepMonth(current, step))}
          />

          <h2 className="section-title">Bookings in {monthLabel}</h2>
          {bookings.length === 0 ? (
            <p className="note">No bookings this month.</p>
          ) : (
            <div className="table-wrapper">
              <table className="venue-table">
                <caption className="visually-hidden">{item.name} bookings in {monthLabel}</caption>
                <thead>
                  <tr>
                    <th scope="col">Event</th>
                    <th scope="col">Reserved</th>
                    <th scope="col">Request status</th>
                    <th scope="col" className="venue-table__actions">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {bookings.map((booking) => (
                    <tr key={booking.id}>
                      <th scope="row">{booking.event_name}</th>
                      <td>{formatDateRange(booking.start_at, booking.end_at)}</td>
                      <td><span className={statusTagClass(booking.request_status)}>{booking.request_status}</span></td>
                      <td className="venue-table__actions">
                        <button
                          type="button"
                          className="button button--secondary button--small"
                          disabled={removingId === booking.id}
                          onClick={() => handleRemove(booking.id)}
                        >
                          {removingId === booking.id ? 'Removing…' : 'Remove'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <form className="form" onSubmit={handleSubmit}>
          <h2 className="section-title">Add a booking</h2>
          {!functional && (
            <p className="note" role="status">
              This item is {item.maintenance_status.toLowerCase()} and cannot be allocated.
              Choose a request below to tell its Coordinator, so they can arrange an alternative.
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
                  {request.session && ` · ${request.session.name}`}
                  {' · '}
                  {formatDateRange(
                    (request.session || request.event)?.start_time,
                    (request.session || request.event)?.end_time,
                  )}
                </option>
              ))}
            </select>
          </div>
          {startAt && endAt && (
            <p className="note">
              Needed for {formatDateRange(new Date(startAt), new Date(endAt))}.
              {' '}Bookings use the time on the request.
            </p>
          )}
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
                          ? 'Available for the whole time this request needs.'
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
              Back to request review
            </Link>
          </div>
        </form>
      </div>
    </TechSupportShell>
  )
}
