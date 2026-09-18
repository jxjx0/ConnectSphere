// Signup field validation, mirrored from the backend's SignupRequest
// (backend/models/profile.py) so bad input is caught before a round trip
// to the API. The backend remains the real boundary -- this is convenience.

const PHONE_PATTERN = /^[0-9+()\-\s]{6,30}$/

export function validateFullName(value) {
  if (!value.trim()) return 'Full name must not be blank.'
  return null
}

export function validateContactNumber(value) {
  const trimmed = value.trim()
  if (!trimmed) return 'Contact number must not be blank.'
  if (!PHONE_PATTERN.test(trimmed)) {
    return 'Contact number must be a valid phone number.'
  }
  return null
}

export function validateOrganization(value) {
  const trimmed = value.trim()
  if (!trimmed) return 'Organization must not be blank.'
  if (trimmed.length > 120) {
    return 'Organization must be 120 characters or fewer.'
  }
  return null
}

export function validateVenueName(value) {
  if (!value.trim()) return 'Venue name must not be blank.'
  return null
}

export function validateVenueLayouts(layouts) {
  if (!layouts.length) return 'At least one supported layout is required.'

  const names = []
  for (const layout of layouts) {
    if (!layout.name.trim()) return 'Layout names must not be blank.'
    if (!layout.capacity || Number(layout.capacity) <= 0) {
      return 'Each layout capacity must be positive.'
    }
    const normalizedName = layout.name.trim().toLowerCase()
    if (names.includes(normalizedName)) return 'Layout names must be unique.'
    names.push(normalizedName)
  }
  return null
}

export function validateAccessibility(features) {
  if (features.some((feature) => !feature.trim())) {
    return 'Accessibility features must not be blank.'
  }
  return null
}

export function validateOperatingHours(open, close) {
  if (!open || !close) return 'Opening and closing times are required.'
  if (
    !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(open) ||
    !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(close)
  ) {
    return 'Operating hours must use valid HH:MM values.'
  }
  if (open >= close) return 'Closing time must be after opening time.'
  return null
}
