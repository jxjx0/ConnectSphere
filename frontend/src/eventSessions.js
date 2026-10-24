// Sessions on the event request form (T7-274, T7-275). An event is made of
// one or more sessions, each with its own time, attendance and space and
// equipment needs -- for example a main programme and three breakout rooms
// at the same time. Kept out of the page so the rules can be tested.

// Each session on the form needs a stable React key, even before it has
// been saved. This counter is only used on the page, never sent.
let nextFormKey = 1

export function emptySession() {
  return {
    formKey: nextFormKey++,
    name: '',
    startTime: '',
    endTime: '',
    expectedAttendance: '',
    locationPreference: '',
    layoutPreference: '',
    equipmentRequirements: '',
  }
}

// The datetime-local input wants "2026-10-03T14:30" in the browser's local
// time, so a stored UTC timestamp is converted back before it is shown.
export function toDateTimeInput(value) {
  if (!value) return ''
  const date = new Date(value)
  const pad = (part) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

// A saved session (from the backend) back into form state. Anything not
// filled in yet comes back as null, which the inputs show as empty.
export function sessionFromSaved(saved) {
  return {
    ...emptySession(),
    // The saved session's id, so a change request can say which session it
    // edits (T7-280). New sessions have none.
    id: saved.id ?? null,
    name: saved.name ?? '',
    startTime: toDateTimeInput(saved.start_time),
    endTime: toDateTimeInput(saved.end_time),
    expectedAttendance:
      saved.expected_attendance == null ? '' : String(saved.expected_attendance),
    locationPreference: saved.location_preference ?? '',
    layoutPreference: saved.layout_preference ?? '',
    equipmentRequirements: saved.equipment_requirements ?? '',
  }
}

// Form state into the shape the backend expects. Used for both saving a
// draft and submitting, so empty inputs are sent as null rather than
// failing to convert.
export function sessionToPayload(session) {
  return {
    name: session.name,
    // The datetime-local input has no timezone, so send the browser's
    // local time as an explicit UTC timestamp.
    start_time: session.startTime
      ? new Date(session.startTime).toISOString()
      : null,
    end_time: session.endTime ? new Date(session.endTime).toISOString() : null,
    expected_attendance: session.expectedAttendance
      ? Number(session.expectedAttendance)
      : null,
    location_preference: session.locationPreference,
    layout_preference: session.layoutPreference,
    equipment_requirements: session.equipmentRequirements,
  }
}

// What a session is called in messages: its name, or its place on the form
// while it has none.
export function sessionLabel(session, index) {
  return session.name.trim() || `Session ${index + 1}`
}

// Mirrors EventSessionSubmit and EventSubmitRequest in
// backend/models/event.py, so the Organiser sees a problem before a round
// trip. The backend remains the real boundary. Returns the first problem,
// or null. `now` is a parameter so tests do not depend on the clock.
export function validateSessions(sessions, now = new Date()) {
  if (!sessions.length) return 'Add at least one session.'

  for (const [index, session] of sessions.entries()) {
    const label = sessionLabel(session, index)
    if (!session.name.trim()) return `${label}: Give every session a name.`
    if (!session.startTime || !session.endTime) {
      return `${label}: Start and end times are required.`
    }

    const start = new Date(session.startTime)
    const end = new Date(session.endTime)
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return `${label}: Start and end times must be valid dates.`
    }
    if (end <= start) return `${label}: End time must be after the start time.`
    if (start <= now) return `${label}: Start time must be in the future.`

    if (!session.expectedAttendance || Number(session.expectedAttendance) <= 0) {
      return `${label}: Expected attendance must be a positive number.`
    }
  }
  return null
}

// Sessions in the order they happen. Sessions without a start time yet go
// last, in the order they were added. Returns a new array.
export function sortSessionsByStart(sessions) {
  return [...sessions].sort((first, second) => {
    if (!first.startTime) return second.startTime ? 1 : 0
    if (!second.startTime) return -1
    return new Date(first.startTime) - new Date(second.startTime)
  })
}
