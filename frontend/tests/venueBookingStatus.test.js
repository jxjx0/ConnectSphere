import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { transformWithEsbuild } from 'vite'
import * as jsxRuntime from 'react/jsx-runtime'
import * as display from '../src/eventDisplay.js'
import * as categories from '../src/eventCategories.js'

async function compile(path, imports = {}) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8')
  const { code } = await transformWithEsbuild(source, path, { format: 'cjs', jsx: 'automatic', tsconfigRaw: '{}' })
  const module = { exports: {} }
  const dependencies = { react: React, 'react/jsx-runtime': jsxRuntime, '../eventDisplay': display, ...imports }
  new Function('require', 'module', 'exports', code)(name => {
    assert.ok(name in dependencies, `unexpected dependency: ${name}`)
    return dependencies[name]
  }, module, module.exports)
  return module.exports.default
}
const link = ({ to, children, ...props }) => React.createElement('a', { ...props, href: to }, children)
const event = { id: 'event-1', name: 'Workshop', category: 'workshop', status: 'planning',
  start_time: '2099-11-07T10:00:00Z', end_time: '2099-11-07T12:00:00Z', expected_attendance: 40 }
const affected = { booking_id: 'booking-1', status: 'AFFECTED_BY_UNAVAILABILITY', venues: { name: 'Hall' },
  start_at: event.start_time, end_at: event.end_time, created_at: event.start_time, room_layout: 'Classroom' }

test('affected venue booking has a clear label without changing other status labels', () => {
  assert.equal(display.readableStatus(affected.status), 'Affected by venue unavailability')
  assert.equal(display.readableStatus('APPROVED'), 'APPROVED')
  assert.equal(display.readableStatus('planning'), 'Planning')
})

test('existing booking card explains original approval and alternative arrangements', async () => {
  const Card = await compile('../src/components/VenueBookingCard.jsx', {
    './VenueBookingCard.module.css': { default: {}, __esModule: true },
  })
  const markup = renderToStaticMarkup(React.createElement(Card, { booking: affected }))
  assert.match(markup, /Affected by venue unavailability/)
  assert.match(markup, /Originally approved/)
  assert.match(markup, /Please arrange another venue/)
  assert.doesNotMatch(markup, /Rejection Reason|Find replacement/)
})

test('dashboard flags an affected venue even when another venue remains approved', async () => {
  const Tabs = await compile('../src/components/AssignedRequestTabs.jsx', {
    'react-router-dom': { Link: link, useSearchParams: () => [new URLSearchParams('tab=planning'), () => {}] },
  })
  const value = { ...event, venue_bookings: [affected, { status: 'APPROVED' }] }
  const markup = renderToStaticMarkup(React.createElement(Tabs, { events: [value] }))
  assert.match(markup, /Venue Affected/)
  assert.doesNotMatch(markup, /Venue Approved|Venue Rejected|Venue Pending/)
  assert.equal(value.venue_bookings[1].status, 'APPROVED')
})

test('Coordinator event page shows stored affected status and retains other approved venues', async () => {
  const states = [], effects = []
  let index = 0
  const other = { ...affected, booking_id: 'booking-2', status: 'APPROVED', venues: { name: 'Other Hall' } }
  const bookings = [affected, other]
  const snapshot = JSON.stringify({ event, bookings })
  const Page = await compile('../src/pages/EventReviewDetailPage.jsx', {
    react: { ...React, useEffect: fn => effects.push(fn), useState(initial) {
      const position = index++
      if (!(position in states)) states[position] = initial
      return [states[position], value => { states[position] = typeof value === 'function' ? value(states[position]) : value }]
    } },
    'react-router-dom': { Link: link, useParams: () => ({ eventId: event.id }) },
    '../eventCategories': categories,
    '../context/AuthContext': { useAuth: () => ({ token: 'token' }) },
    '../components/AppShell': { default: ({ children }) => React.createElement('main', null, children), __esModule: true },
    '../api/events': {
      getAssignedEventRequest: async () => ({ event, organiser: null }),
      getEventActivityLogs: async () => ({ logs: [] }),
      getAssignedEventClarifications: async () => ({ clarifications: [] }),
    },
    '../api/venues': { getVenueBookingsForEvent: async () => ({ bookings }) },
  })
  Page()
  effects.forEach(fn => fn())
  await new Promise(resolve => setImmediate(resolve))
  index = 0
  const markup = renderToStaticMarkup(Page())
  assert.equal((markup.match(/Affected by venue unavailability/g) || []).length, 1)
  assert.match(markup, /Originally approved/)
  assert.match(markup, /Other Hall/)
  assert.match(markup, />APPROVED<\/span>/)
  assert.equal(JSON.stringify({ event, bookings }), snapshot)
})
