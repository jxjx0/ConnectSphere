// An Attendee registering for a published event. Kept out of the pages so
// the rules can be tested.

import { formatDateTime } from './eventDisplay.js'

// Mirror PHONE_PATTERN in backend/models/attendee_registration.py.
const PHONE_PATTERN = /^[0-9+()\-\s]{6,30}$/

// email is the account email, shown read-only and never sent: the
// database always registers under the account's own address.
export const EMPTY_REGISTRATION = {
  fullName: '',
  email: '',
  contactNumber: '',
}

// Whether the event can be registered for right now, and if not, why.
// The database makes the final decision; this decides what to show.
export function registrationAvailability(event, now = new Date()) {
  if (event.status === 'cancelled') {
    return {
      open: false,
      message: 'This event has been cancelled. Registration is closed.',
    }
  }
  if (event.is_registered) {
    return { open: false, message: 'You are registered for this event.' }
  }
  if (event.registration_opens_at && now < new Date(event.registration_opens_at)) {
    return {
      open: false,
      message: `Registration opens ${formatDateTime(event.registration_opens_at)}.`,
    }
  }
  if (!event.registration_closes_at || now >= new Date(event.registration_closes_at)) {
    return { open: false, message: 'Registration is unavailable: registration has closed.' }
  }
  if (!event.spots_left) {
    return { open: false, message: 'Registration is unavailable: this event is full.' }
  }
  return { open: true, message: '' }
}

export function spotsLeftLabel(event) {
  if (!event.spots_left) return 'No spots left'
  return event.spots_left === 1 ? '1 spot left' : `${event.spots_left} spots left`
}

// Event-wide availability stays separate from the attendee's own place.
export function registrationStatusLabel(event, now = new Date()) {
  if (event.status === 'cancelled') return 'Event cancelled'
  if (event.status === 'completed' || (event.end_time && now >= new Date(event.end_time))) return 'Event ended'
  if (event.registration_opens_at && now < new Date(event.registration_opens_at)) return 'Registration not yet open'
  if (!event.registration_closes_at || now >= new Date(event.registration_closes_at)) return 'Registration closed'
  if (!event.spots_left) return 'Fully booked'
  return 'Registration open'
}

export function filterAttendeeEvents(events, query, filter, now = new Date()) {
  const search = query.trim().toLowerCase()
  return events.filter((event) => {
    if (!event.name.toLowerCase().includes(search)) return false
    if (filter === 'available') return registrationAvailability(event, now).open
    if (filter === 'registered') return event.is_registered
    return true
  })
}

export function filterRegistrationGroups(groups, query, filter) {
  const search = query.trim().toLowerCase()
  return groups.filter(({ latest }) => latest.event_name.toLowerCase().includes(search)
    && (filter === 'all' || latest.status === filter))
}

// Past registrations are for events that were cancelled or have finished.
export function isPastRegistration({ latest }, now = new Date()) {
  return ['cancelled', 'completed', 'rejected'].includes(latest.event_status)
    || (Boolean(latest.event_end_time) && now >= new Date(latest.event_end_time))
}

export function groupRegistrationsByEvent(registrations) {
  const groups = new Map()
  const newestFirst = [...registrations].sort(
    (first, second) => new Date(second.created_at) - new Date(first.created_at),
  )

  for (const registration of newestFirst) {
    const group = groups.get(registration.event_id)
    if (group) {
      group.history.push(registration)
    } else {
      groups.set(registration.event_id, { latest: registration, history: [] })
    }
  }
  return [...groups.values()]
}

// Mirrors AttendeeRegistrationSubmit in backend/models/attendee_registration.py,
// so every problem is shown at once before a round trip.
export function validateAttendeeRegistration(form) {
  return Object.values(attendeeRegistrationFieldErrors(form))
}

export function attendeeRegistrationFieldErrors(form) {
  const errors = {}
  if (!form.fullName.trim()) errors.fullName = 'Full name is required.'
  else if (form.fullName.trim().length > 120) errors.fullName = 'Full name must be 120 characters or fewer.'

  // Optional, but checked when given.
  const contactNumber = form.contactNumber.trim()
  if (contactNumber && !PHONE_PATTERN.test(contactNumber)) {
    errors.contactNumber = 'Contact number must be a valid phone number.'
  }
  return errors
}

export function registrationToPayload(form) {
  return {
    full_name: form.fullName.trim(),
    contact_number: form.contactNumber.trim() || null,
  }
}
