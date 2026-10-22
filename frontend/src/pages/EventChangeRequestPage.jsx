import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'

import {
  getMyEvent,
  submitEventChangeRequest,
} from '../api/events'
import AppShell from '../components/AppShell'
import SessionFields from '../components/SessionFields'
import { useAuth } from '../context/AuthContext'
import {
  changeSessionToPayload,
  sessionsForChange,
  validateChangeSessions,
} from '../changeRequestSessions'
import { EVENT_CATEGORIES, OTHER_CATEGORY } from '../eventCategories'
import { CHANGEABLE_STATUSES } from '../eventDisplay'

// The whole event in one change request: its details and every session it
// should have afterwards (T7-280). The current values are prefilled.
function formFromEvent(event) {
  return {
    name: event.name ?? '',
    description: event.description ?? '',
    reason_for_change: '',
    purpose: event.purpose ?? '',
    category: event.category ?? '',
    category_other: event.category_other ?? '',
    accessibility_requirements: event.accessibility_requirements ?? '',
    sessions: sessionsForChange(event.sessions),
  }
}

function toPayload(form) {
  return {
    name: form.name.trim(),
    description: form.description.trim(),
    reason_for_change: form.reason_for_change.trim(),
    purpose: form.purpose.trim(),
    category: form.category,
    category_other: form.category === OTHER_CATEGORY
      ? form.category_other.trim()
      : null,
    accessibility_requirements: form.accessibility_requirements.trim() || null,
    sessions: form.sessions.map(changeSessionToPayload),
  }
}

// Everything except the reason, so an untouched form counts as no change.
function comparable(payload) {
  const { reason_for_change: _reason, ...eventDetails } = payload
  return JSON.stringify(eventDetails)
}

function validate(form, baseline) {
  const errors = {}
  for (const field of ['name', 'description', 'reason_for_change', 'purpose', 'category']) {
    if (!String(form[field] ?? '').trim()) errors[field] = 'This field is required.'
  }
  if (form.category === OTHER_CATEGORY && !form.category_other.trim()) {
    errors.category_other = 'Describe the category when choosing Other.'
  }
  return {
    fieldErrors: errors,
    sessionError: validateChangeSessions(form.sessions),
    noChanges: comparable(toPayload(form)) === comparable(baseline),
  }
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
  const [baseline, setBaseline] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [attempted, setAttempted] = useState(false)

  useEffect(() => {
    getMyEvent(eventId, token)
      .then(({ event: current }) => {
        const initial = formFromEvent(current)
        setEvent(current)
        setForm(initial)
        setBaseline(toPayload(initial))
      })
      .catch((caught) => setError(caught.message))
      .finally(() => setLoading(false))
  }, [eventId, token])

  const validation = useMemo(
    () => (attempted && form && baseline ? validate(form, baseline) : {}),
    [attempted, form, baseline],
  )
  const fieldErrors = validation.fieldErrors || {}
  const sessionError = validation.sessionError || ''
  const noChanges = Boolean(validation.noChanges)
  const eligible = event && CHANGEABLE_STATUSES.includes(event.status)
  const canSubmit = !submitting && Object.keys(fieldErrors).length === 0
    && !sessionError && !noChanges

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
    const result = validate(form, baseline)
    if (Object.keys(result.fieldErrors).length > 0 || result.sessionError || result.noChanges) return

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
            The current event details and sessions are prefilled. Change what
            you need, then submit for your Coordinator to review.
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
              <label htmlFor="accessibility_requirements">Accessibility requirements</label>
              <textarea id="accessibility_requirements" rows={3} value={form.accessibility_requirements} onChange={updateField('accessibility_requirements')} />
              <p className="field__hint">Optional. Leave blank if none are required.</p>
            </div>
            <div className="field">
              <label htmlFor="reason_for_change">Reason for change</label>
              <textarea id="reason_for_change" rows={3} value={form.reason_for_change} onChange={updateField('reason_for_change')} {...fieldProps('reason_for_change')} />
              <FieldError id="reason_for_change-error" message={fieldErrors.reason_for_change} />
              <p className="field__hint">Briefly explain why these event details need to change.</p>
            </div>
          </section>

          <section className="stack stack--tight">
            <h2 className="section-title">Sessions</h2>
            <p className="field__hint">
              Edit, add or remove sessions. Changing a session&apos;s time may
              mean its venue and equipment have to be booked again.
            </p>
            <SessionFields
              sessions={form.sessions}
              onChange={(sessions) => {
                setForm((current) => ({ ...current, sessions }))
                setError('')
              }}
              isLocked={(session) => session.locked}
            />
          </section>

          {error && <p className="form-error" role="alert">{error}</p>}
          {sessionError && <p className="form-error" role="alert">{sessionError}</p>}
          {attempted && noChanges && (
            <p className="form-error" role="alert">
              Change at least one event detail or session before submitting.
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
