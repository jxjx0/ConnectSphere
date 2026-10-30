import { CLOSED_STATUSES, isWaitingOn } from './eventStatus.js'

// The Coordinator's assigned events, grouped by "is this waiting on me?".
// Every event is in exactly one tab, and opening a request never moves an
// event out of sight: it moves to "Needs my action" or "Waiting on others".
export const COORDINATOR_EVENT_TABS = [
  {
    id: 'needs-action',
    label: 'Needs my action',
    empty: 'Nothing is waiting for your decision.',
  },
  {
    id: 'waiting',
    label: 'Waiting on others',
    empty: 'No events are waiting on the Organiser or the Safety Officer.',
  },
  {
    id: 'in-progress',
    label: 'In progress',
    empty: 'You have no events in planning or confirmed.',
  },
  {
    id: 'closed',
    label: 'Closed',
    empty: 'You have no completed, rejected or cancelled events.',
  },
]

// The one tab an event belongs in.
export function coordinatorTabFor(event) {
  if (isWaitingOn(event, 'coordinator')) return 'needs-action'
  if (CLOSED_STATUSES.includes(event.status)) return 'closed'
  if (event.has_open_clarification || event.status === 'awaiting_safety_check') return 'waiting'
  return 'in-progress'
}

export function coordinatorEventsForTab(tabId, events) {
  return events.filter((event) => coordinatorTabFor(event) === tabId)
}
