// How an event's status and open requests are worded, in one place.
//
// The status only says where the event is in the main path. Clarifications,
// change requests and cancellation requests are open requests shown as
// badges on top of it, and the event cannot move forward while one is open.
// Each role gets wording about what it means for them, and whose turn it is.

// The main path, in order, for the progress bar.
export const STAGES = [
  { status: 'under_review', label: 'Submitted' },
  { status: 'planning', label: 'Planning' },
  { status: 'awaiting_safety_check', label: 'Safety check' },
  { status: 'confirmed', label: 'Confirmed' },
  { status: 'completed', label: 'Completed' },
]

// The event has ended one way or another; nothing more happens to it.
export const CLOSED_STATUSES = ['completed', 'rejected', 'cancelled']

// Still on the main path.
export const ACTIVE_STATUSES = ['under_review', 'planning', 'awaiting_safety_check', 'confirmed']

const STATUS_TEXT = {
  draft: {
    label: 'Draft',
    organiser: 'Not submitted yet.',
  },
  under_review: {
    label: 'Under review',
    organiser: 'Submitted. The Coordinator is reviewing your request.',
    coordinator: 'New request. Accept it to start planning, or reject it.',
  },
  planning: {
    label: 'Planning',
    organiser: 'Accepted. The Coordinator is booking venues and equipment.',
    coordinator: 'Book venues and equipment, then request the safety check.',
  },
  awaiting_safety_check: {
    label: 'Awaiting safety check',
    organiser: 'The Safety Officer is checking the arrangements.',
    coordinator: 'Waiting for the Safety Officer to check the arrangements.',
  },
  confirmed: {
    label: 'Confirmed',
    organiser: 'Everything is approved. Your event is going ahead.',
    coordinator: 'Everything is approved. The event is going ahead.',
  },
  completed: {
    label: 'Completed',
    organiser: 'The event has ended.',
    coordinator: 'The event has ended.',
  },
  rejected: {
    label: 'Rejected',
    organiser: 'The Coordinator turned this request down.',
    coordinator: 'This request was rejected.',
  },
  cancelled: {
    label: 'Cancelled',
    organiser: 'This event was cancelled.',
    coordinator: 'This event was cancelled.',
  },
}

// "Planning", "Awaiting safety check", ...
export function statusLabel(status) {
  if (STATUS_TEXT[status]) return STATUS_TEXT[status].label
  const words = String(status || '').replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

// One line on what the status means for this role.
export function statusNextStep(status, role) {
  return STATUS_TEXT[status]?.[role] || ''
}

const REQUEST_TEXT = {
  clarification: {
    flag: 'has_open_clarification',
    anyone: { label: 'Clarification open', yourTurn: false },
    organiser: { label: 'Reply needed', yourTurn: true },
    coordinator: { label: "Waiting for the Organiser's reply", yourTurn: false },
  },
  change: {
    flag: 'has_pending_change_request',
    anyone: { label: 'Change pending', yourTurn: false },
    organiser: { label: 'Change being reviewed', yourTurn: false },
    coordinator: { label: 'Change to review', yourTurn: true },
  },
  cancellation: {
    flag: 'has_pending_cancellation_request',
    anyone: { label: 'Cancellation pending', yourTurn: false },
    organiser: { label: 'Cancellation being reviewed', yourTurn: false },
    coordinator: { label: 'Cancellation to review', yourTurn: true },
  },
}

// The open requests on an event, as badges worded for this role. Roles
// other than the Organiser and Coordinator get neutral wording.
export function openRequestBadges(event, role) {
  return Object.entries(REQUEST_TEXT)
    .filter(([, text]) => event[text.flag])
    .map(([kind, text]) => ({ kind, ...(text[role] || text.anyone) }))
}

export function hasOpenRequests(event) {
  return Object.values(REQUEST_TEXT).some((text) => event[text.flag])
}

// Why the event cannot move forward right now, or '' if it can.
export function forwardBlocker(event, role) {
  if (event.has_pending_cancellation_request) {
    return role === 'coordinator'
      ? 'Review the cancellation request first.'
      : 'Waiting for the Coordinator to review your cancellation request.'
  }
  if (event.has_pending_change_request) {
    return role === 'coordinator'
      ? 'Review the proposed changes first.'
      : 'Waiting for the Coordinator to review your changes.'
  }
  if (event.has_open_clarification) {
    return role === 'coordinator'
      ? "Waiting for the Organiser's reply to your question."
      : "The Coordinator is waiting for your reply to their question."
  }
  return ''
}

// Whether the next step is this role's to take.
export function isWaitingOn(event, role) {
  if (role === 'organiser') return Boolean(event.has_open_clarification)
  if (role === 'coordinator') {
    if (event.has_pending_change_request || event.has_pending_cancellation_request) return true
    return event.status === 'under_review' && !event.has_open_clarification
  }
  return false
}

// Each stage of the progress bar marked done, current or todo. A rejected
// or cancelled event left the path, so it gets a notice instead of a bar.
export function progressFor(status) {
  if (status === 'rejected') {
    return { steps: [], notice: 'This request was not taken forward.' }
  }
  if (status === 'cancelled') {
    return { steps: [], notice: 'This event was cancelled.' }
  }
  const current = STAGES.findIndex((stage) => stage.status === status)
  return {
    steps: STAGES.map((stage, index) => ({
      ...stage,
      state: index < current ? 'done' : index === current ? 'current' : 'todo',
    })),
    notice: '',
  }
}

const KIND_LABELS = {
  clarification: 'Clarification',
  change: 'Change request',
  cancellation: 'Cancellation request',
}

const OUTCOME_LABELS = {
  answered: 'Answered',
  approved: 'Approved',
  rejected: 'Rejected',
  expired: 'Expired',
}

// Every closed request on the event as one timeline, newest first.
// Open (pending) requests are shown separately at the top of the page.
export function requestHistory(clarifications, event) {
  const items = [
    ...(clarifications || []).map((item) => ({ kind: 'clarification', item })),
    ...(event.change_requests || []).map((item) => ({ kind: 'change', item })),
    ...(event.cancellation_requests || []).map((item) => ({ kind: 'cancellation', item })),
  ]
  return items
    .filter(({ item }) => item.status !== 'pending')
    .map(({ kind, item }) => ({
      kind,
      id: `${kind}-${item.id}`,
      label: KIND_LABELS[kind],
      outcome: OUTCOME_LABELS[item.status] || statusLabel(item.status),
      status: item.status,
      openedAt: item.created_at,
      closedAt: item.closed_at,
      item,
    }))
    .sort((first, second) => new Date(second.closedAt || second.openedAt)
      - new Date(first.closedAt || first.openedAt))
}

// Attendees only need to know whether the event is still going ahead.
// Internal stages and open requests are not theirs to see: a pending
// change or cancellation has not changed anything yet.
export function attendeeEventNote(status, endTime) {
  if (status === 'cancelled') return 'This event has been cancelled.'
  if (status === 'completed' || (endTime && new Date(endTime) < new Date())) {
    return 'This event has ended.'
  }
  return ''
}
