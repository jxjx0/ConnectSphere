// What a Coordinator sees about an event's arrangements, kept out of the pages
// so the rules can be tested.

import { CLOSED_STATUSES } from './eventStatus.js'

const SETTLED_VENUE_STATUSES = ['CANCELLED', 'REJECTED', 'REJECTED_BY_SAFETY']

const isSettled = (booking) => SETTLED_VENUE_STATUSES.includes((booking.status || '').toUpperCase())

// Rejected and cancelled venues only help while planning, when the Coordinator
// can still request another. They come last, after the venues still in play.
export function visibleVenueBookings(event, bookings) {
  if (event.status !== 'planning') return bookings.filter((booking) => !isSettled(booking))
  return [...bookings].sort((first, second) => Number(isSettled(first)) - Number(isSettled(second)))
}

// What still stops a safety check, one line per thing to do. Mirrors
// _safety_check_blockers in backend/services/safety_review_service.py, which
// has the final say. Events from before sessions have none to check.
export function safetyCheckChecklist(event, bookings, equipmentRequests) {
  const sessions = event.sessions || []
  const live = bookings.filter((booking) => !isSettled(booking))
  const items = []

  if (sessions.length === 0 && !live.some((booking) => booking.status === 'APPROVED')) {
    items.push('Get a venue booking approved.')
  }
  for (const session of sessions) {
    const venues = live.filter((booking) => booking.session_id === session.id)
    if (venues.length === 0) items.push(`${session.name}: request a venue.`)
    else if (!venues.some((booking) => booking.status === 'APPROVED')) {
      items.push(`${session.name}: waiting for its venue to be approved.`)
    }
  }
  for (const booking of live) {
    const unmatched = !sessions.some((session) => session.id === booking.session_id)
    if (booking.status !== 'APPROVED' && unmatched) {
      items.push(`${booking.venues?.name || 'A venue'}: waiting for approval, or cancel it.`)
    } else if (booking.status !== 'APPROVED' && live.some((other) => (
      other !== booking && other.session_id === booking.session_id && other.status === 'APPROVED'
    ))) {
      items.push(`${booking.venues?.name || 'A venue'}: every booking must be approved or cancelled.`)
    }
  }

  const activeRequests = equipmentRequests.filter((request) => request.status !== 'Cancelled')
  const sessionName = (request) => (
    sessions.find((session) => session.id === request.session_id)?.name || 'Whole event'
  )
  for (const request of activeRequests) {
    if (request.status === 'Pending Technical Approval') {
      items.push(`${sessionName(request)}: waiting for Technical Support to review its equipment.`)
    } else if (request.status === 'Affected by Session Change') {
      items.push(`${sessionName(request)}: cancel its equipment request and request again.`)
    }
  }
  for (const session of sessions) {
    if ((session.equipment_requirements || '').trim()
      && !activeRequests.some((request) => request.session_id === session.id)) {
      items.push(`${session.name}: request its equipment.`)
    }
  }
  return items
}

// A request is over once it was turned down or cancelled, or its event ended.
export function isPastVenueRequest(booking, event) {
  return isSettled(booking) || CLOSED_STATUSES.includes(event?.status)
}

export function isPastEquipmentRequest(request, event) {
  return ['Rejected', 'Cancelled'].includes(request.status)
    || CLOSED_STATUSES.includes(event?.status)
}

export function venueTagClass(status) {
  if (status === 'APPROVED') return 'tag tag--good'
  if (status === 'PENDING_VENUE_APPROVAL') return 'tag tag--warning'
  if (status === 'CANCELLED') return 'tag'
  return 'tag tag--danger'
}

// One line each on the venues and equipment of an event in the list.
export function venueBadge(bookings) {
  const live = (bookings || []).filter((booking) => booking.status !== 'CANCELLED')
  if (live.length === 0) return { label: 'No Venue', className: 'tag' }
  if (live.some((booking) => ['AFFECTED_BY_UNAVAILABILITY', 'AFFECTED_BY_SESSION_CHANGE'].includes(booking.status))) {
    return { label: 'Venue Affected', className: 'tag tag--danger' }
  }
  if (live.some((booking) => booking.status === 'APPROVED')) {
    return { label: 'Venue Approved', className: 'tag tag--good' }
  }
  if (live.some((booking) => booking.status === 'PENDING_VENUE_APPROVAL')) {
    return { label: 'Venue Pending', className: 'tag tag--warning' }
  }
  return { label: 'Venue Rejected', className: 'tag tag--danger' }
}

// An event has one equipment request per session (T7-279). Any pending
// request makes the event pending, then any rejected one makes it rejected.
export function equipmentBadge(requests) {
  // Cancelled requests are left out (T7-282).
  const statuses = (requests || [])
    .map((request) => request.status?.toLowerCase())
    .filter((status) => status !== 'cancelled')
  if (statuses.length === 0) return null
  // A session moved or was removed (T7-281); the request must be redone.
  if (statuses.includes('affected by session change')) {
    return { label: 'Equipment Affected', className: 'tag tag--danger' }
  }
  if (statuses.every((status) => status === 'approved')) {
    return { label: 'Equipment Approved', className: 'tag tag--good' }
  }
  if (statuses.includes('rejected') && !statuses.includes('pending technical approval')) {
    return { label: 'Equipment Rejected', className: 'tag tag--danger' }
  }
  return { label: 'Equipment Pending', className: 'tag tag--warning' }
}
