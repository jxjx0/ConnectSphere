import assert from 'node:assert/strict'
import test from 'node:test'

import { equipmentRequestEligibleEvents } from '../src/equipmentRequestEligibility.js'

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
