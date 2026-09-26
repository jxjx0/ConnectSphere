import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'

import {
  deleteDraft,
  getMyDraft,
  saveDraft,
  submitDraft,
  submitEvent,
  updateDraft,
} from '../api/events'
import AppShell from '../components/AppShell'
import { useAuth } from '../context/AuthContext'
import { EVENT_CATEGORIES, OTHER_CATEGORY } from '../eventCategories'
import {
  validateCategoryOther,
  validateEventDetails,
  validateEventTimes,
  validateExpectedAttendance,
} from '../validation'

function emptyForm() {
  return {
    name: '',
    description: '',
    purpose: '',
    category: '',
    categoryOther: '',
    startTime: '',
    endTime: '',
    expectedAttendance: '',
    locationPreference: '',
    layoutPreference: '',
    accessibilityRequirements: '',
    equipmentRequirements: '',
  }
}

// The datetime-local input wants "2026-10-03T14:30" in the browser's local
// time, so a stored UTC timestamp is converted back before it is shown.
function toDateTimeInput(value) {
  if (!value) return ''
  const date = new Date(value)
  const pad = (part) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

// A saved draft back into form state. Anything not filled in yet comes
// back as null, which the inputs show as empty.
function formFromDraft(draft) {
  return {
    name: draft.name ?? '',
    description: draft.description ?? '',
    purpose: draft.purpose ?? '',
    category: draft.category ?? '',
    categoryOther: draft.category_other ?? '',
    startTime: toDateTimeInput(draft.start_time),
    endTime: toDateTimeInput(draft.end_time),
    expectedAttendance:
      draft.expected_attendance == null ? '' : String(draft.expected_attendance),
    locationPreference: draft.location_preference ?? '',
    layoutPreference: draft.layout_preference ?? '',
    accessibilityRequirements: draft.accessibility_requirements ?? '',
    equipmentRequirements: draft.equipment_requirements ?? '',
  }
}

// Form state into the body the backend expects. Used for both saving a
// draft and submitting, so empty inputs are sent as null rather than
// failing to convert.
function toPayload(form) {
  return {
    name: form.name,
    description: form.description,
    purpose: form.purpose,
    category: form.category || null,
    category_other:
      form.category === OTHER_CATEGORY ? form.categoryOther : null,
    // The datetime-local input has no timezone, so send the browser's
    // local time as an explicit UTC timestamp.
    start_time: form.startTime ? new Date(form.startTime).toISOString() : null,
    end_time: form.endTime ? new Date(form.endTime).toISOString() : null,
    expected_attendance: form.expectedAttendance
      ? Number(form.expectedAttendance)
      : null,
    location_preference: form.locationPreference,
    layout_preference: form.layoutPreference,
    accessibility_requirements: form.accessibilityRequirements,
    equipment_requirements: form.equipmentRequirements,
  }
}

export default function EventRequestPage() {
  const { token } = useAuth()
  const navigate = useNavigate()
  // Present when continuing a draft at /my-events/drafts/:draftId.
  const params = useParams()

  const [form, setForm] = useState(emptyForm)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [savedMessage, setSavedMessage] = useState('')
  const [loading, setLoading] = useState(Boolean(params.draftId))
  const [loadError, setLoadError] = useState('')
  // The draft this form is saved into. Null until the first save, so the
  // first save creates a draft and later saves update that same one.
  const [draftId, setDraftId] = useState(params.draftId ?? null)
  // Holds the event the backend created, which is what the confirmation
  // message is built from. Null until a request has been submitted.
  const [submitted, setSubmitted] = useState(null)

  useEffect(() => {
    if (!params.draftId) return
    getMyDraft(params.draftId, token)
      .then((data) => setForm(formFromDraft(data.event)))
      .catch((caught) => setLoadError(caught.message))
      .finally(() => setLoading(false))
  }, [params.draftId, token])

  function updateField(field) {
    return (event) => setForm({ ...form, [field]: event.target.value })
  }

  async function handleSaveDraft() {
    setError('')
    setSavedMessage('')

    // A draft needs only a name; everything else is checked on submit.
    if (!form.name.trim()) {
      setError('Give the draft a name before saving it.')
      return
    }

    setSaving(true)

    try {
      const data = draftId
        ? await updateDraft(draftId, toPayload(form), token)
        : await saveDraft(toPayload(form), token)
      setDraftId(data.event.id)
      setSavedMessage('Draft saved. You can continue it later from your drafts.')
    } catch (caught) {
      setError(caught.message)
    } finally {
      setSaving(false)
    }
  }

  async function handleDeleteDraft() {
    if (!window.confirm('Delete this draft? This cannot be undone.')) return

    setError('')
    setSavedMessage('')
    setDeleting(true)

    try {
      await deleteDraft(draftId, token)
      navigate('/my-events?tab=drafts')
    } catch (caught) {
      setError(caught.message)
      setDeleting(false)
    }
  }

  async function handleSubmit(event) {
    event.preventDefault()
    setError('')
    setSavedMessage('')

    const validationError =
      validateEventDetails(form) ||
      validateCategoryOther(form.category, form.categoryOther) ||
      validateExpectedAttendance(form.expectedAttendance) ||
      validateEventTimes(form.startTime, form.endTime)
    if (validationError) {
      setError(validationError)
      return
    }

    setSubmitting(true)

    try {
      const data = draftId
        ? await submitDraft(draftId, toPayload(form), token)
        : await submitEvent(toPayload(form), token)
      setSubmitted(data.event)
    } catch (caught) {
      setError(caught.message)
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <AppShell>
        <p className="page-state">Loading your draft…</p>
      </AppShell>
    )
  }

  // A draft belonging to someone else, or already submitted, comes back
  // as "not found" -- see get_my_draft in event_service.py.
  if (loadError) {
    return (
      <AppShell>
        <div className="page-state">
          <p>{loadError}</p>
          <Link to="/my-events?tab=drafts">Back to my drafts</Link>
        </div>
      </AppShell>
    )
  }

  if (submitted) {
    return (
      <AppShell>
        <div className="content">
          <div className="content__header">
            <h1>Event request submitted</h1>
          </div>

          <p className="form-success" role="status">
            Thank you. Your request for <strong>{submitted.name}</strong> has
            been submitted to ConnectSphere. An Event Coordinator will be
            assigned to review it and will contact you about the next steps.
          </p>

          <div className="form-actions">
            <button
              type="button"
              className="button button--secondary"
              onClick={() => {
                setForm(emptyForm())
                setDraftId(null)
                setSubmitted(null)
                navigate('/my-events/new')
              }}
            >
              Submit another request
            </button>
            <Link to="/my-events" className="button button--secondary">
              View my requests
            </Link>
            <Link to="/dashboard">Back to dashboard</Link>
          </div>
        </div>
      </AppShell>
    )
  }

  return (
    <AppShell>
      <div className="content">
        <div className="content__header">
          <h1>{draftId ? 'Continue your draft' : 'Request an event'}</h1>
          <p className="lead">
            Tell us about your event. You do not need to choose a venue or
            specific equipment &mdash; describe what you need and your Event
            Coordinator will arrange it.
          </p>
        </div>

        <form className="form" onSubmit={handleSubmit}>
          <section className="stack stack--tight">
            <h2 className="section-title">Event details</h2>

            <div className="field">
              <label htmlFor="name">Event name</label>
              <input
                id="name"
                name="name"
                autoFocus
                maxLength={200}
                value={form.name}
                onChange={updateField('name')}
                required
              />
            </div>

            <div className="field">
              <label htmlFor="category">Category</label>
              <select
                id="category"
                name="category"
                value={form.category}
                onChange={updateField('category')}
                required
              >
                <option value="">Choose a category…</option>
                {EVENT_CATEGORIES.map((category) => (
                  <option key={category.value} value={category.value}>
                    {category.label}
                  </option>
                ))}
              </select>
            </div>

            {form.category === OTHER_CATEGORY && (
              <div className="field">
                <label htmlFor="categoryOther">Describe the category</label>
                <input
                  id="categoryOther"
                  name="categoryOther"
                  maxLength={120}
                  value={form.categoryOther}
                  onChange={updateField('categoryOther')}
                  required
                />
              </div>
            )}

            <div className="field">
              <label htmlFor="purpose">Purpose</label>
              <input
                id="purpose"
                name="purpose"
                value={form.purpose}
                onChange={updateField('purpose')}
                required
              />
            </div>

            <div className="field">
              <label htmlFor="description">Description</label>
              <textarea
                id="description"
                name="description"
                rows={4}
                value={form.description}
                onChange={updateField('description')}
                required
              />
            </div>
          </section>

          <section className="stack stack--tight">
            <h2 className="section-title">When and how many</h2>

            <div className="field">
              <label htmlFor="startTime">Starts</label>
              <input
                id="startTime"
                name="startTime"
                type="datetime-local"
                value={form.startTime}
                onChange={updateField('startTime')}
                required
              />
            </div>

            <div className="field">
              <label htmlFor="endTime">Ends</label>
              <input
                id="endTime"
                name="endTime"
                type="datetime-local"
                value={form.endTime}
                onChange={updateField('endTime')}
                required
              />
            </div>

            <div className="field">
              <label htmlFor="expectedAttendance">Expected attendance</label>
              <input
                id="expectedAttendance"
                name="expectedAttendance"
                type="number"
                min={1}
                value={form.expectedAttendance}
                onChange={updateField('expectedAttendance')}
                required
              />
            </div>
          </section>

          <section className="stack stack--tight">
            <h2 className="section-title">Preferences and requirements</h2>

            <div className="field">
              <label htmlFor="locationPreference">Preferred location</label>
              <input
                id="locationPreference"
                name="locationPreference"
                aria-describedby="location-hint"
                value={form.locationPreference}
                onChange={updateField('locationPreference')}
              />
              <p className="field__hint" id="location-hint">
                Optional. Your Coordinator selects the actual venue.
              </p>
            </div>

            <div className="field">
              <label htmlFor="layoutPreference">Preferred room layout</label>
              <input
                id="layoutPreference"
                name="layoutPreference"
                aria-describedby="layout-hint"
                value={form.layoutPreference}
                onChange={updateField('layoutPreference')}
              />
              <p className="field__hint" id="layout-hint">
                Optional. For example: theatre, classroom, banquet.
              </p>
            </div>

            <div className="field">
              <label htmlFor="accessibilityRequirements">
                Accessibility requirements
              </label>
              <textarea
                id="accessibilityRequirements"
                name="accessibilityRequirements"
                rows={3}
                value={form.accessibilityRequirements}
                onChange={updateField('accessibilityRequirements')}
              />
            </div>

            <div className="field">
              <label htmlFor="equipmentRequirements">
                Equipment requirements
              </label>
              <textarea
                id="equipmentRequirements"
                name="equipmentRequirements"
                rows={3}
                aria-describedby="equipment-hint"
                value={form.equipmentRequirements}
                onChange={updateField('equipmentRequirements')}
              />
              <p className="field__hint" id="equipment-hint">
                Optional. Describe what you need &mdash; Technical Support
                will match it to available equipment.
              </p>
            </div>
          </section>

          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}

          {savedMessage && (
            <p className="form-success" role="status">
              {savedMessage}{' '}
              <Link to="/my-events?tab=drafts">View my drafts</Link>
            </p>
          )}

          <div className="form-actions form-actions--wide">
            <button
              type="submit"
              className="button"
              disabled={submitting || saving || deleting}
            >
              {submitting ? 'Submitting…' : 'Submit request'}
            </button>
            {/* type="button" so saving skips the browser's required-field
                checks: a draft may be incomplete. */}
            <button
              type="button"
              className="button button--secondary"
              onClick={handleSaveDraft}
              disabled={submitting || saving || deleting}
            >
              {saving ? 'Saving…' : 'Save as draft'}
            </button>
            {/* Only once there is a saved draft to delete. */}
            {draftId && (
              <button
                type="button"
                className="button button--danger"
                onClick={handleDeleteDraft}
                disabled={submitting || saving || deleting}
              >
                {deleting ? 'Deleting…' : 'Delete draft'}
              </button>
            )}
            <Link to={draftId ? '/my-events?tab=drafts' : '/dashboard'}>
              Cancel
            </Link>
          </div>
        </form>
      </div>
    </AppShell>
  )
}
