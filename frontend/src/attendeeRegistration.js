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

// Mirrors AttendeeRegistrationSubmit in backend/models/attendee_registration.py,
// so every problem is shown at once before a round trip.
export function validateAttendeeRegistration(form) {
  const errors = []
  if (!form.fullName.trim()) errors.push('Full name is required.')

  // Optional, but checked when given.
  const contactNumber = form.contactNumber.trim()
  if (contactNumber && !PHONE_PATTERN.test(contactNumber)) {
    errors.push('Contact number must be a valid phone number.')
  }
  return errors
}

export function registrationToPayload(form) {
  return {
    full_name: form.fullName.trim(),
    contact_number: form.contactNumber.trim() || null,
  }
}
