import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ORGANISER_EVENT_TABS,
  defaultOrganiserTab,
  organiserEventsForTab,
  organiserTabCount,
  organiserTabFor,
} from '../src/organiserEventTabs.js'

const events = [
  { id: '1', status: 'under_review' },
  { id: '2', status: 'planning', has_open_clarification: true },
  { id: '3', status: 'awaiting_safety_check' },
  { id: '4', status: 'confirmed', has_pending_change_request: true },
  { id: '5', status: 'confirmed', has_pending_cancellation_request: true },
  { id: '6', status: 'planning' },
  { id: '7', status: 'completed' },
  { id: '8', status: 'rejected' },
  { id: '9', status: 'cancelled' },
]
const drafts = [{ id: 'draft-1', status: 'draft' }]

test('organiser tabs put what needs a reply first', () => {
  assert.deepEqual(
    ORGANISER_EVENT_TABS.map((tab) => tab.id),
    ['needs-reply', 'in-progress', 'drafts', 'closed'],
  )
})

test('only an open clarification needs the Organiser', () => {
  assert.deepEqual(organiserEventsForTab('needs-reply', events, drafts), [events[1]])
})

test('events stay in progress while their own change or cancellation is reviewed', () => {
  assert.deepEqual(
    organiserEventsForTab('in-progress', events, drafts).map((event) => event.id),
    ['1', '3', '4', '5', '6'],
  )
})

test('completed, rejected and cancelled events are closed', () => {
  assert.deepEqual(
    organiserEventsForTab('closed', events, drafts).map((event) => event.id),
    ['7', '8', '9'],
  )
})

test('every submitted event is in exactly one tab', () => {
  const tabs = ['needs-reply', 'in-progress', 'closed']
  for (const event of events) {
    assert.equal(tabs.filter((tab) => organiserTabFor(event) === tab).length, 1)
  }
  assert.equal(
    tabs.reduce((total, tab) => total + organiserTabCount(tab, events, drafts), 0),
    events.length,
  )
})

test('drafts tab lists drafts', () => {
  assert.deepEqual(organiserEventsForTab('drafts', events, drafts), drafts)
})

test('the page opens on "Needs my reply" only when something is waiting', () => {
  assert.equal(defaultOrganiserTab(events), 'needs-reply')
  assert.equal(defaultOrganiserTab([events[0], events[5]]), 'in-progress')
})
