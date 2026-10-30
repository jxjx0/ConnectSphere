import { CLOSED_STATUSES, isWaitingOn } from './eventStatus.js'

// "Needs my reply" comes first: it is the only tab where the next step is
// the Organiser's. Every submitted event is in exactly one of the others.
export const ORGANISER_EVENT_TABS = [
  { id: 'needs-reply', label: 'Needs my reply', empty: 'Nothing is waiting for your reply.' },
  { id: 'in-progress', label: 'In progress', empty: 'You have no event requests in progress.' },
  { id: 'drafts', label: 'Drafts', empty: 'You have no saved drafts.' },
  { id: 'closed', label: 'Closed', empty: 'You have no completed, rejected or cancelled events.' },
]

// The one tab an event belongs in.
export function organiserTabFor(event) {
  if (isWaitingOn(event, 'organiser')) return 'needs-reply'
  if (CLOSED_STATUSES.includes(event.status)) return 'closed'
  return 'in-progress'
}

export function organiserEventsForTab(tabId, events, drafts) {
  if (tabId === 'drafts') return drafts
  return events.filter((event) => organiserTabFor(event) === tabId)
}

export function organiserTabCount(tabId, events, drafts) {
  return organiserEventsForTab(tabId, events, drafts).length
}

// Open "Needs my reply" when something is waiting, otherwise "In progress".
export function defaultOrganiserTab(events) {
  return events.some((event) => organiserTabFor(event) === 'needs-reply')
    ? 'needs-reply'
    : 'in-progress'
}
