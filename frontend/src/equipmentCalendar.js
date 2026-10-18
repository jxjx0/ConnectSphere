// Month calendar and booking-time helpers for equipment bookings. Dates are
// handled in the viewer's local time, which is what the calendar shows.

// Weeks of a month as rows of seven days, Monday first. Days from the
// neighbouring months fill the first and last rows.
export function monthWeeks(year, month) {
  const first = new Date(year, month, 1)
  const offset = (first.getDay() + 6) % 7
  const start = new Date(year, month, 1 - offset)
  const weeks = []
  for (let week = 0; week < 6; week += 1) {
    const days = []
    for (let day = 0; day < 7; day += 1) {
      days.push(new Date(
        start.getFullYear(),
        start.getMonth(),
        start.getDate() + week * 7 + day,
      ))
    }
    if (week > 0 && days[0].getMonth() !== month) break
    weeks.push(days)
  }
  return weeks
}

// The time range a month calendar covers, for loading its bookings.
export function monthRange(year, month) {
  return {
    from: new Date(year, month, 1),
    to: new Date(year, month + 1, 1),
  }
}

// Bookings that overlap any part of the given local day.
export function bookingsOnDay(bookings, day) {
  const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate())
  const dayEnd = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)
  return bookings.filter((booking) => (
    new Date(booking.start_at) < dayEnd && new Date(booking.end_at) > dayStart
  ))
}

// A request's suggested booking time: from the start of its earliest event
// window to the end of its latest one.
export function defaultBookingWindow(request) {
  const windows = request?.bookings || []
  if (windows.length === 0) return null
  const starts = windows.map((window) => new Date(window.start_at).getTime())
  const ends = windows.map((window) => new Date(window.end_at).getTime())
  return {
    start: new Date(Math.min(...starts)),
    end: new Date(Math.max(...ends)),
  }
}

// <input type="datetime-local"> works in local time without a zone.
export function toLocalInputValue(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}
