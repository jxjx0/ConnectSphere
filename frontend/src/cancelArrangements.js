// When the Coordinator may cancel a venue booking or equipment request
// (T7-282). The backend checks the same rules; this only decides whether
// to show the Cancel button.

const CANCELLABLE_VENUE_STATUSES = [
  'PENDING_VENUE_APPROVAL', 'APPROVED', 'AFFECTED_BY_UNAVAILABILITY', 'AFFECTED_BY_SESSION_CHANGE',
]
const CANCELLABLE_EQUIPMENT_STATUSES = [
  'Pending Technical Approval', 'Approved', 'Affected by Session Change',
]

// The session's start, or `fallback` for bookings and requests made before
// sessions existed.
function sessionStart(event, sessionId, fallback) {
  const session = (event.sessions || []).find((item) => item.id === sessionId)
  return new Date(session?.start_time || fallback)
}

export function canCancelVenueBooking(event, booking, now = new Date()) {
  return event.status === 'planning'
    && CANCELLABLE_VENUE_STATUSES.includes(booking.status)
    && sessionStart(event, booking.session_id, booking.start_at) > now
}

export function canCancelEquipmentRequest(event, request, now = new Date()) {
  return event.status === 'planning'
    && CANCELLABLE_EQUIPMENT_STATUSES.includes(request.status)
    && sessionStart(event, request.session_id, event.start_time) > now
}
