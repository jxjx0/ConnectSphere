// Use the same browser-local-to-UTC convention as the event request forms.
function localTimestamp(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new Error('Enter valid start and end dates and times.')
  }
  const value = new Date(`${date}T${time}`)
  const localDate = `${String(value.getFullYear()).padStart(4, '0')}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
  const localTime = `${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`
  if (!Number.isFinite(value.getTime()) || localDate !== date || localTime !== time || value.getFullYear() < 1) {
    throw new Error('Enter valid start and end dates and times.')
  }
  return value
}

export function venueBlockPayload({ startDate, startTime, endDate, endTime, reason }) {
  const start = localTimestamp(startDate, startTime)
  const end = localTimestamp(endDate, endTime)
  if (end <= start) throw new Error('Block end time must be after start time.')
  const trimmedReason = reason.trim()
  if (!trimmedReason || trimmedReason.length > 500) throw new Error('Enter a reason of 1 to 500 characters.')
  return { start_at: start.toISOString(), end_at: end.toISOString(), block_reason: trimmedReason }
}

export function venueHoldPayload(fields, setupMinutes, now = new Date()) {
  if (!fields.eventId) throw new Error('Select an event.')
  if (!Number.isInteger(setupMinutes) || setupMinutes < 0) throw new Error('Venue setup time is unavailable.')
  const start = localTimestamp(fields.startDate, fields.startTime)
  const end = localTimestamp(fields.endDate, fields.endTime)
  const expiry = localTimestamp(fields.expiryDate, fields.expiryTime)
  if (end <= start) throw new Error('Hold end must be after its start.')
  if (expiry <= now || expiry.getTime() > start.getTime() - setupMinutes * 60000) {
    throw new Error('Expiry must be in the future and no later than setup begins.')
  }
  return { event_id: fields.eventId, start_at: start.toISOString(), end_at: end.toISOString(), expires_at: expiry.toISOString() }
}
