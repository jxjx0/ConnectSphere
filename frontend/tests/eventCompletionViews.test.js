// Render the real status/history views with controlled loaded state. These are
// component tests, not browser or Supabase end-to-end tests.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as jsxRuntime from 'react/jsx-runtime'
import { transformWithEsbuild } from 'vite'
import * as eventDisplay from '../src/eventDisplay.js'
import * as eventCategories from '../src/eventCategories.js'
import * as organiserTabs from '../src/organiserEventTabs.js'
import * as registration from '../src/eventRegistration.js'
import * as equipmentEligibility from '../src/equipmentRequestEligibility.js'
import * as changeSessions from '../src/changeRequestSessions.js'
import * as cancellations from '../src/cancelArrangements.js'
import * as eventStatus from '../src/eventStatus.js'
import * as coordinatorTabs from '../src/coordinatorEventTabs.js'
import * as coordinatorView from '../src/coordinatorEventView.js'

const files = ['components/AssignedRequestTabs', 'pages/MyEventsPage',
  'pages/MyEventDetailPage', 'pages/EventReviewDetailPage',
  'components/EventStatusPanel', 'components/RequestHistory']
const compiled = new Map(await Promise.all(files.map(async file => {
  const source = await readFile(new URL(`../src/${file}.jsx`, import.meta.url), 'utf8')
  const { code } = await transformWithEsbuild(source, file + '.jsx', {
    jsx: 'automatic', format: 'cjs', tsconfigRaw: '{}',
  })
  return [file, code]
})))
const defaultModule = component => ({ __esModule: true, default: component })

// The shared status components, loaded with the real status module.
function load(file, imports) {
  const module = { exports: {} }
  new Function('require', 'module', 'exports', compiled.get(file))(
    name => { assert.ok(name in imports, `unexpected import: ${name}`); return imports[name] },
    module, module.exports,
  )
  return module.exports.default
}
const statusImports = {
  'react/jsx-runtime': jsxRuntime, '../eventStatus': eventStatus, '../eventDisplay': eventDisplay,
}
const EventStatusPanel = load('components/EventStatusPanel', statusImports)
const RequestHistory = load('components/RequestHistory', statusImports)

function render(file, { tab = 'closed', states = {}, props = {} } = {}) {
  let stateIndex = 0
  const imports = {
    react: {
      ...React, useEffect: () => {},
      useState: initial => {
        const index = stateIndex++
        const value = index in states ? states[index] : typeof initial === 'function' ? initial() : initial
        return [value, () => assert.fail('render must not mutate state')]
      },
    },
    'react/jsx-runtime': jsxRuntime,
    'react-router-dom': {
      Link: ({ to, children, ...props }) => React.createElement('a', { ...props, href: to }, children),
      useSearchParams: () => [new URLSearchParams({ tab }), () => {}],
      useParams: () => ({ eventId: 'completed-event' }),
    },
    '../context/AuthContext': { useAuth: () => ({ token: 'token' }) },
    '../api/events': {}, '../api/venues': {}, '../api/equipmentRequests': {},
    '../eventDisplay': eventDisplay, '../eventCategories': eventCategories,
    '../organiserEventTabs': organiserTabs, '../eventRegistration': registration,
    '../eventStatus': eventStatus, '../coordinatorEventTabs': coordinatorTabs,
    '../coordinatorEventView': coordinatorView,
    '../components/EventStatusPanel': defaultModule(EventStatusPanel),
    '../components/RequestHistory': defaultModule(RequestHistory),
    '../equipmentRequestEligibility': equipmentEligibility,
    '../changeRequestSessions': changeSessions, '../cancelArrangements': cancellations,
    '../components/AppShell': defaultModule(({ children }) => React.createElement('main', null, children)),
    '../components/SessionList': defaultModule(() => null),
    '../components/EquipmentRequestCard': defaultModule(() => null),
    '../components/CancelArrangementForm': defaultModule(() => null),
  }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', compiled.get(file))(
    name => { assert.ok(name in imports, `unexpected import: ${name}`); return imports[name] },
    module, module.exports,
  )
  return renderToStaticMarkup(React.createElement(module.exports.default, props))
}

const completed = {
  id: 'completed-event', organiser_id: 'organiser', name: 'Finished workshop',
  status: 'completed', category: 'workshop', sessions: [],
  start_time: '2026-10-01T01:00:00Z', end_time: '2026-10-01T02:00:00Z',
  completed_at: '2026-10-01T02:01:00Z',
  has_pending_change_request: false, has_pending_cancellation_request: false,
  change_request: { id: 'change-1', status: 'expired', reason_for_change: 'New title', sessions: [],
    created_at: '2026-09-20T00:00:00Z', closed_at: '2026-10-01T02:01:00Z' },
  cancellation_request: { id: 'cancel-1', status: 'expired', reason: 'Cancel',
    created_at: '2026-09-21T00:00:00Z', closed_at: '2026-10-01T02:01:00Z' },
}
completed.change_requests = [completed.change_request]
completed.cancellation_requests = [completed.cancellation_request]
const events = [completed, { ...completed, id: 'active-event', status: 'confirmed', name: 'Upcoming workshop' }]

test('coordinator closed tab links to the completed event and every other tab excludes it', () => {
  const file = 'components/AssignedRequestTabs'
  const closed = render(file, { props: { events } })
  assert.match(closed, /href="\/event-reviews\/completed-event"/)
  assert.match(closed, />Completed<\/span>/)
  assert.doesNotMatch(closed, /href="\/event-reviews\/active-event"/)
  for (const tab of ['needs-action', 'waiting', 'in-progress']) {
    assert.doesNotMatch(render(file, { tab, props: { events } }), /href="\/event-reviews\/completed-event"/)
  }
})

test('organiser closed tab links to the completed event and all other tabs exclude it', () => {
  const states = { 0: events, 1: [], 3: false }
  const closed = render('pages/MyEventsPage', { states })
  assert.match(closed, /href="\/my-events\/completed-event"/)
  assert.match(closed, />Completed<\/span>/)
  assert.doesNotMatch(closed, /href="\/my-events\/active-event"/)
  for (const tab of organiserTabs.ORGANISER_EVENT_TABS.filter(item => item.id !== 'closed')) {
    assert.doesNotMatch(render('pages/MyEventsPage', { tab: tab.id, states }), /href="\/my-events\/completed-event"/)
  }
})

test('organiser completed detail shows expired requests in the history and no actions', () => {
  const html = render('pages/MyEventDetailPage', { states: { 0: completed, 11: false } })
  assert.match(html, /The event has ended/)
  assert.match(html, /Change request.*Expired/)
  assert.match(html, /Cancellation request.*Expired/)
  assert.match(html, /It was not reviewed before the event ended/)
  assert.doesNotMatch(html, /href="[^\"]*\/(registration|change-request)"/)
  assert.doesNotMatch(html, /Request cancellation|Waiting for the Coordinator to review/)
})

test('coordinator completed detail shows the stage and offers no expired-request review', () => {
  const html = render('pages/EventReviewDetailPage', { states: { 0: completed, 12: false } })
  assert.match(html, />Completed<\/span>/)
  assert.match(html, /Change request.*Expired/)
  assert.doesNotMatch(html, /Approve and apply changes|Reject change request|Request Clarification/)
})

for (const status of ['completed', 'cancelled']) {
  for (const [label, file, loadingIndex] of [
    ['organiser', 'pages/MyEventDetailPage', 11],
    ['coordinator', 'pages/EventReviewDetailPage', 12],
  ]) {
    test(label + ' sees an expired change in the history of a ' + status + ' event', () => {
      const event = { ...completed, status, cancellation_request: null, cancellation_requests: [] }
      const html = render(file, { states: { 0: event, [loadingIndex]: false } })
      assert.match(html, /Change request.*Expired/)
      assert.doesNotMatch(html, /Approve and apply changes|Reject change request/)
    })
  }
}
