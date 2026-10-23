import assert from 'node:assert/strict'
import test from 'node:test'

import {
  equipmentRequestEligibleEvents,
  sessionsWithoutEquipmentRequest,
} from '../src/equipmentRequestEligibility.js'

const events = [
  { id: 'draft', status: 'draft' },
  { id: 'under-review', status: 'under_review' },
  { id: 'rejected', status: 'rejected' },
  { id: 'planning', status: 'planning' },
  { id: 'confirmed', status: 'confirmed' },
  { id: 'completed', status: 'completed' },
]

test('planning and confirmed events are eligible for equipment requests', () => {
  assert.deepEqual(
    equipmentRequestEligibleEvents(events),
    [events[3], events[4]],
  )
})

test('rejected, completed, and undecided events are excluded from requests', () => {
  const eligible = equipmentRequestEligibleEvents(events)
  assert.deepEqual(
    eligible.map((event) => event.status),
    ['planning', 'confirmed'],
  )
})

test('only sessions without an equipment request can get one, in time order', () => {
  const event = {
    id: 'event',
    sessions: [
      { id: 'late', start_time: '2099-01-01T14:00:00Z' },
      { id: 'requested', start_time: '2099-01-01T09:00:00Z' },
      { id: 'early', start_time: '2099-01-01T10:00:00Z' },
    ],
  }
  const requests = [{ event_id: 'event', session_id: 'requested' }]

  assert.deepEqual(
    sessionsWithoutEquipmentRequest(event, requests).map((session) => session.id),
    ['early', 'late'],
  )
})

test('an event with every session requested has none left', () => {
  const event = { id: 'event', sessions: [{ id: 'only' }] }
  assert.deepEqual(sessionsWithoutEquipmentRequest(event, [{ session_id: 'only' }]), [])
})
