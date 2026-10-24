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
    throw new Error(message || 'Something went wrong. Please try again.')
  }

  return data
}

export function createVenue(venue, token) {
  return request('/venues', { method: 'POST', body: venue, token })
}

export function updateVenue(venueId, venue, token) {
  return request(`/venues/${venueId}`, { method: 'PUT', body: venue, token })
}

export function getVenueHistory(venueId, token) {
  return request(`/venues/${venueId}/history`, { token })
}

export function getVenues(token) {
  return request('/venues', { token })
}

export function getVenueHoldEvents(token) {
  return request('/venues/holds/events', { token })
}

export function createVenueHold(venueId, hold, token) {
  return request(`/venues/${encodeURIComponent(venueId)}/holds`, { method: 'POST', body: hold, token })
}

export function getVenueAvailability(venueId, range, token) {
  const query = new URLSearchParams(range)
  return request(`/venues/${encodeURIComponent(venueId)}/availability?${query}`, { token })
}

export function searchVenues(criteria, token) {
  return request('/venues/search', { method: 'POST', body: criteria, token })
}

export function createVenueBlock(venueId, block, token) {
  return request(`/venues/${venueId}/blocks`, {
    method: 'POST',
    body: block,
    token,
  })
}

export function createVenueBooking(venueId, booking, token) {
  return request(`/venues/${venueId}/bookings`, {
    method: 'POST',
    body: booking,
    token,
  })
}

export function reviewVenueBooking(bookingId, review, token) {
  return request(`/venues/bookings/${bookingId}/review`, {
    method: 'PATCH',
    body: review,
    token,
  })
}

export function cancelVenueBooking(bookingId, reason, token) {
  return request(`/venues/bookings/${bookingId}/cancel`, {
    method: 'PATCH',
    body: { reason },
    token,
  })
}

export function getVenueBookingsForEvent(eventId, token) {
  return request(`/venues/bookings/event/${encodeURIComponent(eventId)}`, { token })
}

export function getPendingVenueBookings(token, venueId) {
  const query = venueId ? `?venue_id=${encodeURIComponent(venueId)}` : ''
  return request(`/venues/bookings/pending${query}`, { token })
}
