import assert from 'node:assert/strict'
import test from 'node:test'

import { isOverlapping, validateBookingRequest } from '../src/venueRequestValidation.js'

// --- 1. isOverlapping Tests ---

test('detects overlapping time ranges', () => {
  const overlapping = isOverlapping(
    '2026-11-01T10:00:00Z',
    '2026-11-01T12:00:00Z',
    '2026-11-01T11:00:00Z',
    '2026-11-01T13:00:00Z'
  )
  assert.equal(overlapping, true)
})

test('detects adjacent time ranges as non-overlapping', () => {
  const adjacent = isOverlapping(
    '2026-11-01T10:00:00Z',
    '2026-11-01T12:00:00Z',
    '2026-11-01T12:00:00Z',
    '2026-11-01T14:00:00Z'
  )
  assert.equal(adjacent, false)
})

test('detects completely distinct time ranges as non-overlapping', () => {
  const distinct = isOverlapping(
    '2026-11-01T10:00:00Z',
    '2026-11-01T12:00:00Z',
    '2026-11-01T13:00:00Z',
    '2026-11-01T15:00:00Z'
  )
  assert.equal(distinct, false)
})

// --- 2. validateBookingRequest Tests ---

test('returns null when booking has no venue data', () => {
  const result = validateBookingRequest({})
  assert.equal(result, null)
})

test('returns error when venue does not support requested layout', () => {
  const booking = {
    room_layout: 'Theater',
    venues: {
      layouts: { Banquet: 100 },
    },
  }
  const result = validateBookingRequest(booking)
  assert.equal(result, "The venue does not support the requested layout 'Theater'.")
})

test('returns error when expected attendance exceeds capacity', () => {
  const booking = {
    room_layout: 'Banquet',
    events: { expected_attendance: 150 },
    venues: {
      layouts: { Banquet: 100 },
    },
  }
  const result = validateBookingRequest(booking)
  assert.equal(
    result,
    'Expected attendance (150) exceeds maximum venue capacity (100) for layout \'Banquet\'.'
  )
})

test('uses fallback booking attendance when events object is missing', () => {
  const booking = {
    room_layout: 'Banquet',
    expected_attendance: 120,
    venues: {
      layouts: { Banquet: 100 },
    },
  }
  const result = validateBookingRequest(booking)
  assert.equal(
    result,
    'Expected attendance (120) exceeds maximum venue capacity (100) for layout \'Banquet\'.'
  )
})

test('defaults attendance to 0 when unprovided and passes validation', () => {
  const booking = {
    room_layout: 'Banquet',
    venues: {
      layouts: { Banquet: 100 },
    },
  }
  const result = validateBookingRequest(booking)
  assert.equal(result, null)
})

test('returns null when layout and attendance are within limits', () => {
  const booking = {
    room_layout: 'Banquet',
    events: { expected_attendance: 50 },
    venues: {
      layouts: { Banquet: 100 },
    },
  }
  const result = validateBookingRequest(booking)
  assert.equal(result, null)
})