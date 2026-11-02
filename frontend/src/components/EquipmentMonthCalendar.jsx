// A month of equipment reservations, shared by Technical Support's pages.
// Long names are cut short to fit a day, so each reservation carries its
// full description as a tooltip and for screen readers.

import { bookingsOnDay, monthWeeks } from '../equipmentCalendar'

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

export function formatBookingTime(value) {
  return new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export function stepMonth(current, step) {
  const date = new Date(current.year, current.month + step, 1)
  return { year: date.getFullYear(), month: date.getMonth() }
}

export default function EquipmentMonthCalendar({
  title,
  year,
  month,
  bookings,
  describe,
  onChangeMonth,
  onSelect,
  selectedId,
}) {
  const today = new Date()
  const monthLabel = new Date(year, month, 1)
    .toLocaleDateString([], { month: 'long', year: 'numeric' })

  return (
    <div className="stack stack--tight">
      <div className="booking-calendar__nav">
        <button
          type="button"
          className="button button--secondary button--small"
          aria-label="Previous month"
          onClick={() => onChangeMonth(-1)}
        >
          ← Previous
        </button>
        <h3 className="section-title booking-calendar__month">{monthLabel}</h3>
        <button
          type="button"
          className="button button--secondary button--small"
          aria-label="Next month"
          onClick={() => onChangeMonth(1)}
        >
          Next →
        </button>
      </div>

      <div className="booking-calendar" role="table" aria-label={`${title} for ${monthLabel}`}>
        <div className="booking-calendar__row" role="row">
          {WEEKDAYS.map((weekday) => (
            <span className="booking-calendar__weekday" role="columnheader" key={weekday}>
              {weekday}
            </span>
          ))}
        </div>
        {monthWeeks(year, month).map((week) => (
          <div className="booking-calendar__row" role="row" key={week[0].toISOString()}>
            {week.map((day) => {
              const classes = ['booking-calendar__day']
              if (day.getMonth() !== month) classes.push('booking-calendar__day--outside')
              if (day.toDateString() === today.toDateString()) classes.push('booking-calendar__day--today')
              return (
                <div className={classes.join(' ')} role="cell" key={day.toISOString()}>
                  <span className="booking-calendar__date">{day.getDate()}</span>
                  {bookingsOnDay(bookings, day).map((booking) => {
                    const text = `${formatBookingTime(booking.start_at)} ${describe(booking)}`
                    return onSelect ? (
                      <button
                        className="booking-calendar__booking booking-calendar__booking-button"
                        type="button"
                        key={booking.id}
                        title={text}
                        aria-pressed={selectedId === booking.id}
                        onClick={() => onSelect(booking)}
                      >
                        {text}
                      </button>
                    ) : (
                      <span className="booking-calendar__booking" key={booking.id} title={text}>
                        {text}
                      </span>
                    )
                  })}
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}
