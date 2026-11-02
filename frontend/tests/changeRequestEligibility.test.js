import assert from 'node:assert/strict'
import test from 'node:test'

import { CHANGEABLE_STATUSES } from '../src/eventDisplay.js'

test('change requests are available from review until the event ends', () => {
  assert.deepEqual(
    CHANGEABLE_STATUSES,
    ['under_review', 'planning', 'awaiting_safety_check', 'confirmed'],
  )
  for (const status of ['draft', 'completed', 'rejected', 'cancelled']) {
    assert.equal(CHANGEABLE_STATUSES.includes(status), false)
  }
})
