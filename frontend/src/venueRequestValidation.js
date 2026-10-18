/**
 * Checks whether two time ranges overlap.
 */
export function isOverlapping(startA, endA, startB, endB) {
  return new Date(startA) < new Date(endB) && new Date(endA) > new Date(startB)
}

/**
 * Validates layout support and capacity limits against venue profile.
 */
export function validateBookingRequest(booking) {
  const venue = booking?.venues
  if (!venue) return null

  const supportedLayouts = venue.layouts || {}
  const layout = booking.room_layout
  const attendance = booking.events?.expected_attendance || booking.expected_attendance || 0

  if (!(layout in supportedLayouts)) {
    return `The venue does not support the requested layout '${layout}'.`
  }

  const maxCapacity = supportedLayouts[layout]
  if (attendance > maxCapacity) {
    return `Expected attendance (${attendance}) exceeds maximum venue capacity (${maxCapacity}) for layout '${layout}'.`
  }

  return null
}