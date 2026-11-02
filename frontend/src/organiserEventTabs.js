import { CLOSED_STATUSES, isWaitingOn } from './eventStatus.js'

// "Needs my action" comes first: it is the only tab where the next step is
// the Organiser's. Every submitted event is in exactly one of the others.
export const ORGANISER_EVENT_TABS = [
  { id: 'needs-action', label: 'Needs my action', empty: 'Nothing is waiting for you.' },
  { id: 'in-progress', label: 'In progress', empty: 'You have no event requests in progress.' },
  { id: 'upcoming', label: 'Upcoming', empty: 'You have no upcoming events.' },
  { id: 'drafts', label: 'Drafts', empty: 'You have no saved drafts.' },
  { id: 'closed', label: 'Closed', empty: 'You have no completed, rejected or cancelled events.' },
]

// A confirmed event goes ahead next, so attendees need to be able to sign up.
export function needsRegistrationSetup(event) {
  return event.status === 'confirmed' && !event.published_at
}

// The one tab an event belongs in.
export function organiserTabFor(event) {
  if (isWaitingOn(event, 'organiser') || needsRegistrationSetup(event)) return 'needs-action'
  if (CLOSED_STATUSES.includes(event.status)) return 'closed'
  return event.status === 'confirmed' ? 'upcoming' : 'in-progress'
}

export function organiserEventsForTab(tabId, events, drafts) {
  if (tabId === 'drafts') return drafts
  return events.filter((event) => organiserTabFor(event) === tabId)
}

export function organiserTabCount(tabId, events, drafts) {
  return organiserEventsForTab(tabId, events, drafts).length
}

// Open "Needs my action" when something is waiting, otherwise "In progress".
export function defaultOrganiserTab(events) {
  return events.some((event) => organiserTabFor(event) === 'needs-action')
    ? 'needs-action'
    : 'in-progress'
}
