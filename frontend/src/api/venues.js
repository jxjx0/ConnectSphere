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
