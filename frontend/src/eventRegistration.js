// Registration period and attendee capacity for an event. Kept out of the
// page so the rules can be tested.

import { readableStatus, sessionsOf } from './eventDisplay.js'
import { toDateTimeInput } from './eventSessions.js'

// Once the Coordinator has approved the request, until the event ends.
// Must match the status check in save_event_registration
// (database/event_registration.sql).
export const REGISTRATION_STATUSES = [
  'planning',
  'awaiting_safety_check',
  'confirmed',
]

// Attendees register for the whole event and the Organiser spreads them
// across its sessions, so the limit is what every session's approved venue
// holds together. Null until every session has one, as the total is not
// known before then. Mirrors save_event_registration, which has the final say.
export function largestAllowedCapacity(event, arrangements) {
  const capacities = sessionsOf(event).map((session) => arrangements.find(
    (item) => item.kind === 'venue'
      && item.status === 'APPROVED'
      && item.session_id === session.id,
  )?.venue_capacity)
  if (capacities.some((capacity) => capacity == null)) return null
  return capacities.reduce((total, capacity) => total + capacity, 0)
}

// Everyone expected across all the sessions. Null when no session gives a
// number.
export function totalExpectedAttendance(event) {
  const counts = sessionsOf(event)
    .map((session) => session.expected_attendance)
    .filter((count) => count != null)
  return counts.length ? counts.reduce((total, count) => total + count, 0) : null
}

// The saved settings, or a starting point taken from the event request:
// the total expected attendance, kept within the venues.
export function registrationFormFrom(event, arrangements) {
  const limit = largestAllowedCapacity(event, arrangements)
  const expected = totalExpectedAttendance(event)
  const suggested = limit === null || expected === null
    ? expected
    : Math.min(expected, limit)
  return {
    opensAt: toDateTimeInput(event.registration_opens_at),
    closesAt: toDateTimeInput(event.registration_closes_at),
    capacity: String(event.attendee_capacity ?? suggested ?? ''),
  }
}

// How many attendees have signed up, against the capacity when one is set.
// Always a string, so 0 is shown rather than read as "None given".
export function signUpSummary(count, capacity) {
  return capacity ? `${count} of ${capacity}` : String(count)
}

export function registrationHasClosed(event, now = new Date()) {
  return Boolean(event.registration_closes_at)
    && new Date(event.registration_closes_at) <= now
}

// Mirrors EventRegistrationRequest in backend/models/event.py and the
// checks in save_event_registration, so the Organiser sees a problem
// before a round trip.
export function validateRegistration(form, event, arrangements) {
  if (!form.opensAt) return 'Choose when registration opens.'
  if (!form.closesAt) return 'Choose when registration closes.'
  if (new Date(form.closesAt) <= new Date(form.opensAt)) {
    return 'Registration must close after it opens.'
  }
  if (event.start_time && new Date(form.closesAt) > new Date(event.start_time)) {
    return 'Registration must close before the event starts.'
  }
  const capacity = Number(form.capacity)
  if (!Number.isInteger(capacity) || capacity <= 0) {
    return 'Attendee capacity must be a whole number above 0.'
  }
  const limit = largestAllowedCapacity(event, arrangements)
  if (limit !== null && capacity > limit) {
    return `Attendee capacity cannot exceed ${limit}, the combined capacity of the sessions' venues.`
  }
  return null
}

export function registrationToPayload(form, publish) {
  return {
    // The datetime-local input has no timezone, so send the browser's
    // local time as an explicit UTC timestamp.
    registration_opens_at: new Date(form.opensAt).toISOString(),
    registration_closes_at: new Date(form.closesAt).toISOString(),
    attendee_capacity: Number(form.capacity),
    publish,
  }
}

// Where each session is held, for the attendee preview. A pending venue is
// still shown, marked as not final.
export function previewSessions(event, arrangements) {
  return sessionsOf(event).map((session) => {
    const venue = arrangements.find(
      (item) => item.kind === 'venue' && item.session_id === session.id,
    )
    return {
      ...session,
      venueName: venue?.venue_name ?? null,
      venueLocation: venue?.venue_location ?? null,
      venueCapacity: venue?.venue_capacity ?? null,
      venueConfirmed: venue?.status === 'APPROVED',
    }
  })
}

// A reminder of how many each session's venue holds, for the Organiser
// spreading attendees across sessions. Sessions without a venue are left out.
export function sessionCapacityNotes(sessions) {
  return sessions
    .filter((session) => session.venueCapacity != null)
    .map((session) => `${session.name}: up to ${session.venueCapacity} at ${session.venueName}`
      + (session.venueConfirmed ? '' : ' (pending approval)'))
}

// Everything that must be approved before the event can be published, one
// sentence each: every session's venue, any equipment, and the Safety
// Officer. Mirrors the publish checks in save_event_registration, which
// has the final say.
export function pendingItems(event, arrangements) {
  const items = []
  const sessions = sessionsOf(event)
  for (const session of sessions) {
    const venue = arrangements.find(
      (item) => item.kind === 'venue' && item.session_id === session.id,
    )
    if (!venue) {
      items.push(`${session.name}: no venue has been booked yet.`)
    } else if (venue.status !== 'APPROVED') {
      items.push(`${session.name}: venue booking is ${readableStatus(venue.status).toLowerCase()}.`)
    }
  }
  for (const request of arrangements) {
    if (request.kind === 'equipment' && request.status !== 'Approved') {
      const session = sessions.find((item) => item.id === request.session_id)
      items.push(`${session?.name ?? 'Event'}: equipment is ${request.status.toLowerCase()}.`)
    }
  }
  // Only the Safety Officer's approval moves an event to 'confirmed'.
  if (event.status !== 'confirmed') {
    items.push('The Safety Officer has not approved the event yet.')
  }
  return items
}
