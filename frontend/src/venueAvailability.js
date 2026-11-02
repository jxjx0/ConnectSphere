export function calendarVenueOptions(venues, query = '', selectedId = '') {
  const search = query.trim().toLocaleLowerCase()
  return venues.filter((venue) => venue.id === selectedId
    || venue.name.toLocaleLowerCase().includes(search)
    || (venue.location || '').toLocaleLowerCase().includes(search))
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base', numeric: true }))
}

// Local calendar arithmetic follows the existing browser-local date convention.
export function localDateValue(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function localDate(value) {
  const date = new Date(`${value}T00:00:00`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.getTime())
      || localDateValue(date) !== value || date.getFullYear() < 1) {
    throw new Error('Choose a valid date.')
  }
  return date
}

export function shiftCalendarDate(value, days) {
  const date = localDate(value)
  date.setDate(date.getDate() + days)
  return localDateValue(date)
}

export function calendarWeek(value) {
  const first = localDate(value)
  first.setDate(first.getDate() - (first.getDay() + 6) % 7)
  const days = Array.from({ length: 7 }, (_, index) => {
    const start = new Date(first)
    start.setDate(first.getDate() + index)
    const end = new Date(start)
    end.setDate(start.getDate() + 1)
    return { date: localDateValue(start), start, end }
  })
  return { days, range: { start_at: days[0].start.toISOString(), end_at: days[6].end.toISOString() } }
}

export function blocksForDay(items, day) {
  return items.filter((item) => new Date(item.start_at) < day.end && day.start < new Date(item.end_at))
    .sort((a, b) => new Date(a.start_at) - new Date(b.start_at))
}

export function calendarBlockPositions(items, day) {
  const lanes = []
  const segments = blocksForDay(items, day).map((item) => {
    const start = new Date(Math.max(new Date(item.start_at), day.start))
    const end = new Date(Math.min(new Date(item.end_at), day.end))
    let lane = lanes.findIndex((until) => until <= start)
    if (lane < 0) lane = lanes.length
    lanes[lane] = end
    const startMinute = start.getHours() * 60 + start.getMinutes()
    const endMinute = end >= day.end ? 1440 : end.getHours() * 60 + end.getMinutes()
    return { item, lane, top: startMinute / 1440 * 100,
      height: Math.max(endMinute - startMinute, (end - start) / 60000) / 1440 * 100 }
  })
  return segments.map((segment) => ({ ...segment, left: segment.lane / lanes.length * 100, width: 100 / lanes.length }))
}

export function calendarOperatingHours(hours, day) {
  const validTime = value => typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)
  if (!validTime(hours?.open) || !validTime(hours?.close) || hours.close <= hours.open) return null
  const result = { label: `${hours.open}–${hours.close} (Singapore time)`, closed: [] }
  if (!day) return result

  // The grid uses browser-local dates; venue hours always use Singapore time.
  const singaporeDate = new Date(day.start.getTime() + 8 * 3600000).toISOString().slice(0, 10)
  const firstMidnight = new Date(`${singaporeDate}T00:00:00+08:00`).getTime()
  const minutes = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3))
  const closed = []
  let cursor = day.start.getTime()
  for (let midnight = firstMidnight; midnight < day.end.getTime(); midnight += 86400000) {
    const open = Math.max(day.start.getTime(), midnight + minutes(hours.open) * 60000)
    const close = Math.min(day.end.getTime(), midnight + minutes(hours.close) * 60000)
    if (close <= open) continue
    if (cursor < open) closed.push({ start_at: new Date(cursor).toISOString(), end_at: new Date(open).toISOString() })
    cursor = Math.max(cursor, close)
  }
  if (cursor < day.end.getTime()) closed.push({ start_at: new Date(cursor).toISOString(), end_at: day.end.toISOString() })
  result.closed = calendarBlockPositions(closed, day)
  return result
}

export function validateCalendarResponse(data, venueId, range) {
  if (data?.venue?.id !== venueId || !Array.isArray(data.items)
      || !['partial', 'verified'].includes(data.verification_status) || data.sources?.operational_blocks !== 'verified'
      || (data.verification_status === 'verified' && ['confirmed_bookings', 'tentative_holds', 'hold_expiry', 'venue_buffers'].some(source => data.sources[source] !== 'verified'))
      || new Date(data.start_at).getTime() !== new Date(range.start_at).getTime()
      || new Date(data.end_at).getTime() !== new Date(range.end_at).getTime()
      || data.items.some((item) => !['operational_block', 'confirmed_booking', 'tentative_hold'].includes(item.type) || !item.id
        || (item.type === 'tentative_hold' && data.sources.tentative_holds !== 'verified')
        || (item.type === 'confirmed_booking' && data.sources.confirmed_bookings !== 'verified')
        || (item.type === 'tentative_hold' && !Number.isFinite(new Date(item.expires_at).getTime()))
        || typeof item.reason !== 'string' || !item.reason.trim()
        || !Number.isFinite(new Date(item.start_at).getTime())
        || !Number.isFinite(new Date(item.end_at).getTime())
        || new Date(item.end_at) <= new Date(item.start_at))) {
    throw new Error('Unable to verify venue availability data. Please try again.')
  }
  return { ...data, items: data.items.filter(item => item.type !== 'tentative_hold' || new Date(item.expires_at) > new Date()) }
}

export function calendarItemLabel(item) {
  if (item.type === 'operational_block' && item.reason?.startsWith('Approved Booking:')) return 'Recorded block'
  return { operational_block: 'Operational block', confirmed_booking: 'Confirmed booking', tentative_hold: 'Tentative hold' }[item.type]
}

// Compact grid text only; full labels and reasons remain in accessible details.
export function calendarItemShortLabel(item) {
  return { operational_block: 'Blocked', confirmed_booking: 'Confirmed', tentative_hold: 'Hold' }[item.type]
}
