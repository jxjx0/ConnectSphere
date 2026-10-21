import assert from 'node:assert/strict'
import test from 'node:test'

import { formatSessionSummary, sessionsOf } from '../src/eventDisplay.js'

const EVENT = {
  id: 'event-1',
  start_time: '2026-12-07T01:00:00+00:00',
  end_time: '2026-12-07T09:00:00+00:00',
  expected_attendance: 300,
  location_preference: 'Near an MRT station',
  layout_preference: 'Theatre',
  equipment_requirements: 'Projector',
}

test('an event shows its saved sessions', () => {
  const sessions = [{ id: 's1', name: 'Main programme' }, { id: 's2', name: 'Breakout A' }]
  assert.deepEqual(sessionsOf({ ...EVENT, sessions }), sessions)
})

test('an event without sessions shows its own details as one session', () => {
  const [session] = sessionsOf({ ...EVENT, sessions: [] })
  assert.equal(session.name, 'Main session')
  assert.equal(session.start_time, EVENT.start_time)
  assert.equal(session.expected_attendance, 300)
  assert.equal(session.layout_preference, 'Theatre')
})

test('several sessions read as a count and the largest attendance', () => {
  const sessions = [{ id: 's1' }, { id: 's2' }, { id: 's3' }, { id: 's4' }]
  assert.equal(
    formatSessionSummary({ ...EVENT, sessions }),
    '4 sessions · up to 300 attendees',
  )
})

test('one session reads without "up to"', () => {
  assert.equal(
    formatSessionSummary({ ...EVENT, sessions: [{ id: 's1' }] }),
    '1 session · 300 attendees',
  )
})
