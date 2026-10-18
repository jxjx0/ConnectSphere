const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000'

async function request(path, { method = 'GET', body, token } = {}) {
  const headers = {}
  if (body) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })

  const data = await response.json().catch(() => ({}))

  if (!response.ok) {
    const message = data.errors ? data.errors.join(' ') : data.error
    const error = new Error(message || 'Something went wrong. Please try again.')
    // Lets a page react to a specific status, e.g. 409 when someone else
    // has already changed the record.
    error.status = response.status
    throw error
  }

  return data
}

export function submitEvent(event, token) {
  return request('/events', { method: 'POST', body: event, token })
}

export function getMyEvents(token) {
  return request('/events', { token })
}

export function getMyEvent(eventId, token) {
  return request(`/events/${eventId}`, { token })
}

export function getMyEventClarifications(eventId, token) {
  return request(`/events/${eventId}/clarifications`, { token })
}

export function respondToEventClarification(eventId, response, token) {
  return request(`/events/${eventId}/clarification-response`, {
    method: 'POST', body: { response }, token,
  })
}

export function getAssignedEventRequests(token) {
  return request('/events/review', { token })
}

export function getAssignedEventRequest(eventId, token) {
  return request(`/events/review/${eventId}`, { token })
}

export function getAssignedEventClarifications(eventId, token) {
  return request(`/events/review/${eventId}/clarifications`, { token })
}

export function requestEventClarification(eventId, notes, token) {
  return request(`/events/review/${eventId}/clarification`, {
    method: 'POST', body: { notes }, token,
  })
}

export function approveAssignedEvent(eventId, token) {
  return request(`/events/review/${eventId}/approve`, {
    method: 'POST',
    token,
  })
}

export function rejectAssignedEvent(eventId, token) {
  return request(`/events/review/${eventId}/reject`, {
    method: 'POST',
    token,
  })
}

export function approveAssignedChangeRequest(eventId, token) {
  return request(`/events/review/${eventId}/change-request/approve`, {
    method: 'POST',
    token,
  })
}

export function rejectAssignedChangeRequest(eventId, reason, token) {
  return request(`/events/review/${eventId}/change-request/reject`, {
    method: 'POST',
    body: { reason },
    token,
  })
}

export function submitEventChangeRequest(eventId, changes, token) {
  return request(`/events/${eventId}/change-requests`, {
    method: 'POST',
    body: changes,
    token,
  })
}

// Drafts (T7-37). A draft needs only a name; submitting one applies the
// same checks as a brand new request.

export function saveDraft(draft, token) {
  return request('/events/drafts', { method: 'POST', body: draft, token })
}

export function getMyDrafts(token) {
  return request('/events/drafts', { token })
}

export function getMyDraft(draftId, token) {
  return request(`/events/drafts/${draftId}`, { token })
}

export function updateDraft(draftId, draft, token) {
  return request(`/events/drafts/${draftId}`, {
    method: 'PUT',
    body: draft,
    token,
  })
}

export function submitDraft(draftId, event, token) {
  return request(`/events/drafts/${draftId}/submit`, {
    method: 'POST',
    body: event,
    token,
  })
}

export function deleteDraft(draftId, token) {
  return request(`/events/drafts/${draftId}`, { method: 'DELETE', token })
}

export function getCoordinators(token) {
  return request('/events/coordinators', { token })
}

export function getEventActivityLogs(eventId, token) {
  return request(`/events/review/${eventId}/history`, { token })
}

export function reassignAssignedEvent(eventId, { newCoordinatorId, reason }, token) {
  return request(`/events/review/${eventId}/reassign`, {
    method: 'POST',
    body: { new_coordinator_id: newCoordinatorId, reason },
    token,
  })
}

// REPLACE getLeadCoordinatorEvents WITH THIS:
export function getLeadCoordinatorEvents(token) {
  return request('/events/lead-overview', { token })
}

export function getUnassignedEventsQueue(token) {
  return request('/events/unassigned-queue', { token })
}

export function getCoordinatorsList(token) {
  return request('/events/coordinators', { token })
}

export function assignCoordinatorToEvent(eventId, coordinatorId, reason = '', token) {
  return request(`/events/review/${eventId}/reassign`, {
    method: 'POST',
    body: { new_coordinator_id: coordinatorId, reason },
    token,
  })
}

export function getSafetyQueue(token) {
  return request('/events/safety/queue', { token })
}

export function getSafetyEventDetails(eventId, token) {
  return request(`/events/safety/review/${eventId}`, { token })
}

export function requestSafetyCheck(eventId, token) {
  return request(`/events/${eventId}/request-safety-check`, {
    method: 'POST',
    token,
  })
}
