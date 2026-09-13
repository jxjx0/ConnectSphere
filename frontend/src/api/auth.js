// All backend calls live here. Components and pages never call fetch
// directly -- if the API changes, this is the only file that changes.

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000'

// The backend reports problems two ways: {"error": "..."} for a single
// failure, {"errors": [...]} for a list of validation messages. Both end up
// as one thrown Error so callers only handle one shape.
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

export function signup({ fullName, email, password, role, contactNumber, organization }) {
  return request('/signup', {
    method: 'POST',
    body: {
      full_name: fullName,
      email,
      password,
      role,
      contact_number: contactNumber,
      organization,
    },
  })
}

export function login({ email, password }) {
  return request('/login', { method: 'POST', body: { email, password } })
}

export function getMe(token) {
  return request('/me', { token })
}
