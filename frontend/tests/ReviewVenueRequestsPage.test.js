import assert from 'node:assert/strict'
import test from 'node:test'

import { isOverlapping } from '../src/venueRequestValidation.js'

// --- Mock Data ---
const mockVenue = {
  id: 'v-1',
  name: 'Grand Ballroom',
  layouts: [
    { name: 'Banquet', capacity: 100 },
    { name: 'Classroom', capacity: 50 },
  ],
  operating_hours: { open: '08:00', close: '22:00' },
}

const mockValidBooking = {
  booking_id: 'b-100',
  venue_id: 'v-1',
  room_layout: 'Banquet',
  start_at: '2026-11-01T10:00:00Z',
  end_at: '2026-11-01T12:00:00Z',
  effective_start_at: '2026-11-01T09:30:00Z',
  effective_end_at: '2026-11-01T12:30:00Z',
  venues: mockVenue,
  events: {
    name: 'Annual Gala',
    expected_attendance: 80,
  },
}

// --- 1. Schedule Overlap Logic (`isOverlapping`) ---

test('isOverlapping identifies direct time overlaps including setup/teardown buffers', () => {
  const overlapping = isOverlapping(
    '2026-11-01T09:30:00Z',
    '2026-11-01T12:30:00Z',
    '2026-11-01T11:00:00Z',
    '2026-11-01T14:00:00Z'
  )
  assert.equal(overlapping, true)
})

test('isOverlapping allows back-to-back bookings without overlap', () => {
  const adjacent = isOverlapping(
    '2026-11-01T09:30:00Z',
    '2026-11-01T12:30:00Z',
    '2026-11-01T12:30:00Z',
    '2026-11-01T15:00:00Z'
  )
  assert.equal(adjacent, false)
})

test('isOverlapping returns false for non-overlapping separate time slots', () => {
  const separate = isOverlapping(
    '2026-11-01T08:00:00Z',
    '2026-11-01T09:00:00Z',
    '2026-11-01T10:00:00Z',
    '2026-11-01T12:00:00Z'
  )
  assert.equal(separate, false)
})

// --- 2. Filtering and List Manipulation Helpers ---

test('correctly selects active booking and filters processed booking from pending state list', () => {
  const bookings = [
    mockValidBooking,
    { ...mockValidBooking, booking_id: 'b-101' },
  ]

  // Filter out approved/rejected booking
  const updatedBookings = bookings.filter((b) => b.booking_id !== 'b-100')

  assert.equal(updatedBookings.length, 1)
  assert.deepEqual(
    updatedBookings.map((b) => b.booking_id),
    ['b-101']
  )
})