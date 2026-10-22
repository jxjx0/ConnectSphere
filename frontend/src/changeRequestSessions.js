// Session rules for the change request form (T7-280). An edited session
// keeps its id, so only its own arrangements are affected; a session
// without an id is new; an existing session left out is removed. Sessions
// that have already started are read-only (scope doc 9.1). The backend
// checks the same rules.

import { sessionFromSaved, sessionToPayload, validateSessions } from './eventSessions.js'

// The event's current sessions as form state, with the ones that have
// already started marked as locked. Decided once when the form opens, so
// editing a time into the past does not lock a session mid-edit.
export function sessionsForChange(savedSessions, now = new Date()) {
  return [...(savedSessions || [])]
    .sort((first, second) => new Date(first.start_time) - new Date(second.start_time))
    .map((saved) => ({
      ...sessionFromSaved(saved),
      locked: new Date(saved.start_time) <= now,
    }))
}

export function changeSessionToPayload(session) {
  return { session_id: session.id ?? null, ...sessionToPayload(session) }
}

// Returns the first problem with the sessions, or null. Locked sessions
// are left as they are, so they are not checked.
export function validateChangeSessions(sessions, now = new Date()) {
  if (!sessions.length) return 'Keep at least one session.'
  return validateSessions(sessions.filter((session) => !session.locked), now)
}

const SESSION_FIELDS = [
  { key: 'name', label: 'Name' },
  { key: 'start_time', label: 'Starts' },
  { key: 'end_time', label: 'Ends' },
  { key: 'expected_attendance', label: 'Expected attendance' },
  { key: 'location_preference', label: 'Preferred location' },
  { key: 'layout_preference', label: 'Preferred layout' },
  { key: 'equipment_requirements', label: 'Equipment needs' },
]

function sameValue(key, first, second) {
  if (key === 'start_time' || key === 'end_time') {
    return new Date(first).getTime() === new Date(second).getTime()
  }
  return String(first ?? '').trim() === String(second ?? '').trim()
}

// What a change request does to the event's sessions, for the
// Coordinator's review. Both lists use the backend's field names.
// Returns { added, removed, edited }; each edited entry lists only the
// fields that differ, as { key, label, before, after }.
export function sessionChanges(currentSessions, proposedSessions) {
  const current = currentSessions || []
  const proposed = proposedSessions || []
  const keptIds = new Set(proposed.map((session) => session.session_id).filter(Boolean))

  const edited = []
  for (const proposal of proposed) {
    const before = current.find((session) => session.id === proposal.session_id)
    if (!before) continue
    const fields = SESSION_FIELDS
      .filter(({ key }) => !sameValue(key, before[key], proposal[key]))
      .map(({ key, label }) => ({ key, label, before: before[key], after: proposal[key] }))
    if (fields.length) edited.push({ session: before, fields })
  }

  return {
    added: proposed.filter((session) => !session.session_id),
    removed: current.filter((session) => !keptIds.has(session.id)),
    edited,
  }
}

// Ids of the sessions a change request moves (any time change) or removes.
// Only these affect bookings: their approved bookings and equipment are
// flagged on approval, and their pending bookings may be cancelled (T7-281).
export function sessionsNeedingRebooking(currentSessions, proposedSessions) {
  const { removed, edited } = sessionChanges(currentSessions, proposedSessions)
  const moved = edited
    .filter(({ fields }) => fields.some(({ key }) => key === 'start_time' || key === 'end_time'))
    .map(({ session }) => session.id)
  return [...moved, ...removed.map((session) => session.id)]
}
