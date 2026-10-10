// T7-31 form validation and request state, shared with the focused Node tests.
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/

export const EMPTY_VENUE_FILTERS = {
  date: '', end_date: '', start_time: '', end_time: '', expected_attendance: '', required_layout: '', required_accessibility: '', required_facility: '',
}
export const INITIAL_VENUE_SEARCH = { phase: 'idle', error: '', venues: [], warnings: [] }

export function validateVenueSearch(form) {
  const times = [form.date, form.start_time, form.end_time]
  if (times.some(Boolean) || form.end_date) {
    if (!times.every(Boolean)) return 'Enter date, start time and end time together to check availability.'
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.date)) return 'Enter a valid date.'
    for (const value of [form.date, form.end_date || form.date]) {
      const date = new Date(`${value}T00:00:00Z`)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.getTime())
          || date.toISOString().slice(0, 10) !== value || Number(value.slice(0, 4)) < 1) return 'Enter a valid date.'
    }
    if (!TIME_PATTERN.test(form.start_time) || !TIME_PATTERN.test(form.end_time)) {
      return 'Enter valid start and end times.'
    }
    if (new Date(`${form.end_date || form.date}T${form.end_time}`) <= new Date(`${form.date}T${form.start_time}`)) {
      return 'End time must be after start time.'
    }
  }
  if (String(form.expected_attendance ?? '').trim()) {
    const attendance = Number(form.expected_attendance)
    if (!Number.isSafeInteger(attendance) || attendance <= 0) {
      return 'Expected attendance must be a positive integer.'
    }
  }
  if ((form.required_layout || '').trim().length > 120) return 'Required layout must be 120 characters or fewer.'
  return null
}

export function venueSearchPayload(form) {
  const payload = {}
  if (form.date && form.start_time && form.end_time) {
    Object.assign(payload, {
      date: form.date, start_time: form.start_time, end_time: form.end_time,
      timezone_offset_minutes: -new Date(`${form.date}T${form.start_time}`).getTimezoneOffset(),
    })
    if (form.end_date) {
      payload.end_date = form.end_date
      payload.end_timezone_offset_minutes = -new Date(`${form.end_date}T${form.end_time}`).getTimezoneOffset()
    }
  }
  if (String(form.expected_attendance ?? '').trim()) payload.expected_attendance = Number(form.expected_attendance)
  if (form.required_layout?.trim()) payload.required_layout = form.required_layout.trim()
  if (form.required_accessibility?.trim()) payload.required_accessibility = normalizeAccessibility(form.required_accessibility)
  if (form.required_facility?.trim()) payload.required_facility = normalizeFacility(form.required_facility)
  return payload
}

export function eventVenueFilters(event, layoutOptions) {
  const start = new Date(event.start_time)
  const end = new Date(event.end_time)
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
    throw new Error('This event has an invalid scheduled period.')
  }
  const pad = (value) => String(value).padStart(2, '0')
  const date = (value) => `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
  const time = (value) => `${pad(value.getHours())}:${pad(value.getMinutes())}`
  const preference = (event.layout_preference || '').trim().toLowerCase()
  return {
    ...EMPTY_VENUE_FILTERS,
    date: date(start), end_date: date(end) === date(start) ? '' : date(end),
    start_time: time(start), end_time: time(end),
    expected_attendance: String(event.expected_attendance),
    required_layout: layoutOptions.find((name) => name.toLowerCase() === preference) || '',
  }
}

export async function runVenueSearch(form, token, search) {
  const error = validateVenueSearch(form)
  if (error) return { phase: 'error', error, venues: [], warnings: [] }
  try {
    const data = await search(venueSearchPayload(form), token)
    return {
      phase: 'success', error: '', venues: data.venues, warnings: data.warnings || [],
      requested_period: form.date ? {
        start: `${form.date}T${form.start_time}`, end: `${form.end_date || form.date}T${form.end_time}`,
      } : null,
    }
  } catch (error) {
    return { phase: 'error', error: error.message, venues: [], warnings: [] }
  }
}

export function venueAvailabilityLabel(venue) {
  if (venue.availability_status === 'not_checked') return 'Availability not checked'
  return venue.availability_status === 'available'
    ? 'Available for the requested period'
    : 'Partially verified'
}

export function venueAvailabilitySummary(result) {
  const timed = result.requested_period || result.venues.some((venue) => venue.requested_start)
  if (!timed || (!result.warnings.length && !result.venues.some((venue) => venue.availability_status === 'unverified'))) return ''
  // TODO: Revisit this temporary summary when real booking/hold occupancy,
  // hold expiry and persisted venue buffers are integrated. Fully verified
  // responses already omit it; keep partial responses honest during integration.
  return 'Availability is partially verified. Operational venue blocks have been checked, but confirmed bookings, tentative holds and setup/turnaround buffers have not all been verified.'
}

export function normalizeAccessibility(value) {
  const name = value.trim().replace(/\s+/g, ' ')
  // Only merge explicit equivalents; retain distinctions such as ramps and lifts.
  return ['wheelchair access', 'wheelchair accessible'].includes(name.toLowerCase())
    ? 'Wheelchair access' : name
}

export function normalizeFacility(value) {
  const name = value.trim().replace(/\s+/g, ' ')
  return ['wi-fi', 'wifi', 'wi fi'].includes(name.toLowerCase()) ? 'Wi-Fi' : name
}

export function venueFacilityOptions(venues) {
  const names = new Map()
  for (const venue of venues) {
    const value = venue.facilities
    let features = []
    if (Array.isArray(value)) features = value.filter((name) => typeof name === 'string')
    else if (typeof value === 'string') features = [value]
    else if (value && typeof value === 'object') {
      // Match backend handling of legacy availability flags/positive quantities.
      features = Object.entries(value)
        .filter(([, available]) => available === true || (typeof available === 'number' && available > 0))
        .map(([name]) => name)
    }
    for (const feature of features) {
      const name = normalizeFacility(feature)
      if (name && !names.has(name.toLowerCase())) names.set(name.toLowerCase(), name)
    }
  }
  return [...names.values()].sort((a, b) => a.localeCompare(b))
}

export function venueAccessibilityOptions(venues) {
  const names = new Map()
  for (const venue of venues) {
    for (const feature of venue.accessibility || []) {
      const name = normalizeAccessibility(feature)
      if (name && !names.has(name.toLowerCase())) names.set(name.toLowerCase(), name)
    }
  }
  return [...names.values()].sort((a, b) => a.localeCompare(b))
}

export function venueLayoutOptions(venues) {
  const names = new Map()
  for (const venue of venues) {
    for (const layout of venue.layouts || []) {
      const name = layout.name.trim()
      const key = name.toLowerCase()
      if (name && !names.has(key)) names.set(key, name)
    }
  }
  return [...names.values()].sort((a, b) => a.localeCompare(b))
}
