import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

import { getAllEquipmentBookings } from '../api/equipmentRequests'
import AppShell from '../components/AppShell'
import { useAuth } from '../context/AuthContext'
import { bookingsOnDay, monthRange, monthWeeks } from '../equipmentCalendar'
import { formatDateRange } from '../eventDisplay'

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function formatTime(value) {
  return new Date(value).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  })
}

export default function EquipmentBookingCalendarPage() {
  const { token } = useAuth()
  const today = new Date()
  const [month, setMonth] = useState({
    year: today.getFullYear(),
    month: today.getMonth(),
  })
  const [bookings, setBookings] = useState([])
  const [selectedBooking, setSelectedBooking] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const loadBookings = useCallback(() => {
    const { from, to } = monthRange(month.year, month.month)
    setError('')
    setLoading(true)
    return getAllEquipmentBookings(from, to, token)
      .then((result) => setBookings(result.bookings))
      .catch((caught) => setError(caught.message))
      .finally(() => setLoading(false))
  }, [month, token])

  useEffect(() => {
    loadBookings()
  }, [loadBookings])

  function changeMonth(step) {
    setSelectedBooking(null)
    setMonth((current) => {
      const date = new Date(current.year, current.month + step, 1)
      return { year: date.getFullYear(), month: date.getMonth() }
    })
  }

  const monthLabel = new Date(month.year, month.month, 1)
    .toLocaleDateString([], { month: 'long', year: 'numeric' })

  return (
    <AppShell>
      <div className="content">
        <Link to="/equipment" className="backlink">← Equipment catalogue</Link>
        <div className="content__header">
          <h1>Shared equipment bookings</h1>
          <p className="lead">
            Reservations across all equipment. Select a booking to view the event,
            equipment, and reserved time.
          </p>
        </div>

        <section className="stack stack--tight">
          <div className="booking-calendar__nav">
            <button
              type="button"
              className="button button--secondary"
              onClick={() => changeMonth(-1)}
            >
              ← Previous
            </button>
            <h2 className="section-title booking-calendar__month">{monthLabel}</h2>
            <button
              type="button"
              className="button button--secondary"
              onClick={() => changeMonth(1)}
            >
              Next →
            </button>
          </div>

          {error && <p className="form-error" role="alert">{error}</p>}
          {loading && <p className="page-state">Loading shared bookings…</p>}

          {!loading && !error && (
            <>
              <div
                className="booking-calendar"
                role="table"
                aria-label={`Shared equipment bookings for ${monthLabel}`}
              >
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
                            <button
                              className="booking-calendar__booking booking-calendar__booking-button"
                              type="button"
                              key={booking.id}
                              aria-pressed={selectedBooking?.id === booking.id}
                              onClick={() => setSelectedBooking(booking)}
                            >
                              {formatTime(booking.start_at)} {booking.equipment_name}
                              {' · '}{booking.event_name}
                            </button>
                          ))}
                        </div>
                      )
                    })}
                  </div>
                ))}
              </div>

              {selectedBooking ? (
                <article className="choice equipment-request-card" aria-live="polite">
                  <div className="equipment-request-card__body">
                    <strong className="choice__title">{selectedBooking.event_name}</strong>
                    <span className="choice__description">
                      Equipment: {selectedBooking.equipment_name}
                      {selectedBooking.equipment_type
                        ? ` · ${selectedBooking.equipment_type}`
                        : ''}
                    </span>
                    <span className="choice__description">
                      Reserved: {formatDateRange(selectedBooking.start_at, selectedBooking.end_at)}
                    </span>
                    <span className="choice__description">
                      Request status: <span className="tag">{selectedBooking.request_status}</span>
                    </span>
                  </div>
                </article>
              ) : (
                <p className="note">
                  {bookings.length === 0
                    ? 'No equipment is reserved this month.'
                    : 'Select a reservation on the calendar to see its details.'}
                </p>
              )}
            </>
          )}
        </section>
      </div>
    </AppShell>
  )
}
