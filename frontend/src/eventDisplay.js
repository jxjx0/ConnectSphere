// Turning stored event values into what a person reads. Shared by the
// event list and the event detail page so both word things the same way.

// Statuses arrive as 'awaiting_clarification'; people read
// "Awaiting clarification".
export function readableStatus(status) {
  const words = status.replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function formatDateTime(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unknown date'

  const hours = date.getHours()
  const hour = hours % 12 || 12
  const period = hours >= 12 ? 'PM' : 'AM'
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}, `
    + `${hour}:${String(date.getMinutes()).padStart(2, '0')} ${period}`
}

// Optional fields are left blank by plenty of Organisers; saying so reads
// better than an empty cell.
export function optional(value) {
  return value || 'None given'
}

// A run of time reads better as one line than two timestamps: same-day
// events show the date once, overnight ones spell both out.
export function formatDateRange(start, end) {
  const from = new Date(start)
  const to = new Date(end)
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return 'Unknown dates'
  }

  if (from.toDateString() === to.toDateString()) {
    return `${formatDate(from)}, ${formatTime(from)} – ${formatTime(to)}`
  }
  return `${formatDateTime(start)} – ${formatDateTime(end)}`
}

function formatDate(date) {
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`
}

function formatTime(date) {
  const hours = date.getHours()
  const hour = hours % 12 || 12
  const period = hours >= 12 ? 'PM' : 'AM'
  return `${hour}:${String(date.getMinutes()).padStart(2, '0')} ${period}`
}

// The path a request normally travels. Off-path statuses (a clarification
// request, a rejection) are not steps -- they are things that happen while
// the request sits at one of these, so they are called out separately.
const PROGRESS_STEPS = [
  { status: 'submitted', label: 'Submitted' },
  { status: 'under_review', label: 'Under review' },
  { status: 'planning', label: 'Planning' },
  { status: 'confirmed', label: 'Confirmed' },
  { status: 'completed', label: 'Completed' },
]

// Where a status sits on that path, and what the Organiser should expect
// next. Keeping the wording here means the page stays a layout.
const PROGRESS_BY_STATUS = {
  submitted: {
    step: 0,
    next: 'An Event Coordinator will be assigned to review your request.',
  },
  under_review: {
    step: 1,
    next: 'Your Coordinator is reviewing the details you submitted.',
  },
  awaiting_clarification: {
    step: 1,
    notice: 'Your Coordinator has asked for more information.',
    next: 'Update the details they have asked about and resubmit.',
  },
  change_requested: {
    step: 1,
    notice: 'Your change request is waiting to be reviewed.',
    next: 'Your Coordinator will decide whether the change can be made.',
  },
  planning: {
    step: 2,
    next: 'Your Coordinator is arranging a venue and any equipment.',
  },
  confirmed: {
    step: 3,
    next: 'Everything is arranged. Your event is going ahead.',
  },
  completed: { step: 4, next: 'This event has finished.' },
  rejected: {
    step: 1,
    ended: true,
    notice: 'This request was not taken forward.',
  },
  cancelled: {
    step: 1,
    ended: true,
    notice: 'This request was cancelled.',
  },
}

export function progressFor(status) {
  const progress = PROGRESS_BY_STATUS[status] || { step: 0 }
  return {
    steps: PROGRESS_STEPS.map((step, index) => ({
      ...step,
      state: stepState(index, progress),
    })),
    notice: progress.notice,
    next: progress.next,
    ended: Boolean(progress.ended),
  }
}

function stepState(index, progress) {
  if (progress.ended) return index < progress.step ? 'done' : 'todo'
  if (index < progress.step) return 'done'
  if (index === progress.step) return 'current'
  return 'todo'
}
