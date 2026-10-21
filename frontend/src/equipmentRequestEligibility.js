const ELIGIBLE_EVENT_STATUSES = new Set(['planning', 'confirmed'])

export function equipmentRequestEligibleEvents(events) {
  return events.filter((event) => ELIGIBLE_EVENT_STATUSES.has(event.status))
}

// The sessions of this event that have no equipment request yet, in time
// order. Each session gets its own request (T7-279).
export function sessionsWithoutEquipmentRequest(event, requests) {
  const requested = new Set(requests.map((request) => request.session_id))
  return [...(event.sessions || [])]
    .filter((session) => !requested.has(session.id))
    .sort((first, second) => new Date(first.start_time) - new Date(second.start_time))
}
