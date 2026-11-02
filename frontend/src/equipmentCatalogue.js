// Rules for Technical Support's equipment pages, kept out of the pages so
// they can be tested.

// Mirrors the Literal values on EquipmentCreate in backend/models/equipment.py.
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

// Mirrors how create_equipment_booking matches an item to a request line.
export function isOfType(item, typeName) {
  return item.type.toLowerCase() === typeName.toLowerCase()
}

export function equipmentTypes(catalogue) {
  return [...new Set(catalogue.map((item) => item.type))].sort()
}

// What a Coordinator can ask for: each type with something usable in it, and
// how many usable items it has.
export function requestableTypes(catalogue) {
  return equipmentTypes(catalogue)
    .map((name) => ({
      name,
      functional: catalogue.filter((item) => isOfType(item, name) && isBookable(item)).length,
    }))
    .filter((type) => type.functional > 0)
}

// --- A request's lines ----------------------------------------------------

// A request's lines with how much of each is allocated. Requests from before
// lines have none.
export function lineProgress(request) {
  const bookings = request?.equipment_bookings || []
  return (request?.lines || []).map((line) => {
    const allocated = bookings.filter((booking) => booking.line_id === line.id).length
    return {
      ...line,
      allocated,
      remaining: Math.max(line.quantity - allocated, 0),
      complete: allocated >= line.quantity,
    }
  })
}

// Whether a request can be approved, which the database also checks. One from
// before lines only needs something allocated.
export function allocationSummary(request) {
  const lines = lineProgress(request)
  const bookings = request?.equipment_bookings || []
  if (lines.length === 0) {
    return { tracked: false, allocated: bookings.length, total: null, remaining: 0, complete: bookings.length > 0 }
  }
  const allocated = lines.reduce((sum, line) => sum + Math.min(line.allocated, line.quantity), 0)
  const total = lines.reduce((sum, line) => sum + line.quantity, 0)
  return { tracked: true, allocated, total, remaining: total - allocated, complete: allocated === total }
}

// What to confirm before removing a booking. An approved request can't be
// allocated to again, so removing from one leaves it short.
export function removeBookingMessage(booking) {
  if (booking.request_status === 'Approved') {
    return `This request for ${booking.event_name} is already approved. `
      + 'If you remove this booking, the request stays approved but will be short by this item, '
      + 'and you won\'t be able to allocate a replacement to it. Remove it anyway?'
  }
  return 'Remove this booking?'
}

// Whether this item could be allocated to the request right now.
export function requestWantsItem(request, item) {
  const lines = lineProgress(request)
  if (lines.length === 0) return true
  return lines.some((line) => isOfType(item, line.item_name) && !line.complete)
}

// --- The Coordinator's request form ---------------------------------------

export const OTHER_EQUIPMENT = 'other'

export function emptyLine() {
  return { choice: '', otherName: '', quantity: '1', specifics: '' }
}

// Starting rows from the Organiser's free text: "2 microphones" finds a type
// whose last word is microphone, with its quantity. The Coordinator checks
// them; anything not recognised is left for them to add.
export function suggestLines(needs, types) {
  const text = (needs || '').toLowerCase()
  const lines = []
  for (const type of types) {
    const word = type.name.toLowerCase().split(/\s+/).pop().replace(/s$/, '')
    if (word.length < 3) continue
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const found = text.match(new RegExp(`(?:(\\d+)\\s+(?:[a-z-]+\\s+)?)?${escaped}`))
    if (found) {
      lines.push({ ...emptyLine(), choice: type.name, quantity: found[1] || '1' })
    }
  }
  return lines.length > 0 ? lines : [emptyLine()]
}

export function lineName(line) {
  return line.choice === OTHER_EQUIPMENT ? line.otherName.trim() : line.choice
}

// The first problem with the rows, in the Coordinator's words.
export function validateLines(lines) {
  if (lines.length === 0) return 'Add the equipment this session needs.'
  const seen = new Set()
  for (const line of lines) {
    const name = lineName(line)
    if (!name) return 'Choose the equipment for every row, or remove the row.'
    if (seen.has(name.toLowerCase())) return `${name} is listed twice. Combine them into one row.`
    seen.add(name.toLowerCase())
    const quantity = Number(line.quantity)
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
      return `Enter a quantity from 1 to 100 for ${name}.`
    }
  }
  return ''
}

export function linesToPayload(lines) {
  return lines.map((line) => ({
    item_name: lineName(line),
    quantity: Number(line.quantity),
    specifics: line.specifics.trim() || null,
  }))
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
export function allocationOptions(
  catalogue,
  request,
  overlappingBookings,
  details = request.request_details,
) {
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
      suggested: matchesRequest(details, item),
    }
  })
  return options.sort((first, second) => (
    STATE_ORDER[first.state] - STATE_ORDER[second.state]
    || Number(second.suggested) - Number(first.suggested)
    || first.item.name.localeCompare(second.item.name)
  ))
}
