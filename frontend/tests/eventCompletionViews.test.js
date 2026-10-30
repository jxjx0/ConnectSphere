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

const files = ['components/AssignedRequestTabs', 'pages/MyEventsPage',
  'pages/MyEventDetailPage', 'pages/EventReviewDetailPage']
const compiled = new Map(await Promise.all(files.map(async file => {
  const source = await readFile(new URL(`../src/${file}.jsx`, import.meta.url), 'utf8')
  const { code } = await transformWithEsbuild(source, file + '.jsx', {
    jsx: 'automatic', format: 'cjs', tsconfigRaw: '{}',
  })
  return [file, code]
})))
const defaultModule = component => ({ __esModule: true, default: component })

function render(file, { tab = 'completed', states = {}, props = {} } = {}) {
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
  change_request: { status: 'expired', reason_for_change: 'New title', sessions: [] },
  cancellation_request: { status: 'expired', reason: 'Cancel' },
}
const events = [completed, { ...completed, id: 'active-event', status: 'confirmed', name: 'Upcoming workshop' }]

test('coordinator completed history links to the event and every active tab excludes it', () => {
  const file = 'components/AssignedRequestTabs'
  const history = render(file, { props: { events } })
  assert.match(history, /href="\/event-reviews\/completed-event"/)
  assert.match(history, />Completed<\/span>/)
  assert.doesNotMatch(history, /href="\/event-reviews\/active-event"/)
  for (const tab of ['under_review', 'clarification', 'planning', 'awaiting_safety_check', 'confirmed', 'change-requested']) {
    assert.doesNotMatch(render(file, { tab, props: { events } }), /href="\/event-reviews\/completed-event"/)
  }
})

test('organiser completed history links to the event and all other tabs exclude it', () => {
  const states = { 0: events, 1: [], 3: false }
  const history = render('pages/MyEventsPage', { states })
  assert.match(history, /href="\/my-events\/completed-event"/)
  assert.match(history, />Completed<\/span>/)
  assert.doesNotMatch(history, /href="\/my-events\/active-event"/)
  for (const tab of organiserTabs.ORGANISER_EVENT_TABS.filter(item => item.id !== 'completed')) {
    assert.doesNotMatch(render('pages/MyEventsPage', { tab: tab.id, states }), /href="\/my-events\/completed-event"/)
  }
})

test('organiser completed detail shows expiry and removes registration/change/cancellation actions', () => {
  const html = render('pages/MyEventDetailPage', { states: { 0: completed, 11: false } })
  assert.match(html, /This event has finished/)
  assert.match(html, /This change request has expired and can no longer be reviewed\./)
  assert.match(html, /This cancellation request expired when the event completed/)
  assert.doesNotMatch(html, /href="[^\"]*\/(registration|change-request)"/)
  assert.doesNotMatch(html, /Request cancellation|waiting for review|waiting for the Coordinator/)
})

test('coordinator completed detail shows the updated status and offers no expired-request review', () => {
  const html = render('pages/EventReviewDetailPage', { states: { 0: completed, 12: false } })
  assert.match(html, />Completed<\/span>/)
  assert.match(html, /This change request has expired and can no longer be reviewed\./)
  assert.doesNotMatch(html, /Approve and apply changes|Reject change request|Request Clarification/)
})

for (const status of ['completed', 'cancelled']) {
  for (const [label, file, loadingIndex] of [
    ['organiser', 'pages/MyEventDetailPage', 11],
    ['coordinator', 'pages/EventReviewDetailPage', 12],
  ]) {
    test(label + ' expired change notice is generic on a ' + status + ' event', () => {
      const event = { ...completed, status, cancellation_request: null }
      const html = render(file, { states: { 0: event, [loadingIndex]: false } })
      assert.match(html, /This change request has expired and can no longer be reviewed\./)
      assert.doesNotMatch(html, /change request expired when (?:this|the) event completed/)
      assert.doesNotMatch(html, /Approve and apply changes|Reject change request/)
    })
  }
}
