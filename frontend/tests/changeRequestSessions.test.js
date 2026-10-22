import assert from 'node:assert/strict'
import test from 'node:test'

import {
  changeSessionToPayload,
  sessionChanges,
  sessionsForChange,
  validateChangeSessions,
} from '../src/changeRequestSessions.js'

const NOW = new Date('2026-12-01T00:00:00Z')
const saved = [
  { id: 'later', name: 'Breakout A', start_time: '2026-12-15T09:00:00Z', end_time: '2026-12-15T12:00:00Z', expected_attendance: 40 },
  { id: 'started', name: 'Opening', start_time: '2026-11-30T09:00:00Z', end_time: '2026-12-20T12:00:00Z', expected_attendance: 100 },
]

test('sessions open in time order and keep their ids', () => {
  const sessions = sessionsForChange(saved, NOW)
  assert.deepEqual(sessions.map((session) => session.id), ['started', 'later'])
})

test('sessions that have already started are locked', () => {
  const sessions = sessionsForChange(saved, NOW)
  assert.deepEqual(sessions.map((session) => session.locked), [true, false])
})

test('the payload says which session is edited, and null for new ones', () => {
  const [, later] = sessionsForChange(saved, NOW)
  assert.equal(changeSessionToPayload(later).session_id, 'later')
  assert.equal(changeSessionToPayload({ ...later, id: undefined }).session_id, null)
  assert.equal(changeSessionToPayload(later).expected_attendance, 40)
})

test('a locked session in the past does not fail validation', () => {
  const sessions = sessionsForChange(saved, NOW)
  assert.equal(validateChangeSessions(sessions, NOW), null)
})

test('an editable session moved into the past is refused', () => {
  const [opening, later] = sessionsForChange(saved, NOW)
  const moved = { ...later, startTime: '2026-11-01T09:00', endTime: '2026-11-01T10:00' }
  assert.match(validateChangeSessions([opening, moved], NOW), /Start time must be in the future/)
})

test('at least one session must be kept', () => {
  assert.equal(validateChangeSessions([], NOW), 'Keep at least one session.')
})

const current = [
  { id: 'main', name: 'Main programme', start_time: '2026-12-15T01:00:00Z', end_time: '2026-12-15T09:00:00Z', expected_attendance: 300, location_preference: null },
  { id: 'a', name: 'Breakout A', start_time: '2026-12-15T01:00:00Z', end_time: '2026-12-15T09:00:00Z', expected_attendance: 50 },
]

test('an unchanged proposal has no session changes', () => {
  const proposed = current.map((session) => ({ ...session, session_id: session.id, location_preference: '' }))
  assert.deepEqual(sessionChanges(current, proposed), { added: [], removed: [], edited: [] })
})

test('edited sessions list only the fields that changed', () => {
  const proposed = [
    { ...current[0], session_id: 'main', start_time: '2026-12-15T05:00:00.000Z', expected_attendance: 250 },
    { ...current[1], session_id: 'a' },
  ]
  const { edited } = sessionChanges(current, proposed)
  assert.equal(edited.length, 1)
  assert.equal(edited[0].session.id, 'main')
  assert.deepEqual(edited[0].fields.map((field) => field.key), ['start_time', 'expected_attendance'])
  assert.equal(edited[0].fields[1].before, 300)
  assert.equal(edited[0].fields[1].after, 250)
})

test('sessions without an id are added and missing ones are removed', () => {
  const proposed = [
    { ...current[0], session_id: 'main' },
    { session_id: null, name: 'Breakout B', start_time: '2026-12-15T01:00:00Z', end_time: '2026-12-15T03:00:00Z', expected_attendance: 30 },
  ]
  const { added, removed } = sessionChanges(current, proposed)
  assert.deepEqual(added.map((session) => session.name), ['Breakout B'])
  assert.deepEqual(removed.map((session) => session.id), ['a'])
})
