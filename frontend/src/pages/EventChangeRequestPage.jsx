import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'

import {
  getMyEvent,
  submitEventChangeRequest,
} from '../api/events'
import AppShell from '../components/AppShell'
import { useAuth } from '../context/AuthContext'
import { EVENT_CATEGORIES, OTHER_CATEGORY } from '../eventCategories'
import { CHANGEABLE_STATUSES } from '../eventDisplay'

const NIL = 'NIL'

function localDateTime(value) {
  const date = new Date(value)
  const pad = (part) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function formFromEvent(event) {
  return {
    name: event.name ?? '',
    description: event.description ?? '',
    reason_for_change: '',
    purpose: event.purpose ?? '',
    category: event.category ?? '',
    category_other: event.category_other ?? '',
    start_time: localDateTime(event.start_time),
    end_time: localDateTime(event.end_time),
    expected_attendance: String(event.expected_attendance ?? ''),
    location_preference: event.location_preference ?? NIL,
    layout_preference: event.layout_preference ?? NIL,
    accessibility_requirements: event.accessibility_requirements ?? NIL,
    equipment_requirements: event.equipment_requirements ?? NIL,
  }
}

function toPayload(form) {
  // Keep the sentinel through the API boundary. The backend converts NIL to
  // null after it has first distinguished it from an empty field.
  const keepNil = (value) => value.trim()
  return {
    ...form,
    category_other: form.category === OTHER_CATEGORY
      ? form.category_other.trim()
      : null,
    start_time: form.start_time && !Number.isNaN(new Date(form.start_time).getTime())
      ? new Date(form.start_time).toISOString()
      : '',
    end_time: form.end_time && !Number.isNaN(new Date(form.end_time).getTime())
      ? new Date(form.end_time).toISOString()
      : '',
    expected_attendance: Number(form.expected_attendance),
    location_preference: keepNil(form.location_preference),
    layout_preference: keepNil(form.layout_preference),
    accessibility_requirements: keepNil(form.accessibility_requirements),
    equipment_requirements: keepNil(form.equipment_requirements),
  }
}

function comparable(payload) {
  const { reason_for_change: _reason, ...eventDetails } = payload
  const nilToNull = (value) => typeof value === 'string'
    && value.trim().toLowerCase() === 'nil'
    ? null
    : value
  return {
    ...eventDetails,
    start_time: eventDetails.start_time.slice(0, 16),
    end_time: eventDetails.end_time.slice(0, 16),
    location_preference: nilToNull(eventDetails.location_preference),
    layout_preference: nilToNull(eventDetails.layout_preference),
    accessibility_requirements: nilToNull(eventDetails.accessibility_requirements),
    equipment_requirements: nilToNull(eventDetails.equipment_requirements),
  }
}

function validate(form, baseline) {
  const errors = {}
  const required = [
    'name', 'description', 'reason_for_change', 'purpose', 'category', 'start_time', 'end_time',
    'expected_attendance', 'location_preference', 'layout_preference',
    'accessibility_requirements', 'equipment_requirements',
  ]
  for (const field of required) {
    if (!String(form[field] ?? '').trim()) errors[field] = 'This field is required.'
  }
  if (form.category === OTHER_CATEGORY && !form.category_other.trim()) {
    errors.category_other = 'Describe the category when choosing Other.'
  }
  if (form.expected_attendance && Number(form.expected_attendance) <= 0) {
    errors.expected_attendance = 'Enter a positive number.'
  }
  if (form.start_time && form.end_time) {
    const start = new Date(form.start_time)
    const end = new Date(form.end_time)
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      errors.start_time = 'Enter valid event dates and times.'
    } else if (end <= start) {
      errors.end_time = 'End time must be after the start time.'
    }
  }

  const current = toPayload(form)
  const unchanged = JSON.stringify(comparable(current))
    === JSON.stringify(comparable(baseline))
  return { fieldErrors: errors, noChanges: unchanged }
}

function FieldError({ id, message }) {
  if (!message) return null
  return <p className="field__error" id={id}>* {message}</p>
}

export default function EventChangeRequestPage() {
  const { token } = useAuth()
  const { eventId } = useParams()
  const navigate = useNavigate()
  const [event, setEvent] = useState(null)
  const [form, setForm] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [attempted, setAttempted] = useState(false)

  useEffect(() => {
    getMyEvent(eventId, token)
      .then(({ event: current }) => {
        setEvent(current)
        setForm(formFromEvent(current))
      })
      .catch((caught) => setError(caught.message))
      .finally(() => setLoading(false))
  }, [eventId, token])

  const baseline = useMemo(() => event ? toPayload(formFromEvent(event)) : null, [event])
  const validation = useMemo(
    () => (attempted && form && baseline ? validate(form, baseline) : {}),
    [attempted, form, baseline],
  )
  const fieldErrors = validation.fieldErrors || {}
  const noChanges = Boolean(validation.noChanges)
  const eligible = event && CHANGEABLE_STATUSES.includes(event.status)
  const canSubmit = !submitting && Object.keys(fieldErrors).length === 0 && !noChanges

  function updateField(field) {
    return (change) => {
      setForm((current) => ({ ...current, [field]: change.target.value }))
      setError('')
    }
  }

  async function handleSubmit(change) {
    change.preventDefault()
    setAttempted(true)
    if (!form) return
    const validationResult = validate(form, baseline)
    if (Object.keys(validationResult.fieldErrors).length > 0 || validationResult.noChanges) return

    setSubmitting(true)
    setError('')
    try {
      await submitEventChangeRequest(eventId, toPayload(form), token)
      navigate(`/my-events/${eventId}`, {
        replace: true,
        state: { changeRequestSubmitted: true },
      })
    } catch (caught) {
      setError(caught.message)
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return <AppShell><p className="page-state">Loading this event request…</p></AppShell>
  }

  if (error && !event) {
    return (
      <AppShell>
        <div className="page-state">
          <p>{error}</p>
          <Link to="/my-events">Back to my event requests</Link>
        </div>
      </AppShell>
    )
  }

  if (!eligible || event.has_pending_change_request) {
    return (
      <AppShell>
        <div className="content">
          <Link to={`/my-events/${eventId}`} className="backlink">← Event details</Link>
          <p className="note">
            {event.has_pending_change_request
              ? 'A change request for this event is already waiting for review.'
              : 'Change requests are available for events under review, in planning or confirmed.'}
          </p>
        </div>
      </AppShell>
    )
  }

  const fieldProps = (name) => ({
    'aria-invalid': Boolean(fieldErrors[name]),
    'aria-describedby': fieldErrors[name] ? `${name}-error` : undefined,
  })

  return (
    <AppShell>
      <div className="content">
        <Link to={`/my-events/${eventId}`} className="backlink">← Event details</Link>

        <div className="content__header">
          <h1>Request an event change</h1>
          <p className="lead">
            Update the details below. The current event details are prefilled;
            change at least one field before submitting. Enter NIL where no
            preference or requirement applies.
          </p>
        </div>

        <form className="form" noValidate onSubmit={handleSubmit}>
          <section className="stack stack--tight">
            <h2 className="section-title">Event details</h2>
            <div className="field">
              <label htmlFor="name">Event name</label>
              <input id="name" maxLength={200} value={form.name} onChange={updateField('name')} {...fieldProps('name')} />
              <FieldError id="name-error" message={fieldErrors.name} />
            </div>
            <div className="field">
              <label htmlFor="category">Category</label>
              <select id="category" value={form.category} onChange={updateField('category')} {...fieldProps('category')}>
                <option value="">Choose a category…</option>
                {EVENT_CATEGORIES.map((category) => <option key={category.value} value={category.value}>{category.label}</option>)}
              </select>
              <FieldError id="category-error" message={fieldErrors.category} />
            </div>
            {form.category === OTHER_CATEGORY && (
              <div className="field">
                <label htmlFor="category_other">Describe the category</label>
                <input id="category_other" maxLength={120} value={form.category_other} onChange={updateField('category_other')} {...fieldProps('category_other')} />
                <FieldError id="category_other-error" message={fieldErrors.category_other} />
              </div>
            )}
            <div className="field">
              <label htmlFor="purpose">Purpose</label>
              <input id="purpose" value={form.purpose} onChange={updateField('purpose')} {...fieldProps('purpose')} />
              <FieldError id="purpose-error" message={fieldErrors.purpose} />
            </div>
            <div className="field">
              <label htmlFor="description">Description</label>
              <textarea id="description" rows={4} value={form.description} onChange={updateField('description')} {...fieldProps('description')} />
              <FieldError id="description-error" message={fieldErrors.description} />
            </div>
            <div className="field">
              <label htmlFor="reason_for_change">Reason for change</label>
              <textarea id="reason_for_change" rows={3} value={form.reason_for_change} onChange={updateField('reason_for_change')} {...fieldProps('reason_for_change')} />
              <FieldError id="reason_for_change-error" message={fieldErrors.reason_for_change} />
              <p className="field__hint">Briefly explain why these event details need to change.</p>
            </div>
          </section>

          <section className="stack stack--tight">
            <h2 className="section-title">When and how many</h2>
            <div className="field">
              <label htmlFor="start_time">Starts</label>
              <input id="start_time" type="datetime-local" value={form.start_time} onChange={updateField('start_time')} {...fieldProps('start_time')} />
              <FieldError id="start_time-error" message={fieldErrors.start_time} />
            </div>
            <div className="field">
              <label htmlFor="end_time">Ends</label>
              <input id="end_time" type="datetime-local" value={form.end_time} onChange={updateField('end_time')} {...fieldProps('end_time')} />
              <FieldError id="end_time-error" message={fieldErrors.end_time} />
            </div>
            <div className="field">
              <label htmlFor="expected_attendance">Expected attendance</label>
              <input id="expected_attendance" type="number" min={1} value={form.expected_attendance} onChange={updateField('expected_attendance')} {...fieldProps('expected_attendance')} />
              <FieldError id="expected_attendance-error" message={fieldErrors.expected_attendance} />
            </div>
          </section>

          <section className="stack stack--tight">
            <h2 className="section-title">Preferences and requirements</h2>
            {[
              ['location_preference', 'Preferred location', 'For example: Central or near an MRT station.'],
              ['layout_preference', 'Preferred room layout', 'For example: theatre, classroom, or banquet.'],
              ['accessibility_requirements', 'Accessibility requirements', 'Enter NIL if none are required.'],
              ['equipment_requirements', 'Equipment requirements', 'Describe what you need, or enter NIL if none are required.'],
            ].map(([name, label, hint]) => (
              <div className="field" key={name}>
                <label htmlFor={name}>{label}</label>
                {name === 'accessibility_requirements' || name === 'equipment_requirements'
                  ? <textarea id={name} rows={3} value={form[name]} onChange={updateField(name)} {...fieldProps(name)} />
                  : <input id={name} value={form[name]} onChange={updateField(name)} {...fieldProps(name)} />}
                <FieldError id={`${name}-error`} message={fieldErrors[name]} />
                <p className="field__hint">{hint}</p>
              </div>
            ))}
          </section>

          {error && <p className="form-error" role="alert">{error}</p>}
          {attempted && noChanges && (
            <p className="form-error" role="alert">
              Change at least one event detail before submitting.
            </p>
          )}
          {attempted && Object.keys(fieldErrors).length > 0 && (
            <p className="form-error" role="alert">Fix the marked fields before submitting.</p>
          )}
          <div className="form-actions">
            <button type="submit" className="button" disabled={!canSubmit}>
              {submitting ? 'Submitting…' : 'Submit change request'}
            </button>
            <Link to={`/my-events/${eventId}`}>Cancel</Link>
          </div>
        </form>
      </div>
    </AppShell>
  )
}
