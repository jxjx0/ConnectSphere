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
