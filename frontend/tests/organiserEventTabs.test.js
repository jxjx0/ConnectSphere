import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ORGANISER_EVENT_TABS,
  organiserEventStatusLabel,
  organiserEventsForTab,
  organiserTabCount,
} from '../src/organiserEventTabs.js'

const events = [
  { id: '1', status: 'under_review' },
  { id: '2', status: 'awaiting_clarification' },
  { id: '3', status: 'change_requested' },
  { id: '4', status: 'planning' },
  { id: '5', status: 'confirmed' },
  { id: '6', status: 'completed' },
  { id: '7', status: 'rejected' },
]
const drafts = [{ id: 'draft-1', status: 'draft' }]

test('organiser tabs cover requested statuses and rejected events', () => {
  assert.deepEqual(
    ORGANISER_EVENT_TABS.map((tab) => tab.id),
    [
      'drafts',
      'submitted',
      'awaiting-clarification',
      'change-requested',
      'planning',
      'confirmed',
      'completed',
      'rejected',
    ],
  )
})

test('submitted tab filters under-review events and labels them Submitted', () => {
  assert.deepEqual(organiserEventsForTab('submitted', events, drafts), [events[0]])
  assert.equal(organiserEventStatusLabel('under_review', 'submitted'), 'Submitted')
})

test('status tabs filter events and return matching counts', () => {
  assert.deepEqual(
    organiserEventsForTab('awaiting-clarification', events, drafts),
    [events[1]],
  )
  assert.deepEqual(organiserEventsForTab('change-requested', events, drafts), [events[2]])
  assert.deepEqual(organiserEventsForTab('planning', events, drafts), [events[3]])
  assert.deepEqual(organiserEventsForTab('confirmed', events, drafts), [events[4]])
  assert.deepEqual(organiserEventsForTab('completed', events, drafts), [events[5]])
  assert.deepEqual(organiserEventsForTab('rejected', events, drafts), [events[6]])
  assert.equal(organiserTabCount('confirmed', events, drafts), 1)
})

test('drafts tab returns drafts separately from submitted events', () => {
  assert.deepEqual(organiserEventsForTab('drafts', events, drafts), drafts)
  assert.equal(organiserTabCount('drafts', events, drafts), 1)
})
