// Signup field validation, mirrored from the backend's SignupRequest
// (backend/models/profile.py) so bad input is caught before a round trip
// to the API. The backend remains the real boundary -- this is convenience.

import { OTHER_CATEGORY } from './eventCategories'

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

export function validateVenueLayouts(layouts, overallCapacity) {
  if (!layouts.length) return 'At least one supported layout is required.'

  const venueCapacity = Number(overallCapacity)
  const names = []
  for (const layout of layouts) {
    if (!layout.name.trim()) return 'Layout names must not be blank.'
    if (!layout.capacity || Number(layout.capacity) <= 0) {
      return 'Each layout capacity must be positive.'
    }
    if (Number(layout.capacity) > venueCapacity) {
      return 'Layout capacity cannot exceed the overall venue capacity.'
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

export function validateVenueBuffers(setup, turnaround) {
  for (const [label, value] of [['Setup time', setup], ['Turnaround time', turnaround]]) {
    const minutes = Number(value)
    if (value === null || value === undefined || String(value).trim() === ''
        || !Number.isInteger(minutes) || minutes < 0 || minutes > 2147483647) {
      return `${label} must be a non-negative whole number of minutes.`
    }
  }
  return null
}

// Event request field validation, mirrored from the backend's
// EventSubmitRequest (backend/models/event.py). The backend remains the
// real boundary -- this is convenience, so the Organiser sees a problem
// before a round trip to the API.

export function validateEventDetails({ name, description, purpose, category }) {
  if (!name.trim()) return 'Event name must not be blank.'
  if (!description.trim()) return 'Description must not be blank.'
  if (!purpose.trim()) return 'Purpose must not be blank.'
  if (!category) return 'Choose a category.'
  return null
}

// Mirrors validate_category_other in backend/models/event.py: the
// description belongs to the Other choice, and only to it.
export function validateCategoryOther(category, categoryOther) {
  if (category === OTHER_CATEGORY && !categoryOther.trim()) {
    return 'Describe the category when choosing Other.'
  }
  return null
}

export function validateExpectedAttendance(value) {
  if (!value || Number(value) <= 0) {
    return 'Expected attendance must be a positive number.'
  }
  return null
}

export function validateEventTimes(startTime, endTime) {
  if (!startTime || !endTime) return 'Start and end times are required.'

  const start = new Date(startTime)
  const end = new Date(endTime)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return 'Start and end times must be valid dates.'
  }
  if (end <= start) return 'End time must be after the start time.'
  if (start <= new Date()) return 'Start time must be in the future.'
  return null
}
