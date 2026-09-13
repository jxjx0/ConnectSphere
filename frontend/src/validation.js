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
