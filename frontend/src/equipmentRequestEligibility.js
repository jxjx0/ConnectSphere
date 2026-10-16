const ELIGIBLE_EVENT_STATUSES = new Set(['planning', 'confirmed'])

export function equipmentRequestEligibleEvents(events) {
  return events.filter((event) => ELIGIBLE_EVENT_STATUSES.has(event.status))
}
