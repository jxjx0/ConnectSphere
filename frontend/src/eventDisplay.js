// Turning stored event values into what a person reads. Shared by the
// event list and the event detail page so both word things the same way.

// Booking and request statuses arrive as e.g. 'PENDING_VENUE_APPROVAL'.
// Event statuses have their own per-role wording in eventStatus.js.
export function readableStatus(status) {
  if (status === 'AFFECTED_BY_UNAVAILABILITY') return 'Affected by venue unavailability'
  if (status === 'AFFECTED_BY_SESSION_CHANGE') return 'Affected by session change'
  const words = status.replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function formatDateTime(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unknown date'

  const hours = date.getHours()
  const hour = hours % 12 || 12
  const period = hours >= 12 ? 'PM' : 'AM'
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}, `
    + `${hour}:${String(date.getMinutes()).padStart(2, '0')} ${period}`
}

// Optional fields are left blank by plenty of Organisers; saying so reads
// better than an empty cell.
export function optional(value) {
  return value || 'None given'
}

// A run of time reads better as one line than two timestamps: same-day
// events show the date once, overnight ones spell both out.
export function formatDateRange(start, end) {
  const from = new Date(start)
  const to = new Date(end)
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return 'Unknown dates'
  }

  if (from.toDateString() === to.toDateString()) {
    return `${formatDate(from)}, ${formatTime(from)} – ${formatTime(to)}`
  }
  return `${formatDateTime(start)} – ${formatDateTime(end)}`
}

// An event's sessions, as saved, earliest first (unscheduled ones last).
// Events created before sessions existed (or by older code) have none;
// their own time and needs are shown as a single session so the page never
// comes up blank.
export function sessionsOf(event) {
  if (event.sessions?.length) {
    return [...event.sessions].sort((first, second) => {
      if (!first.start_time) return second.start_time ? 1 : 0
      if (!second.start_time) return -1
      return new Date(first.start_time) - new Date(second.start_time)
    })
  }
  return [
    {
      id: `${event.id}-main`,
      name: 'Main session',
      start_time: event.start_time,
      end_time: event.end_time,
      expected_attendance: event.expected_attendance,
      location_preference: event.location_preference,
      layout_preference: event.layout_preference,
      equipment_requirements: event.equipment_requirements,
    },
  ]
}

// "4 sessions · up to 300 attendees". The event's expected_attendance is
// kept by the database as its largest session's attendance.
export function formatSessionSummary(event) {
  const count = sessionsOf(event).length
  const sessions = count === 1 ? '1 session' : `${count} sessions`
  const attendees = count === 1
    ? `${event.expected_attendance} attendees`
    : `up to ${event.expected_attendance} attendees`
  return `${sessions} · ${attendees}`
}

// Venue requests that still hold, or may soon hold, a venue. Mirrors
// LIVE_BOOKING_STATUSES in backend/services/venue_booking_service.py: a
// session has at most one of these (T7-278).
const LIVE_VENUE_BOOKING_STATUSES = ['PENDING_VENUE_APPROVAL', 'APPROVED']

export function liveBookingFor(sessionId, bookings) {
  return (bookings || []).find((booking) =>
    booking.session_id === sessionId
    && LIVE_VENUE_BOOKING_STATUSES.includes(booking.status))
}

// "Breakout A · 15 Dec 2026, 9:00 AM – 5:00 PM · Room 3-1 (pending)", for
// choosing which session to find a venue for.
export function sessionPickerLabel(session, bookings) {
  const booking = liveBookingFor(session.id, bookings)
  const venue = booking
    ? `${booking.venues?.name || 'Venue'} (${booking.status === 'APPROVED' ? 'approved' : 'pending'})`
    : 'no venue yet'
  return `${session.name} · ${formatDateRange(session.start_time, session.end_time)} · ${venue}`
}

function formatDate(date) {
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`
}

function formatTime(date) {
  const hours = date.getHours()
  const hour = hours % 12 || 12
  const period = hours >= 12 ? 'PM' : 'AM'
  return `${hour}:${String(date.getMinutes()).padStart(2, '0')} ${period}`
}

// The stages an Organiser may ask to change their event from. Must match
// the check in the submit_session_change_request database function.
export const CHANGEABLE_STATUSES = ['under_review', 'planning', 'confirmed']

// The stages an Organiser may ask to cancel their event from. Must match
// the check in the submit_event_cancellation_request database function.
export const CANCELLABLE_STATUSES = ['planning', 'awaiting_safety_check', 'confirmed']
