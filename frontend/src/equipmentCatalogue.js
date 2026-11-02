// Rules for Technical Support's equipment pages, kept out of the pages so
// they can be tested.

// Mirror the Literal values on EquipmentCreate in backend/models/equipment.py.
export const EQUIPMENT_TYPES = ['Audio', 'Visual', 'Staging']
export const EQUIPMENT_STATUSES = ['Functional', 'Under Repair', 'Decommissioned']

export function isBookable(item) {
  return item.maintenance_status === 'Functional'
}

// The colour of a tag for an equipment or request status.
export function statusTagClass(status) {
  if (['Functional', 'Approved'].includes(status)) return 'tag tag--good'
  if (['Under Repair', 'Pending Technical Approval'].includes(status)) return 'tag tag--warning'
  if (['Decommissioned', 'Rejected', 'Affected by Session Change'].includes(status)) return 'tag tag--danger'
  return 'tag'
}

export function uniqueEquipmentNames(catalogue) {
  return [...new Set(catalogue.map((item) => item.name))].sort()
}

// The type of an existing item with this name, to fill in the create form.
export function typeForName(catalogue, name) {
  const search = name.trim().toLowerCase()
  if (!search) return ''
  return catalogue.find((item) => item.name.toLowerCase() === search)?.type || ''
}

export function filterEquipment(catalogue, { name = '', type = '', status = '' }) {
  const search = name.trim().toLowerCase()
  return catalogue.filter((item) => (
    item.name.toLowerCase().includes(search)
    && (!type || item.type === type)
    && (!status || item.maintenance_status === status)
  ))
}

// Whether a request's free-text description mentions this item, by any word
// of its name or by its type. "2 microphones" suggests "Wireless Microphone".
export function matchesRequest(details, item) {
  const text = (details || '').toLowerCase()
  const words = `${item.name} ${item.type}`.toLowerCase().split(/\s+/)
  return words.some((word) => word.length > 2 && text.includes(word.replace(/s$/, '')))
}

const STATE_ORDER = { allocated: 0, available: 1, booked: 2, unavailable: 3 }

// Every catalogue item as an option for one request, given the reservations
// overlapping the time it needs. Allocated items come first, then what can
// be booked with suggestions on top, then what cannot.
export function allocationOptions(catalogue, request, overlappingBookings) {
  const options = catalogue.map((item) => {
    const bookings = overlappingBookings.filter((booking) => booking.equipment_id === item.id)
    const allocated = bookings.some((booking) => booking.request_id === request.id)
    const conflict = bookings.find((booking) => booking.request_id !== request.id)
    let state = 'available'
    if (allocated) state = 'allocated'
    else if (!isBookable(item)) state = 'unavailable'
    else if (conflict) state = 'booked'
    return {
      item,
      state,
      conflict: conflict || null,
      suggested: matchesRequest(request.request_details, item),
    }
  })
  return options.sort((first, second) => (
    STATE_ORDER[first.state] - STATE_ORDER[second.state]
    || Number(second.suggested) - Number(first.suggested)
    || first.item.name.localeCompare(second.item.name)
  ))
}
