import assert from 'node:assert/strict'
import test from 'node:test'

import {
  EMPTY_REGISTRATION,
  registrationAvailability,
  registrationToPayload,
  spotsLeftLabel,
  validateAttendeeRegistration,
} from '../src/attendeeRegistration.js'

const NOW = new Date('2099-11-10T09:00:00Z')

function event(overrides = {}) {
  return {
    id: 'event-1',
    registration_opens_at: '2099-11-01T09:00:00Z',
    registration_closes_at: '2099-11-20T09:00:00Z',
    attendee_capacity: 100,
    spots_left: 10,
    is_registered: false,
    ...overrides,
  }
}

const VALID_FORM = {
  fullName: 'Cara Ng',
  email: 'cara@example.com',
  contactNumber: '+65 9123 4567',
}

test('an event with spots left inside its registration window is open', () => {
  assert.deepEqual(registrationAvailability(event(), NOW), { open: true, message: '' })
})

test('a cancelled event is closed even when the attendee was registered', () => {
  const availability = registrationAvailability(
    event({ status: 'cancelled', is_registered: true }),
    NOW,
  )

  assert.deepEqual(availability, {
    open: false,
    message: 'This event has been cancelled. Registration is closed.',
  })
})

test('a full event is unavailable', () => {
  const availability = registrationAvailability(event({ spots_left: 0 }), NOW)
  assert.equal(availability.open, false)
  assert.match(availability.message, /full/)
})

test('a closed event is unavailable', () => {
  const availability = registrationAvailability(
    event({ registration_closes_at: '2099-11-05T09:00:00Z' }), NOW,
  )
  assert.equal(availability.open, false)
  assert.match(availability.message, /closed/)
})

test('an event not yet open says when it opens', () => {
  const availability = registrationAvailability(
    event({ registration_opens_at: '2099-11-15T09:00:00Z' }), NOW,
  )
  assert.equal(availability.open, false)
  assert.match(availability.message, /^Registration opens /)
})

test('an attendee who registered is told so instead of seeing the form', () => {
  const availability = registrationAvailability(event({ is_registered: true }), NOW)
  assert.equal(availability.open, false)
  assert.equal(availability.message, 'You are registered for this event.')
})

test('spots left reads naturally', () => {
  assert.equal(spotsLeftLabel(event({ spots_left: 0 })), 'No spots left')
  assert.equal(spotsLeftLabel(event({ spots_left: 1 })), '1 spot left')
  assert.equal(spotsLeftLabel(event({ spots_left: 5 })), '5 spots left')
})

test('valid details pass', () => {
  assert.deepEqual(validateAttendeeRegistration(VALID_FORM), [])
})

test('only the full name is required', () => {
  assert.deepEqual(validateAttendeeRegistration(EMPTY_REGISTRATION), [
    'Full name is required.',
  ])
})

test('the contact number can be left blank', () => {
  assert.deepEqual(validateAttendeeRegistration({ ...VALID_FORM, contactNumber: '   ' }), [])
})

test('the form has no address field', () => {
  assert.equal('address' in EMPTY_REGISTRATION, false)
})

test('a badly formatted phone number is reported', () => {
  assert.deepEqual(
    validateAttendeeRegistration({ ...VALID_FORM, contactNumber: 'call me' }),
    ['Contact number must be a valid phone number.'],
  )
})

test('the read-only account email is not checked', () => {
  assert.deepEqual(validateAttendeeRegistration({ ...VALID_FORM, email: '' }), [])
})

test('the payload is trimmed, uses the API field names and leaves out the email', () => {
  assert.deepEqual(
    registrationToPayload({ ...VALID_FORM, fullName: '  Cara Ng ' }),
    {
      full_name: 'Cara Ng',
      contact_number: '+65 9123 4567',
    },
  )
})

test('a blank contact number is sent as none', () => {
  assert.equal(registrationToPayload({ ...VALID_FORM, contactNumber: '  ' }).contact_number, null)
})
