// Registration period and attendee capacity for an event. Kept out of the
// page so the rules can be tested.

import { readableStatus, sessionsOf } from './eventDisplay.js'
import { toDateTimeInput } from './eventSessions.js'

// Once the Coordinator has approved the request, until the event ends.
// Must match the status check in save_event_registration
// (database/event_registration.sql).
export const REGISTRATION_STATUSES = [
  'planning',
  'change_requested',
  'awaiting_clarification',
  'awaiting_safety_check',
  'confirmed',
]

// Every room an attendee could be in has to hold them, so the smallest
// approved venue sets the limit. Null while no venue is approved.
export function largestAllowedCapacity(arrangements) {
  const capacities = arrangements
    .filter((item) => item.kind === 'venue' && item.status === 'APPROVED')
    .map((item) => item.venue_capacity)
  return capacities.length ? Math.min(...capacities) : null
}

// The saved settings, or a starting point taken from the event request:
// the expected attendance, kept within the venue.
export function registrationFormFrom(event, arrangements) {
  const limit = largestAllowedCapacity(arrangements)
  const suggested = limit === null
    ? event.expected_attendance
    : Math.min(event.expected_attendance, limit)
  return {
    opensAt: toDateTimeInput(event.registration_opens_at),
    closesAt: toDateTimeInput(event.registration_closes_at),
    capacity: String(event.attendee_capacity ?? suggested ?? ''),
  }
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
  const limit = largestAllowedCapacity(arrangements)
  if (limit !== null && capacity > limit) {
    return `Attendee capacity cannot exceed the venue capacity of ${limit}.`
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
      venueConfirmed: venue?.status === 'APPROVED',
    }
  })
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
