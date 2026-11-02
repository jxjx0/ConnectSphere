import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { transformWithEsbuild } from 'vite'
import * as jsxRuntime from 'react/jsx-runtime'
import * as display from '../src/eventDisplay.js'
import * as categories from '../src/eventCategories.js'
import * as eligibility from '../src/equipmentRequestEligibility.js'
import * as cancelRules from '../src/cancelArrangements.js'
import * as changeSessions from '../src/changeRequestSessions.js'
import * as eventStatus from '../src/eventStatus.js'
import * as coordinatorTabs from '../src/coordinatorEventTabs.js'
import * as coordinatorView from '../src/coordinatorEventView.js'
import * as equipmentCatalogue from '../src/equipmentCatalogue.js'

// Shared modules every page may import; the status components are added
// once they are compiled below.
const shared = {
  react: React,
  'react/jsx-runtime': jsxRuntime,
  '../eventDisplay': display,
  '../eventStatus': eventStatus,
  '../coordinatorEventTabs': coordinatorTabs,
  '../coordinatorEventView': coordinatorView,
}

async function compile(path, imports = {}) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8')
  const { code } = await transformWithEsbuild(source, path, { format: 'cjs', jsx: 'automatic', tsconfigRaw: '{}' })
  const module = { exports: {} }
  const dependencies = { ...shared, ...imports }
  new Function('require', 'module', 'exports', code)(name => {
    assert.ok(name in dependencies, `unexpected dependency: ${name}`)
    return dependencies[name]
  }, module, module.exports)
  return module.exports.default
}
shared['../components/EventStatusPanel'] = { default: await compile('../src/components/EventStatusPanel.jsx'), __esModule: true }
shared['../components/RequestHistory'] = { default: await compile('../src/components/RequestHistory.jsx'), __esModule: true }

const equipmentCard = () => compile('../src/components/EquipmentRequestCard.jsx', {
  './VenueBookingCard.module.css': { default: {}, __esModule: true },
  '../equipmentCatalogue': equipmentCatalogue,
})
const link = ({ to, children, ...props }) => React.createElement('a', { ...props, href: to }, children)
const event = { id: 'event-1', name: 'Workshop', category: 'workshop', status: 'planning',
  start_time: '2099-11-07T10:00:00Z', end_time: '2099-11-07T12:00:00Z', expected_attendance: 40,
  sessions: [{ id: 'session-1', name: 'Main session', start_time: '2099-11-07T10:00:00Z',
    end_time: '2099-11-07T12:00:00Z', expected_attendance: 40 }] }
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
    'react-router-dom': { Link: link, useSearchParams: () => [new URLSearchParams('tab=in-progress'), () => {}] },
  })
  const value = { ...event, venue_bookings: [affected, { status: 'APPROVED' }] }
  const markup = renderToStaticMarkup(React.createElement(Tabs, { events: [value] }))
  assert.match(markup, /Venue Affected/)
  assert.doesNotMatch(markup, /Venue Approved|Venue Rejected|Venue Pending/)
  assert.equal(value.venue_bookings[1].status, 'APPROVED')
})

test('Coordinator dashboard shows equipment request status without changing event status', async () => {
  const renderTab = async (tab, events) => {
    const Tabs = await compile('../src/components/AssignedRequestTabs.jsx', {
      'react-router-dom': { Link: link, useSearchParams: () => [new URLSearchParams(`tab=${tab}`), () => {}] },
    })
    return renderToStaticMarkup(React.createElement(Tabs, { events }))
  }
  const pendingEvent = {
    ...event,
    equipment_requests: [{ status: 'Pending Technical Approval' }],
  }
  const approvedEvent = {
    ...event,
    id: 'event-2',
    name: 'Confirmed event',
    status: 'confirmed',
    equipment_requests: [{ status: 'Approved' }],
  }
  // Planning and Confirmed events share the "In progress" tab.
  const inProgress = await renderTab('in-progress', [pendingEvent, approvedEvent])

  assert.match(inProgress, /Equipment Pending/)
  assert.match(inProgress, />Planning<\/span>/)
  assert.match(inProgress, /Equipment Approved/)
  assert.match(inProgress, />Confirmed<\/span>/)
  assert.equal(pendingEvent.status, 'planning')
  assert.equal(approvedEvent.status, 'confirmed')
})

test('Coordinator event page shows stored affected status and retains other approved venues', async () => {
  const states = [], effects = []
  let index = 0
  const other = { ...affected, booking_id: 'booking-2', status: 'APPROVED', venues: { name: 'Other Hall' } }
  const bookings = [affected, other]
  const snapshot = JSON.stringify({ event, bookings })
  const equipmentRequest = {
    event_id: event.id,
    session_id: 'session-1',
    status: 'Pending Technical Approval',
    request_details: 'Two projectors and a wireless microphone',
  }
  let requests = [equipmentRequest]
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
    '../components/SessionList': { default: () => null, __esModule: true },
    '../components/CancelArrangementForm': { default: () => null, __esModule: true },
    '../cancelArrangements': cancelRules,
    '../changeRequestSessions': changeSessions,
    '../api/events': {
      getAssignedEventRequest: async () => ({ event, organiser: null }),
      getEventActivityLogs: async () => ({ logs: [] }),
      getAssignedEventClarifications: async () => ({ clarifications: [] }),
    },
    '../api/venues': { getVenueBookingsForEvent: async () => ({ bookings }) },
    '../api/equipmentRequests': { getEventEquipmentRequests: async () => ({ requests }) },
    '../equipmentRequestEligibility': eligibility,
    '../components/EquipmentRequestCard': { default: await equipmentCard(), __esModule: true },
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
  assert.doesNotMatch(markup, /Request Equipment|Request equipment for this session/)
  assert.match(markup, /Two projectors and a wireless microphone/)
  assert.match(markup, /Needed For:/)
  assert.ok(markup.indexOf('Venue Booking Requests') < markup.indexOf('Equipment requests'))
  assert.ok(markup.indexOf('Equipment requests') < markup.indexOf('Organiser'))
  assert.equal(JSON.stringify({ event, bookings }), snapshot)

  requests = []
  states.length = 0
  effects.length = 0
  index = 0
  Page()
  effects.forEach(fn => fn())
  await new Promise(resolve => setImmediate(resolve))
  index = 0
  const requestMarkup = renderToStaticMarkup(Page())
  assert.match(requestMarkup, /href="\/equipment-requests\?eventId=event-1"/)
  assert.match(requestMarkup, /Request Equipment/)
  assert.match(requestMarkup, /href="\/equipment-requests\?eventId=event-1&amp;sessionId=session-1"/)
})


for (const status of ['under_review', 'confirmed', 'rejected', 'completed']) {
  for (const activeHold of [true, false]) {
    test(`contextual booking journey: ${status}, active hold ${activeHold}`, async () => {
      const states = [], effects = []
      let index = 0
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
    '../components/SessionList': { default: () => null, __esModule: true },
    '../components/CancelArrangementForm': { default: () => null, __esModule: true },
    '../cancelArrangements': cancelRules,
    '../changeRequestSessions': changeSessions,
        '../api/events': {
          getAssignedEventRequest: async () => ({ event: { ...event, status }, organiser: null }),
          getAssignedEventClarifications: async () => ({ clarifications: [] }),
        },
        '../api/venues': { getVenueBookingsForEvent: async () => ({ bookings: [], has_active_venue_hold: activeHold }) },
        '../api/equipmentRequests': { getEventEquipmentRequests: async () => ({ requests: [] }) },
        '../equipmentRequestEligibility': eligibility,
    '../components/EquipmentRequestCard': { default: await equipmentCard(), __esModule: true },
      })
      Page(); effects.forEach(fn => fn())
      await new Promise(resolve => setImmediate(resolve)); index = 0
      const markup = renderToStaticMarkup(Page())
      // Under review events can be held but not booked until approved.
      const eligible = activeHold && status === 'confirmed'
      assert.equal(markup.includes(`/venues/search?eventId=${event.id}`), eligible)
      assert.equal(markup.includes('Find / Request Venue'), eligible)
      assert.equal(markup.includes('Venue Booking Requests'), status !== 'under_review')
    })
  }
}

async function renderCoordinatorPage(pageEvent, safetyDecision, bookings = []) {
  const states = [], effects = []
  let index = 0
  const Page = await compile('../src/pages/EventReviewDetailPage.jsx', {
    react: { ...React, useEffect: fn => effects.push(fn), useState(initial) {
      const position = index++
      if (!(position in states)) states[position] = initial
      return [states[position], value => { states[position] = typeof value === 'function' ? value(states[position]) : value }]
    } },
    'react-router-dom': { Link: link, useParams: () => ({ eventId: pageEvent.id }) },
    '../eventCategories': categories,
    '../context/AuthContext': { useAuth: () => ({ token: 'token' }) },
    '../components/AppShell': { default: ({ children }) => React.createElement('main', null, children), __esModule: true },
    '../components/SessionList': { default: () => 'SESSION-LIST', __esModule: true },
    '../components/CancelArrangementForm': { default: () => null, __esModule: true },
    '../cancelArrangements': cancelRules,
    '../changeRequestSessions': changeSessions,
    '../api/events': {
      getAssignedEventRequest: async () => ({ event: pageEvent, organiser: null, safety_decision: safetyDecision }),
      getEventActivityLogs: async () => ({ logs: [] }),
      getAssignedEventClarifications: async () => ({ clarifications: [] }),
    },
    '../api/venues': { getVenueBookingsForEvent: async () => ({ bookings }) },
    '../api/equipmentRequests': { getEventEquipmentRequests: async () => ({ requests: [] }) },
    '../equipmentRequestEligibility': eligibility,
    '../components/EquipmentRequestCard': { default: await equipmentCard(), __esModule: true },
  })
  Page()
  effects.forEach(fn => fn())
  await new Promise(resolve => setImmediate(resolve))
  index = 0
  return renderToStaticMarkup(Page())
}

const rejection = { decision: 'REJECTED', reason: 'Crowd flow blocks the only fire exit', created_at: '2026-10-19T11:00:00Z' }

test('Coordinator sees why the Safety Officer sent the event back to Planning', async () => {
  const markup = await renderCoordinatorPage(event, rejection)
  assert.match(markup, /class="notice" role="status"/)
  assert.match(markup, /Safety check rejected/)
  assert.match(markup, /Venue and equipment reservations were released/)
  assert.match(markup, /Reason: Crowd flow blocks the only fire exit/)

  const changes = await renderCoordinatorPage(event, { ...rejection, decision: 'CHANGES_REQUESTED', reason: 'Add a second exit' })
  assert.match(changes, /Safety Officer requested changes/)
  assert.match(changes, /Reason: Add a second exit/)
  assert.doesNotMatch(changes, /reservations were released/)
})

test('safety decision banner stays hidden once it no longer needs action', async () => {
  for (const [pageEvent, decision] of [
    [event, null],
    [event, { ...rejection, decision: 'APPROVED', reason: null }],
    [{ ...event, status: 'awaiting_safety_check' }, rejection],
    [{ ...event, status: 'confirmed' }, rejection],
  ]) {
    const markup = await renderCoordinatorPage(pageEvent, decision)
    assert.doesNotMatch(markup, /Safety check rejected|Safety Officer requested changes/)
  }
})

test('rejected or cancelled bookings do not keep the safety check button disabled', async () => {
  const button = markup => markup.match(/<button[^>]*>Request Safety Check<\/button>/)[0]
  const booking = status => ({ ...affected, booking_id: status, session_id: 'session-1', status })
  for (const [bookings, enabled] of [
    [[booking('REJECTED_BY_SAFETY'), booking('APPROVED')], true],
    [[booking('REJECTED'), booking('CANCELLED'), booking('APPROVED')], true],
    [[booking('REJECTED_BY_SAFETY')], false],
    [[booking('PENDING_VENUE_APPROVAL'), booking('APPROVED')], false],
    [[booking('AFFECTED_BY_UNAVAILABILITY'), booking('APPROVED')], false],
  ]) {
    const markup = await renderCoordinatorPage(event, null, bookings)
    assert.equal(!button(markup).includes('disabled'), enabled, bookings.map(b => b.status).join(', '))
  }
})

test('the Coordinator sees how much of each requested item is allocated', async () => {
  const Card = await equipmentCard()
  const html = renderToStaticMarkup(React.createElement(Card, {
    title: 'Main session',
    timing: event.sessions[0],
    request: {
      status: 'Pending Technical Approval',
      created_at: '2099-11-01T10:00:00Z',
      request_details: '2 x Projector (HDMI)',
      lines: [{ id: 'line-1', item_name: 'Projector', quantity: 2, specifics: 'HDMI' }],
      equipment_bookings: [{ id: 'booking-1', line_id: 'line-1', equipment: { name: 'Projector' } }],
    },
  }))

  assert.match(html, /Projector: 1\/2 allocated/)
  assert.match(html, /HDMI/)
})

test('the Coordinator sees why an equipment request was rejected', async () => {
  const Card = await equipmentCard()
  const html = renderToStaticMarkup(React.createElement(Card, {
    title: 'Main session',
    timing: event.sessions[0],
    request: {
      status: 'Rejected',
      rejection_reason: 'None available that day',
      created_at: '2099-11-01T10:00:00Z',
      request_details: '1 x Projector',
    },
  }))

  assert.match(html, /Rejection reason:/)
  assert.match(html, /None available that day/)
})

const venue = (status, changes = {}) => ({
  ...affected, booking_id: status, session_id: 'session-1', status, rejection_reason: 'Room too large', ...changes,
})

test('a rejected venue shows while planning, with what to do next, and not afterwards', async () => {
  const planning = await renderCoordinatorPage(event, null, [venue('REJECTED')])
  assert.match(planning, /Rejection Reason/)
  assert.match(planning, /request another venue for this session/)
  assert.match(planning, /Venue Booking Requests \(1\)/)

  for (const status of ['awaiting_safety_check', 'confirmed', 'completed']) {
    const later = await renderCoordinatorPage({ ...event, status }, null, [venue('REJECTED'), venue('APPROVED')])
    assert.doesNotMatch(later, /Rejection Reason/)
    assert.match(later, /Venue Booking Requests \(1\)/)
  }
})

test('the safety check is only mentioned once on the event page', async () => {
  const markup = await renderCoordinatorPage({ ...event, status: 'awaiting_safety_check' }, null, [venue('APPROVED')])

  assert.doesNotMatch(markup, /Safety Review Pending/)
  assert.equal(markup.match(/Awaiting safety check/g).length, 1)
})

test('sessions come before the venues and equipment booked for them', async () => {
  const markup = await renderCoordinatorPage(event, null, [venue('APPROVED')])

  assert.ok(markup.indexOf('SESSION-LIST') < markup.indexOf('Venue Booking Requests'))
  assert.ok(markup.indexOf('SESSION-LIST') < markup.indexOf('Equipment requests'))
})

test('the planning page lists what still stops the safety check', async () => {
  const waiting = await renderCoordinatorPage(event, null, [venue('PENDING_VENUE_APPROVAL')])
  assert.match(waiting, /To request the safety check/)
  assert.match(waiting, /Main session: waiting for its venue to be approved/)

  const ready = await renderCoordinatorPage(event, null, [venue('APPROVED')])
  assert.match(ready, /Everything is ready for the safety check/)
  assert.match(ready, /<button type="button" class="button">Request Safety Check/)
})

test('the event list has no safety tag, and colours what needs attention', async () => {
  const Tabs = await compile('../src/components/AssignedRequestTabs.jsx', {
    'react-router-dom': { Link: link, useSearchParams: () => [new URLSearchParams('tab=waiting'), () => {}] },
  })
  const markup = renderToStaticMarkup(React.createElement(Tabs, {
    events: [{ ...event, status: 'awaiting_safety_check', venue_bookings: [{ status: 'APPROVED' }] }],
  }))

  assert.match(markup, />Awaiting safety check</)
  assert.doesNotMatch(markup, /Safety check not done|Safety Check Done|Safety Concerns/)
  assert.match(markup, /class="tag tag--good">Venue Approved/)
})

test('a change to sessions alone shows no empty details box', async () => {
  const markup = await renderCoordinatorPage({
    ...event,
    has_pending_change_request: true,
    change_request: {
      status: 'pending',
      reason_for_change: 'More time needed',
      name: event.name,
      category: event.category,
      sessions: event.sessions,
    },
  }, null, [])
  const review = markup.slice(markup.indexOf('Review proposed changes'), markup.indexOf('<h3>Sessions</h3>'))

  assert.match(review, /More time needed/)
  assert.doesNotMatch(review, /class="answers"/)
})

test('a change to event details still lists them', async () => {
  const markup = await renderCoordinatorPage({
    ...event,
    has_pending_change_request: true,
    change_request: {
      status: 'pending',
      reason_for_change: 'Rebranded',
      name: 'New name',
      category: event.category,
      sessions: event.sessions,
    },
  }, null, [])
  const review = markup.slice(markup.indexOf('Review proposed changes'), markup.indexOf('<h3>Sessions</h3>'))

  assert.match(review, /class="answers"/)
  assert.match(review, /New name/)
})
