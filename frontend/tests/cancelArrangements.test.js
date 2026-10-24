import assert from 'node:assert/strict'
import test from 'node:test'

import { canCancelEquipmentRequest, canCancelVenueBooking } from '../src/cancelArrangements.js'

const NOW = new Date('2026-12-01T00:00:00Z')
const event = {
  status: 'planning',
  start_time: '2026-12-15T09:00:00Z',
  sessions: [
    { id: 'future', start_time: '2026-12-15T09:00:00Z' },
    { id: 'started', start_time: '2026-11-30T09:00:00Z' },
  ],
}

test('pending, approved and venue-affected bookings can be cancelled in Planning', () => {
  for (const status of ['PENDING_VENUE_APPROVAL', 'APPROVED', 'AFFECTED_BY_UNAVAILABILITY']) {
    assert.equal(canCancelVenueBooking(event, { status, session_id: 'future' }, NOW), true)
  }
})

test('rejected and cancelled bookings cannot be cancelled', () => {
  for (const status of ['REJECTED', 'REJECTED_BY_SAFETY', 'CANCELLED']) {
    assert.equal(canCancelVenueBooking(event, { status, session_id: 'future' }, NOW), false)
  }
})

test('nothing can be cancelled outside Planning', () => {
  for (const status of ['change_requested', 'confirmed', 'awaiting_safety_check']) {
    const other = { ...event, status }
    assert.equal(canCancelVenueBooking(other, { status: 'APPROVED', session_id: 'future' }, NOW), false)
    assert.equal(canCancelEquipmentRequest(other, { status: 'Approved', session_id: 'future' }, NOW), false)
  }
})

test('a session that has started keeps its booking and equipment', () => {
  assert.equal(canCancelVenueBooking(event, { status: 'APPROVED', session_id: 'started' }, NOW), false)
  assert.equal(canCancelEquipmentRequest(event, { status: 'Approved', session_id: 'started' }, NOW), false)
})

test('bookings without a session use their own start', () => {
  const booking = { status: 'APPROVED', session_id: null, start_at: '2026-11-01T09:00:00Z' }
  assert.equal(canCancelVenueBooking(event, booking, NOW), false)
})

test('pending and approved equipment requests can be cancelled, others cannot', () => {
  assert.equal(canCancelEquipmentRequest(event, { status: 'Pending Technical Approval', session_id: 'future' }, NOW), true)
  assert.equal(canCancelEquipmentRequest(event, { status: 'Approved', session_id: 'future' }, NOW), true)
  assert.equal(canCancelEquipmentRequest(event, { status: 'Rejected', session_id: 'future' }, NOW), false)
  assert.equal(canCancelEquipmentRequest(event, { status: 'Cancelled', session_id: 'future' }, NOW), false)
})
