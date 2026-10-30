import assert from 'node:assert/strict'
import test from 'node:test'

import { CANCELLABLE_STATUSES } from '../src/eventDisplay.js'
import { openRequestBadges, progressFor } from '../src/eventStatus.js'

test('cancellation requests are available only at the specified event stages', () => {
  assert.deepEqual(CANCELLABLE_STATUSES, ['planning', 'awaiting_safety_check', 'confirmed'])
  for (const status of ['under_review', 'completed', 'rejected', 'cancelled', 'draft']) {
    assert.equal(CANCELLABLE_STATUSES.includes(status), false)
  }
})

test('a pending cancellation is a badge; the event keeps its stage', () => {
  const event = { status: 'confirmed', has_pending_cancellation_request: true }

  assert.deepEqual(openRequestBadges(event, 'organiser'), [
    { kind: 'cancellation', label: 'Cancellation being reviewed', yourTurn: false },
  ])
  assert.deepEqual(openRequestBadges(event, 'coordinator'), [
    { kind: 'cancellation', label: 'Cancellation to review', yourTurn: true },
  ])
  assert.equal(
    progressFor(event.status).steps.find((step) => step.state === 'current').label,
    'Confirmed',
  )
})

test('a cancelled event leaves the progress bar for a notice', () => {
  assert.deepEqual(progressFor('cancelled'), { steps: [], notice: 'This event was cancelled.' })
})
