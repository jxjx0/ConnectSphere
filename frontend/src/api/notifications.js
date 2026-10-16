const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000'

async function request(path, { method = 'GET', token } = {}) {
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`

  const response = await fetch(`${API_BASE_URL}${path}`, { method, headers })

  const data = await response.json().catch(() => ({}))

  if (!response.ok) {
    throw new Error(data.error || 'Something went wrong. Please try again.')
  }

  return data
}

// Returns { notifications: [...newest first], unread_count }.
export function getNotifications(token) {
  return request('/notifications', { token })
}

export function markNotificationRead(notificationId, token) {
  return request(`/notifications/${notificationId}/read`, {
    method: 'PATCH',
    token,
  })
}
