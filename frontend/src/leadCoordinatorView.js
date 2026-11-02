// What a Lead Coordinator sees when choosing who should run an event.

import { CLOSED_STATUSES } from './eventStatus.js'

export function activeEventCount(coordinatorId, events) {
  return events.filter((event) => (
    event.coordinator_id === coordinatorId && !CLOSED_STATUSES.includes(event.status)
  )).length
}

// "Ada Tan (2 active events)", so workload is visible while choosing.
export function coordinatorOptionLabel(coordinator, events) {
  const name = coordinator.full_name || coordinator.email || coordinator.id
  const count = activeEventCount(coordinator.id, events)
  return `${name} (${count} active ${count === 1 ? 'event' : 'events'})`
}

// Calculates relative time since a request was made (e.g., "2 hours ago").
export function formatTimeAgo(isoString, now = new Date()) {
  const date = new Date(isoString)
  if (!isoString || Number.isNaN(date.getTime())) return ''

  const seconds = Math.floor((now - date) / 1000)
  for (const [label, length] of [['day', 86400], ['hour', 3600], ['minute', 60]]) {
    const count = Math.floor(seconds / length)
    if (count >= 1) return `${count} ${label}${count > 1 ? 's' : ''} ago`
  }
  return 'Just now'
}
