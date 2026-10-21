import assert from 'node:assert/strict'
import test from 'node:test'

import {
  emptySession,
  sessionFromSaved,
  sessionToPayload,
  sortSessionsByStart,
  validateSessions,
} from '../src/eventSessions.js'

const NOW = new Date('2026-10-21T09:00:00')

function session(overrides = {}) {
  return {
    ...emptySession(),
    name: 'Main programme',
    startTime: '2026-11-03T09:00',
    endTime: '2026-11-03T17:00',
    expectedAttendance: '300',
    ...overrides,
  }
}

// --- Validation -------------------------------------------------------------

test('a complete future session passes', () => {
  assert.equal(validateSessions([session()], NOW), null)
})

test('an event needs at least one session', () => {
  assert.equal(validateSessions([], NOW), 'Add at least one session.')
})

test('sessions may run at the same time, for parallel rooms', () => {
  const sessions = [session(), session({ name: 'Breakout A' })]
  assert.equal(validateSessions(sessions, NOW), null)
})

test('an unnamed session is called by its place on the form', () => {
  const sessions = [session(), session({ name: '  ' })]
  assert.equal(
    validateSessions(sessions, NOW),
    'Session 2: Give every session a name.',
  )
})

test('a session needs both times', () => {
  assert.equal(
    validateSessions([session({ endTime: '' })], NOW),
    'Main programme: Start and end times are required.',
  )
})

test('a session must end after it starts', () => {
  assert.equal(
    validateSessions([session({ endTime: '2026-11-03T09:00' })], NOW),
    'Main programme: End time must be after the start time.',
  )
})

test('every session must start in the future', () => {
  const sessions = [
    session(),
    session({
      name: 'Breakout A',
      startTime: '2026-10-20T09:00',
      endTime: '2026-10-20T10:00',
    }),
  ]
  assert.equal(
    validateSessions(sessions, NOW),
    'Breakout A: Start time must be in the future.',
  )
})

test('a session needs a positive attendance', () => {
  assert.equal(
    validateSessions([session({ expectedAttendance: '0' })], NOW),
    'Main programme: Expected attendance must be a positive number.',
  )
})

// --- Converting to and from the backend --------------------------------------

test('empty inputs are sent as null', () => {
  const payload = sessionToPayload(emptySession())
  assert.equal(payload.start_time, null)
  assert.equal(payload.end_time, null)
  assert.equal(payload.expected_attendance, null)
})

test('the form-only key is never sent to the backend', () => {
  assert.equal('formKey' in sessionToPayload(session()), false)
})

test('a saved session round-trips through the form', () => {
  const saved = {
    id: 'session-1',
    event_id: 'event-1',
    name: 'Breakout A',
    start_time: new Date('2026-11-03T09:00').toISOString(),
    end_time: new Date('2026-11-03T12:00').toISOString(),
    expected_attendance: 50,
    location_preference: null,
    layout_preference: 'Classroom',
    equipment_requirements: 'Projector',
  }

  const form = sessionFromSaved(saved)
  assert.equal(form.startTime, '2026-11-03T09:00')
  assert.equal(form.expectedAttendance, '50')
  assert.equal(form.locationPreference, '')

  const payload = sessionToPayload(form)
  assert.equal(payload.start_time, saved.start_time)
  assert.equal(payload.expected_attendance, 50)
  assert.equal(payload.layout_preference, 'Classroom')
})

test('each new session gets its own form key', () => {
  assert.notEqual(emptySession().formKey, emptySession().formKey)
})

// --- Ordering ----------------------------------------------------------------

test('sessions are sorted by start time, unscheduled ones last', () => {
  const sessions = [
    session({ name: 'Unscheduled', startTime: '' }),
    session({ name: 'Afternoon', startTime: '2026-11-03T13:00' }),
    session({ name: 'Morning', startTime: '2026-11-03T09:00' }),
  ]

  assert.deepEqual(
    sortSessionsByStart(sessions).map((item) => item.name),
    ['Morning', 'Afternoon', 'Unscheduled'],
  )
  assert.equal(sessions[0].name, 'Unscheduled', 'the original is not reordered')
})
