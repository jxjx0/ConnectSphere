// The categories an Organiser may choose from, mirrored from
// EventCategory in backend/models/event.py and the events_category_valid
// constraint in database/events.sql. Change all three together.
//
// Choosing "Other" reveals a text box, sent as category_other.

export const EVENT_CATEGORIES = [
  { value: 'conference', label: 'Conference' },
  { value: 'workshop', label: 'Workshop' },
  { value: 'seminar', label: 'Seminar' },
  { value: 'meeting', label: 'Meeting' },
  { value: 'networking', label: 'Networking' },
  { value: 'product_launch', label: 'Product launch' },
  { value: 'training', label: 'Training' },
  { value: 'social_event', label: 'Social event' },
  { value: 'ceremony', label: 'Ceremony' },
  { value: 'other', label: 'Other' },
]

export const OTHER_CATEGORY = 'other'

export function categoryLabel(value, categoryOther) {
  if (value === OTHER_CATEGORY) return categoryOther || 'Other'
  const match = EVENT_CATEGORIES.find((category) => category.value === value)
  return match ? match.label : value
}
