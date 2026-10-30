import assert from 'node:assert/strict'
import test from 'node:test'

import {
  coordinatorEventsForTab,
  coordinatorTabFor,
} from '../src/coordinatorEventTabs.js'
import {
  attendeeEventNote,
  forwardBlocker,
  isWaitingOn,
  openRequestBadges,
  progressFor,
  requestHistory,
  statusLabel,
  statusNextStep,
} from '../src/eventStatus.js'

test('statuses read as words and say what they mean for each role', () => {
  assert.equal(statusLabel('awaiting_safety_check'), 'Awaiting safety check')
  assert.match(statusNextStep('planning', 'organiser'), /booking venues and equipment/)
  assert.match(statusNextStep('planning', 'coordinator'), /request the safety check/)
})

test('the progress bar marks earlier stages done and the current one', () => {
  assert.deepEqual(
    progressFor('awaiting_safety_check').steps.map((step) => step.state),
    ['done', 'done', 'current', 'todo', 'todo'],
  )
  assert.deepEqual(progressFor('rejected').steps, [])
})

test('several requests can be open at once, each worded for the reader', () => {
  const event = {
    status: 'planning', has_open_clarification: true, has_pending_change_request: true,
  }

  assert.deepEqual(
    openRequestBadges(event, 'organiser').map(({ label, yourTurn }) => [label, yourTurn]),
    [['Reply needed', true], ['Change being reviewed', false]],
  )
  assert.deepEqual(
    openRequestBadges(event, 'coordinator').map(({ label, yourTurn }) => [label, yourTurn]),
    [["Waiting for the Organiser's reply", false], ['Change to review', true]],
  )
  assert.deepEqual(
    openRequestBadges(event, 'lead coordinator').map(({ label }) => label),
    ['Clarification open', 'Change pending'],
  )
})

test('an event cannot move forward while anything is open, and says why', () => {
  assert.equal(forwardBlocker({ status: 'planning' }, 'coordinator'), '')
  assert.match(
    forwardBlocker({ status: 'planning', has_open_clarification: true }, 'coordinator'),
    /Organiser's reply/,
  )
  // A cancellation is decided before anything else.
  assert.match(
    forwardBlocker({ has_pending_change_request: true, has_pending_cancellation_request: true }, 'coordinator'),
    /cancellation request first/,
  )
})

test('whose turn it is', () => {
  assert.equal(isWaitingOn({ status: 'under_review' }, 'coordinator'), true)
  assert.equal(isWaitingOn({ status: 'under_review', has_open_clarification: true }, 'coordinator'), false)
  assert.equal(isWaitingOn({ status: 'under_review', has_open_clarification: true }, 'organiser'), true)
  assert.equal(isWaitingOn({ status: 'confirmed', has_pending_change_request: true }, 'coordinator'), true)
  assert.equal(isWaitingOn({ status: 'confirmed', has_pending_change_request: true }, 'organiser'), false)
})

test('coordinator tabs group events by whether they are waiting on the Coordinator', () => {
  const events = [
    { id: 'new', status: 'under_review' },
    { id: 'asked', status: 'under_review', has_open_clarification: true },
    { id: 'change', status: 'confirmed', has_pending_change_request: true },
    { id: 'cancel', status: 'planning', has_pending_cancellation_request: true },
    { id: 'safety', status: 'awaiting_safety_check' },
    { id: 'planning', status: 'planning' },
    { id: 'confirmed', status: 'confirmed' },
    { id: 'done', status: 'completed' },
    { id: 'no', status: 'rejected' },
    { id: 'off', status: 'cancelled' },
  ]
  const ids = (tab) => coordinatorEventsForTab(tab, events).map((event) => event.id)

  assert.deepEqual(ids('needs-action'), ['new', 'change', 'cancel'])
  assert.deepEqual(ids('waiting'), ['asked', 'safety'])
  assert.deepEqual(ids('in-progress'), ['planning', 'confirmed'])
  assert.deepEqual(ids('closed'), ['done', 'no', 'off'])
  for (const event of events) assert.ok(coordinatorTabFor(event))
})

test('history is one timeline of closed requests, newest first', () => {
  const clarifications = [
    { id: 'q1', status: 'answered', created_at: '2026-10-01T00:00:00Z', closed_at: '2026-10-02T00:00:00Z' },
    { id: 'q2', status: 'pending', created_at: '2026-10-05T00:00:00Z' },
  ]
  const event = {
    change_requests: [
      { id: 'c1', status: 'rejected', created_at: '2026-10-03T00:00:00Z', closed_at: '2026-10-04T00:00:00Z' },
    ],
    cancellation_requests: [
      { id: 'x1', status: 'expired', created_at: '2026-09-01T00:00:00Z', closed_at: '2026-09-02T00:00:00Z' },
    ],
  }

  assert.deepEqual(
    requestHistory(clarifications, event).map(({ id, label, outcome }) => [id, label, outcome]),
    [
      ['change-c1', 'Change request', 'Rejected'],
      ['clarification-q1', 'Clarification', 'Answered'],
      ['cancellation-x1', 'Cancellation request', 'Expired'],
    ],
  )
})

test('attendees only hear whether the event is going ahead', () => {
  const future = '2999-01-01T00:00:00Z'
  assert.equal(attendeeEventNote('confirmed', future), '')
  assert.equal(attendeeEventNote('planning', future), '')
  assert.equal(attendeeEventNote('cancelled', future), 'This event has been cancelled.')
  assert.equal(attendeeEventNote('confirmed', '2000-01-01T00:00:00Z'), 'This event has ended.')
})
