import assert from 'node:assert/strict'
import test from 'node:test'

import {
  REGISTRATION_STATUSES,
  largestAllowedCapacity,
  pendingItems,
  previewSessions,
  registrationFormFrom,
  registrationHasClosed,
  registrationToPayload,
  sessionCapacityNotes,
  signUpSummary,
  totalExpectedAttendance,
  validateRegistration,
} from '../src/eventRegistration.js'

test('completed events cannot open registration setup', () => {
  assert.equal(REGISTRATION_STATUSES.includes('completed'), false)
})

test('the sign-up count is shown against the attendee capacity', () => {
  assert.equal(signUpSummary(42, 120), '42 of 120')
})

test('no sign-ups yet still shows a count, not an empty value', () => {
  assert.equal(signUpSummary(0, 120), '0 of 120')
})

test('without a capacity the sign-up count stands alone', () => {
  assert.equal(signUpSummary(7, null), '7')
})

const SESSION = {
  id: 'session-1',
  name: 'Main programme',
  start_time: '2026-12-01T09:00:00',
  end_time: '2026-12-01T17:00:00',
  expected_attendance: 150,
}

function event(overrides = {}) {
  return {
    id: 'event-1',
    status: 'confirmed',
    start_time: SESSION.start_time,
    expected_attendance: 150,
    sessions: [SESSION],
    ...overrides,
  }
}

const APPROVED_VENUE = {
  kind: 'venue',
  session_id: 'session-1',
  status: 'APPROVED',
  venue_name: 'Community Hall',
  venue_location: 'Campus West',
  venue_capacity: 120,
}

function form(overrides = {}) {
  return {
    opensAt: '2026-11-01T09:00',
    closesAt: '2026-11-20T17:00',
    capacity: '100',
    ...overrides,
  }
}

// --- Capacity and pre-filling ----------------------------------------------

const BREAKOUT = { ...SESSION, id: 'session-2', name: 'Breakout', expected_attendance: 60 }
const BREAKOUT_VENUE = { ...APPROVED_VENUE, session_id: 'session-2', venue_name: 'Room 2', venue_capacity: 80 }
const twoSessions = (overrides = {}) => event({ sessions: [SESSION, BREAKOUT], ...overrides })

test("every session's approved venue adds to the capacity limit", () => {
  assert.equal(largestAllowedCapacity(twoSessions(), [APPROVED_VENUE, BREAKOUT_VENUE]), 200)
})

test('there is no venue limit until every session has an approved venue', () => {
  assert.equal(largestAllowedCapacity(event(), []), null)
  assert.equal(largestAllowedCapacity(twoSessions(), [APPROVED_VENUE]), null)
  assert.equal(
    largestAllowedCapacity(twoSessions(), [
      APPROVED_VENUE,
      { ...BREAKOUT_VENUE, status: 'PENDING_VENUE_APPROVAL' },
    ]),
    null,
  )
})

test('expected attendance is added up across the sessions', () => {
  assert.equal(totalExpectedAttendance(twoSessions()), 210)
  assert.equal(
    totalExpectedAttendance(twoSessions({
      sessions: [SESSION, { ...BREAKOUT, expected_attendance: null }],
    })),
    150,
  )
})

test('an event without sessions uses its own expected attendance', () => {
  assert.equal(totalExpectedAttendance(event({ sessions: [] })), 150)
})

test('a new registration suggests the total expected attendance, within the venues', () => {
  assert.deepEqual(registrationFormFrom(twoSessions(), [APPROVED_VENUE, BREAKOUT_VENUE]), {
    opensAt: '',
    closesAt: '',
    capacity: '200',
  })
  assert.equal(registrationFormFrom(twoSessions(), []).capacity, '210')
  assert.equal(
    registrationFormFrom(twoSessions(), [
      { ...APPROVED_VENUE, venue_capacity: 500 },
      { ...BREAKOUT_VENUE, venue_capacity: 500 },
    ]).capacity,
    '210',
  )
})

test('capacity starts blank when there is nothing to suggest', () => {
  const noNumbers = event({ sessions: [{ ...SESSION, expected_attendance: null }] })
  assert.equal(registrationFormFrom(noNumbers, []).capacity, '')
  assert.equal(registrationFormFrom(noNumbers, [APPROVED_VENUE]).capacity, '')
})

test('saved settings are shown for editing', () => {
  const saved = event({
    registration_opens_at: '2026-11-01T09:00:00',
    registration_closes_at: '2026-11-20T17:00:00',
    attendee_capacity: 90,
  })
  assert.deepEqual(registrationFormFrom(saved, [APPROVED_VENUE]), form({ capacity: '90' }))
})

test('registration has closed once its closing time has passed', () => {
  const now = new Date('2026-11-21T00:00:00')
  assert.equal(registrationHasClosed(event(), now), false)
  assert.equal(
    registrationHasClosed(event({ registration_closes_at: '2026-11-20T17:00:00' }), now),
    true,
  )
})

// --- Validation -------------------------------------------------------------

test('a complete registration passes', () => {
  assert.equal(validateRegistration(form(), event(), [APPROVED_VENUE]), null)
})

test('both dates are required', () => {
  assert.equal(validateRegistration(form({ opensAt: '' }), event(), []), 'Choose when registration opens.')
  assert.equal(validateRegistration(form({ closesAt: '' }), event(), []), 'Choose when registration closes.')
})

test('registration must close after it opens', () => {
  const message = 'Registration must close after it opens.'
  assert.equal(validateRegistration(form({ closesAt: '2026-11-01T09:00' }), event(), []), message)
  assert.equal(validateRegistration(form({ closesAt: '2026-10-30T09:00' }), event(), []), message)
})

test('registration must close before the event starts', () => {
  assert.equal(
    validateRegistration(form({ closesAt: '2026-12-01T10:00' }), event(), []),
    'Registration must close before the event starts.',
  )
})

test('capacity must be a positive whole number within the combined venues', () => {
  const message = 'Attendee capacity must be a whole number above 0.'
  assert.equal(validateRegistration(form({ capacity: '0' }), event(), []), message)
  assert.equal(validateRegistration(form({ capacity: '12.5' }), event(), []), message)
  const venues = [APPROVED_VENUE, BREAKOUT_VENUE]
  assert.equal(validateRegistration(form({ capacity: '200' }), twoSessions(), venues), null)
  assert.equal(
    validateRegistration(form({ capacity: '201' }), twoSessions(), venues),
    "Attendee capacity cannot exceed 200, the combined capacity of the sessions' venues.",
  )
})

test('the payload sends times as UTC and capacity as a number', () => {
  const payload = registrationToPayload(form(), true)
  assert.equal(payload.registration_opens_at, new Date('2026-11-01T09:00').toISOString())
  assert.equal(payload.attendee_capacity, 100)
  assert.equal(payload.publish, true)
})

// --- Preview ----------------------------------------------------------------

test('the preview shows each session with its venue', () => {
  const [session] = previewSessions(event(), [APPROVED_VENUE])
  assert.equal(session.venueName, 'Community Hall')
  assert.equal(session.venueLocation, 'Campus West')
  assert.equal(session.venueCapacity, 120)
  assert.equal(session.venueConfirmed, true)
})

test('a session with no venue yet is shown without one', () => {
  const [session] = previewSessions(event(), [])
  assert.equal(session.venueName, null)
  assert.equal(session.venueLocation, null)
  assert.equal(session.venueCapacity, null)
  assert.equal(session.venueConfirmed, false)
})

test("each session's venue capacity is listed for reference", () => {
  const sessions = previewSessions(twoSessions(), [
    APPROVED_VENUE,
    { ...BREAKOUT_VENUE, status: 'PENDING_VENUE_APPROVAL' },
  ])
  assert.deepEqual(sessionCapacityNotes(sessions), [
    'Main programme: up to 120 at Community Hall',
    'Breakout: up to 80 at Room 2 (pending approval)',
  ])
})

test('a session without a venue is left out of the capacity reference', () => {
  assert.deepEqual(sessionCapacityNotes(previewSessions(event(), [])), [])
})

test('a confirmed event with everything approved has nothing pending', () => {
  const arrangements = [
    APPROVED_VENUE,
    { kind: 'equipment', session_id: 'session-1', status: 'Approved' },
  ]
  assert.deepEqual(pendingItems(event(), arrangements), [])
})

test('pending venue, equipment and confirmation are each listed', () => {
  const arrangements = [
    { ...APPROVED_VENUE, status: 'PENDING_VENUE_APPROVAL' },
    { kind: 'equipment', session_id: 'session-1', status: 'Pending Technical Approval' },
  ]
  assert.deepEqual(pendingItems(event({ status: 'planning' }), arrangements), [
    'Main programme: venue booking is pending venue approval.',
    'Main programme: equipment is pending technical approval.',
    'The Safety Officer has not approved the event yet.',
  ])
})

test('equipment requested for the whole event is listed too', () => {
  const arrangements = [
    APPROVED_VENUE,
    { kind: 'equipment', session_id: null, status: 'Affected by Session Change' },
  ]
  assert.deepEqual(pendingItems(event(), arrangements), [
    'Event: equipment is affected by session change.',
  ])
})

test('an event with no equipment requests only needs its venue and safety approval', () => {
  assert.deepEqual(pendingItems(event(), [APPROVED_VENUE]), [])
})

test('a session with no venue booked is listed', () => {
  assert.deepEqual(pendingItems(event(), []), [
    'Main programme: no venue has been booked yet.',
  ])
})
