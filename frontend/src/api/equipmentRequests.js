const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000'

async function request(path, token, options = {}) {
  const headers = { Authorization: `Bearer ${token}` }
  if (options.body) headers['Content-Type'] = 'application/json'

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  const data = await response.json().catch(() => ({}))

  if (!response.ok) {
    const message = data.errors
      ? data.errors.join(' ')
      : data.error || 'Unable to access equipment requests.'
    const error = new Error(message)
    error.status = response.status
    throw error
  }

  return data
}

export function getEquipmentCatalog(token) {
  return request('/api/equipment', token)
}

export function getEquipmentRequests(token) {
  return request('/equipment-requests', token)
}

export function reviewEquipmentRequest(requestId, decision, token) {
  return request(`/equipment-requests/${requestId}/review`, token, {
    method: 'PATCH',
    body: { decision },
  })
}

export function submitEquipmentRequest(equipmentRequest, token) {
  return request('/equipment-requests', token, {
    method: 'POST',
    body: equipmentRequest,
  })
}

export function getEquipmentBookings(equipmentId, from, to, token) {
  const params = new URLSearchParams({
    equipment_id: equipmentId,
    from: from.toISOString(),
    to: to.toISOString(),
  })
  return request(`/equipment-bookings?${params}`, token)
}

export function getAllEquipmentBookings(from, to, token) {
  const params = new URLSearchParams({
    from: from.toISOString(),
    to: to.toISOString(),
  })
  return request(`/equipment-bookings/calendar?${params}`, token)
}

export function createEquipmentBooking(booking, token) {
  return request('/equipment-bookings', token, {
    method: 'POST',
    body: booking,
  })
}

export function deleteEquipmentBooking(bookingId, token) {
  return request(`/equipment-bookings/${bookingId}`, token, { method: 'DELETE' })
}
