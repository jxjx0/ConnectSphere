import assert from 'node:assert/strict'
import test from 'node:test'

import { isOverlapping, validateBookingRequest } from '../src/venueRequestValidation.js'

// --- Mock Data ---
const mockVenue = {
  id: 'v-1',
  name: 'Grand Ballroom',
  layouts: {
    Banquet: 100,
    Classroom: 50,
  },
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
    '2026-11-01T09:30:00Z', // Request start (with setup buffer)
    '2026-11-01T12:30:00Z', // Request end (with teardown buffer)
    '2026-11-01T11:00:00Z', // Existing block start
    '2026-11-01T14:00:00Z'  // Existing block end
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

// --- 2. Venue Profile & Capacity Validation (`validateBookingRequest`) ---

test('validateBookingRequest returns null when booking meets layout and capacity requirements', () => {
  const result = validateBookingRequest(mockValidBooking)
  assert.equal(result, null)
})

test('validateBookingRequest returns error when venue lacks requested layout', () => {
  const invalidLayoutBooking = {
    ...mockValidBooking,
    room_layout: 'Theater',
  }
  const result = validateBookingRequest(invalidLayoutBooking)
  assert.equal(result, "The venue does not support the requested layout 'Theater'.")
})

test('validateBookingRequest returns error when expected attendance exceeds max capacity for layout', () => {
  const overCapacityBooking = {
    ...mockValidBooking,
    events: { name: 'Mega Gala', expected_attendance: 150 },
  }
  const result = validateBookingRequest(overCapacityBooking)
  assert.equal(
    result,
    'Expected attendance (150) exceeds maximum venue capacity (100) for layout \'Banquet\'.'
  )
})

test('validateBookingRequest falls back to direct expected_attendance when events object is missing', () => {
  const bookingWithDirectAttendance = {
    room_layout: 'Classroom',
    expected_attendance: 60,
    venues: mockVenue,
  }
  const result = validateBookingRequest(bookingWithDirectAttendance)
  assert.equal(
    result,
    'Expected attendance (60) exceeds maximum venue capacity (50) for layout \'Classroom\'.'
  )
})

test('validateBookingRequest handles missing venue profile safely', () => {
  const result = validateBookingRequest({ room_layout: 'Banquet' })
  assert.equal(result, null)
})

// --- 3. Filtering and List Manipulation Helpers ---

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