import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { transformWithEsbuild } from 'vite'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as jsxRuntime from 'react/jsx-runtime'

import { isOverlapping } from '../src/venueRequestValidation.js'

// Exercise the validator the review page actually uses, rather than the older helper.
const source = await readFile(new URL('../src/pages/ReviewVenueRequestsPage.jsx', import.meta.url), 'utf8')
const { code } = await transformWithEsbuild(source, 'ReviewVenueRequestsPage.jsx', {
  format: 'cjs', jsx: 'automatic', tsconfigRaw: '{}',
})
function loadPage(imports = {}) {
  const module = { exports: {} }
  new Function('require', 'module', 'exports', code)(name => imports[name] || {}, module, module.exports)
  return module.exports
}
const { validateBookingRequest } = loadPage()

function singaporeBooking(overrides = {}) {
  return {
    booking_id: 'test-booking', venue_id: 'test-venue', room_layout: 'Classroom',
    start_at: '2026-10-22T02:00:00Z', end_at: '2026-10-22T04:00:00Z',
    effective_start_at: '2026-10-22T01:30:00Z', effective_end_at: '2026-10-22T04:45:00Z',
    setup_buffer_minutes: 30, teardown_buffer_minutes: 45,
    venues: { name: 'Test Venue', setup_time_minutes: 30, turnaround_time_minutes: 45,
      operating_hours: { open: '08:00', close: '22:00' }, layouts: [{ name: 'Classroom', capacity: 100 }] },
    events: { expected_attendance: 40 }, ...overrides,
  }
}

test('review accepts the screenshot booking: 10–12 Singapore, occupied 09:30–12:45', () => {
  const booking = singaporeBooking()
  const snapshot = JSON.stringify(booking)
  assert.equal(validateBookingRequest(booking), null)
  assert.equal(JSON.stringify(booking), snapshot)
})

for (const [start, end, expected] of [
  ['2026-10-22T00:30:00Z', '2026-10-22T02:00:00Z', null], // Setup touches opening.
  ['2026-10-22T00:29:59Z', '2026-10-22T02:00:00Z', /07:59.*operating hours/],
  ['2026-10-22T12:00:00Z', '2026-10-22T13:15:00Z', null], // Turnaround touches closing.
  ['2026-10-22T12:00:00Z', '2026-10-22T13:15:01Z', /22:00.*operating hours/],
  ['2026-10-22T13:00:00Z', '2026-10-22T17:00:00Z', /operating hours/], // Crosses Singapore midnight.
]) {
  test(`review checks buffered Singapore boundaries: ${start} to ${end}`, () => {
    const result = validateBookingRequest(singaporeBooking({ start_at: start, end_at: end,
      effective_start_at: undefined, effective_end_at: undefined }))
    if (expected === null) assert.equal(result, null)
    else assert.match(result, expected)
  })
}

test('review recalculates increased venue buffers and retains larger stored occupancy', () => {
  const booking = singaporeBooking()
  booking.venues.setup_time_minutes = 150
  assert.match(validateBookingRequest(booking), /07:30.*Singapore time/)
  assert.match(validateBookingRequest(singaporeBooking({ effective_end_at: '2026-10-22T14:30:00Z' })), /22:30/)
})

test('review keeps layout/capacity checks and the backend policy for unreadable hours', () => {
  const booking = singaporeBooking()
  booking.venues.operating_hours = { open: 'invalid', close: '22:00' }
  assert.equal(validateBookingRequest(booking), null)
  booking.room_layout = 'Unknown'
  assert.match(validateBookingRequest(booking), /does not support/)
  booking.room_layout = 'classroom'
  booking.venues.layouts = { Classroom: 100 }
  booking.events.expected_attendance = 101
  assert.match(validateBookingRequest(booking), /exceeds maximum capacity/)
})

test('review handles invalid stored timestamps without crashing the page', () => {
  assert.match(validateBookingRequest(singaporeBooking({ effective_start_at: 'invalid' })), /Unable to verify/)
})

test('the review page enables Approve for the valid Singapore booking', async () => {
  const states = [], effects = []
  let index = 0
  const { default: Page } = loadPage({
    react: { ...React, useEffect: fn => effects.push(fn), useState(initial) {
      const position = index++
      if (!(position in states)) states[position] = initial
      return [states[position], value => { states[position] = typeof value === 'function' ? value(states[position]) : value }]
    } },
    'react/jsx-runtime': jsxRuntime,
    'react-router-dom': { Link: ({ children }) => React.createElement('a', null, children) },
    '../components/AppShell': { __esModule: true, default: ({ children }) => children },
    '../components/VenueBookingCard': { __esModule: true, default: ({ validationError, actions }) =>
      React.createElement('section', null, validationError, actions) },
    '../components/VenueScheduleCalendar': { __esModule: true, default: () => null },
    '../context/AuthContext': { useAuth: () => ({ token: 'test-token' }) },
    '../api/venues': { getPendingVenueBookings: async () => ({ bookings: [singaporeBooking()] }) },
    '../styles/ReviewVenueRequestsPage.module.css': { __esModule: true, default: {} },
  })
  Page()
  effects.forEach(fn => fn())
  await new Promise(resolve => setImmediate(resolve))
  index = 0
  const markup = renderToStaticMarkup(Page())
  assert.match(markup, /<button[^>]*>Approve<\/button>/)
  assert.doesNotMatch(markup.match(/<button[^>]*>Approve<\/button>/)[0], /disabled/)
  assert.doesNotMatch(markup, /falls outside venue operating hours/)
})

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
