// An Attendee registering for a published event. Kept out of the pages so
// the rules can be tested.

import { formatDateTime } from './eventDisplay.js'

// Mirror EMAIL_PATTERN and PHONE_PATTERN in
// backend/models/attendee_registration.py.
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const PHONE_PATTERN = /^[0-9+()\-\s]{6,30}$/

export const EMPTY_REGISTRATION = {
  fullName: '',
  email: '',
  address: '',
  contactNumber: '',
}

// Whether the event can be registered for right now, and if not, why.
// The database makes the final decision; this decides what to show.
export function registrationAvailability(event, now = new Date()) {
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

  const email = form.email.trim()
  if (!email) errors.push('Email is required.')
  else if (!EMAIL_PATTERN.test(email)) errors.push('Email must be a valid email address.')

  if (!form.address.trim()) errors.push('Address is required.')

  const contactNumber = form.contactNumber.trim()
  if (!contactNumber) errors.push('Contact number is required.')
  else if (!PHONE_PATTERN.test(contactNumber)) {
    errors.push('Contact number must be a valid phone number.')
  }
  return errors
}

export function registrationToPayload(form) {
  return {
    full_name: form.fullName.trim(),
    email: form.email.trim(),
    address: form.address.trim(),
    contact_number: form.contactNumber.trim(),
  }
}
