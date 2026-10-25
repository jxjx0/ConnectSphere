import assert from 'node:assert/strict'
import test from 'node:test'

import { CANCELLABLE_STATUSES, progressFor } from '../src/eventDisplay.js'

test('cancellation requests are available only at the specified event stages', () => {
  assert.deepEqual(CANCELLABLE_STATUSES, [
    'planning',
    'awaiting_safety_check',
    'confirmed',
    'awaiting_clarification',
    'change_requested',
  ])
  for (const status of [
    'under_review', 'cancellation_requested', 'completed', 'rejected',
    'cancelled', 'draft',
  ]) {
    assert.equal(CANCELLABLE_STATUSES.includes(status), false)
  }
})

test('cancellation request progress tells the Organiser it is awaiting review', () => {
  assert.equal(
    progressFor('cancellation_requested').notice,
    'Your cancellation request is waiting for your Coordinator.',
  )
  assert.equal(progressFor('cancelled').notice, 'This event has been cancelled.')
})
