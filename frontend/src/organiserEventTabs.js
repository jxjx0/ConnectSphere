export const ORGANISER_EVENT_TABS = [
  { id: 'drafts', label: 'Drafts', empty: 'You have no saved drafts.' },
  { id: 'submitted', label: 'Submitted', statuses: ['under_review'], empty: 'You have no submitted requests waiting for review.' },
  { id: 'awaiting-clarification', label: 'Awaiting clarification', statuses: ['awaiting_clarification'], empty: 'You have no events awaiting clarification.' },
  { id: 'change-requested', label: 'Change requested', statuses: ['change_requested'], empty: 'You have no events with a change request.' },
  { id: 'planning', label: 'Planning', statuses: ['planning'], empty: 'You have no events in planning.' },
  { id: 'confirmed', label: 'Confirmed', statuses: ['confirmed'], empty: 'You have no confirmed events.' },
  { id: 'completed', label: 'Completed', statuses: ['completed'], empty: 'You have no completed events.' },
  { id: 'rejected', label: 'Rejected', statuses: ['rejected'], empty: 'You have no rejected events.' },
]

export function organiserEventsForTab(tabId, events, drafts) {
  if (tabId === 'drafts') return drafts
  const tab = ORGANISER_EVENT_TABS.find((item) => item.id === tabId)
  return tab ? events.filter((event) => tab.statuses.includes(event.status)) : []
}

export function organiserTabCount(tabId, events, drafts) {
  return organiserEventsForTab(tabId, events, drafts).length
}

export function organiserEventStatusLabel(status, tabId) {
  if (tabId === 'submitted' && status === 'under_review') return 'Submitted'
  const words = status.replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}
