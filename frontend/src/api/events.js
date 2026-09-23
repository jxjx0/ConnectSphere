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

export function submitEvent(event, token) {
  return request('/events', { method: 'POST', body: event, token })
}

export function getMyEvents(token) {
  return request('/events', { token })
}

export function getMyEvent(eventId, token) {
  return request(`/events/${eventId}`, { token })
}
