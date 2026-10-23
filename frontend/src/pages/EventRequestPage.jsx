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
import { formatDateRange, optional } from '../eventDisplay'
import {
  categoryLabel,
  EVENT_CATEGORIES,
  OTHER_CATEGORY,
} from '../eventCategories'
import {
  emptySession,
  sessionFromSaved,
  sessionLabel,
  sessionToPayload,
  sortSessionsByStart,
  validateSessions,
} from '../eventSessions'
import { validateCategoryOther, validateEventDetails } from '../validation'

function emptyForm() {
  return {
    name: '',
    description: '',
    purpose: '',
    category: '',
    categoryOther: '',
    accessibilityRequirements: '',
    sessions: [emptySession()],
  }
}

// A saved draft back into form state. Anything not filled in yet comes
// back as null, which the inputs show as empty. A draft saved with no
// sessions still opens with one empty session to fill in.
function formFromDraft(draft) {
  const sessions = (draft.sessions ?? []).map(sessionFromSaved)
  return {
    name: draft.name ?? '',
    description: draft.description ?? '',
    purpose: draft.purpose ?? '',
    category: draft.category ?? '',
    categoryOther: draft.category_other ?? '',
    accessibilityRequirements: draft.accessibility_requirements ?? '',
    sessions: sessions.length ? sessions : [emptySession()],
  }
}

// Form state into the body the backend expects. Used for both saving a
// draft and submitting.
function toPayload(form) {
  return {
    name: form.name,
    description: form.description,
    purpose: form.purpose,
    category: form.category || null,
    category_other:
      form.category === OTHER_CATEGORY ? form.categoryOther : null,
    accessibility_requirements: form.accessibilityRequirements,
    sessions: form.sessions.map(sessionToPayload),
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
  // True while the Organiser checks their details before sending them
  // (T7-215: review all sessions before submitting).
  const [reviewing, setReviewing] = useState(false)
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

  function updateSessionField(index, field) {
    return (event) => {
      const sessions = form.sessions.map((session, position) =>
        position === index ? { ...session, [field]: event.target.value } : session,
      )
      setForm({ ...form, sessions })
    }
  }

  function addSession() {
    setForm({ ...form, sessions: [...form.sessions, emptySession()] })
  }

  function removeSession(index) {
    setForm({
      ...form,
      sessions: form.sessions.filter((_, position) => position !== index),
    })
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

  // The form's own submit button checks everything, then shows the review
  // screen. Nothing is sent until the Organiser confirms there.
  function handleReview(event) {
    event.preventDefault()
    setError('')
    setSavedMessage('')

    const validationError =
      validateEventDetails(form) ||
      validateCategoryOther(form.category, form.categoryOther) ||
      validateSessions(form.sessions)
    if (validationError) {
      setError(validationError)
      return
    }

    setReviewing(true)
    window.scrollTo(0, 0)
  }

  async function handleSubmit() {
    setError('')
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
                setReviewing(false)
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

  if (reviewing) {
    const sessions = sortSessionsByStart(form.sessions)
    return (
      <AppShell>
        <div className="content">
          <div className="content__header">
            <h1>Review your request</h1>
            <p className="lead">
              Check the details below. Nothing has been sent yet.
            </p>
          </div>

          <section className="stack stack--tight">
            <h2 className="section-title">Event details</h2>
            <dl className="detail-list">
              <div className="detail-list__row">
                <dt>Event name</dt>
                <dd>{form.name}</dd>
              </div>
              <div className="detail-list__row">
                <dt>Category</dt>
                <dd>{categoryLabel(form.category, form.categoryOther)}</dd>
              </div>
              <div className="detail-list__row">
                <dt>Purpose</dt>
                <dd>{form.purpose}</dd>
              </div>
              <div className="detail-list__row">
                <dt>Description</dt>
                <dd>{form.description}</dd>
              </div>
              <div className="detail-list__row">
                <dt>Accessibility</dt>
                <dd>{optional(form.accessibilityRequirements)}</dd>
              </div>
            </dl>
          </section>

          <section className="stack stack--tight">
            <h2 className="section-title">Sessions ({sessions.length})</h2>
            {sessions.map((session) => (
              <div className="session-card" key={session.formKey}>
                <h3>{session.name}</h3>
                <dl className="detail-list">
                  <div className="detail-list__row">
                    <dt>When</dt>
                    <dd>{formatDateRange(session.startTime, session.endTime)}</dd>
                  </div>
                  <div className="detail-list__row">
                    <dt>Attendance</dt>
                    <dd>{session.expectedAttendance}</dd>
                  </div>
                  <div className="detail-list__row">
                    <dt>Location</dt>
                    <dd>{optional(session.locationPreference)}</dd>
                  </div>
                  <div className="detail-list__row">
                    <dt>Layout</dt>
                    <dd>{optional(session.layoutPreference)}</dd>
                  </div>
                  <div className="detail-list__row">
                    <dt>Equipment</dt>
                    <dd>{optional(session.equipmentRequirements)}</dd>
                  </div>
                </dl>
              </div>
            ))}
          </section>

          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}

          <div className="form-actions form-actions--wide">
            <button
              type="button"
              className="button"
              onClick={handleSubmit}
              disabled={submitting}
            >
              {submitting ? 'Submitting…' : 'Submit request'}
            </button>
            <button
              type="button"
              className="button button--secondary"
              onClick={() => {
                setError('')
                setReviewing(false)
              }}
              disabled={submitting}
            >
              Back to edit
            </button>
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

        <form className="form" onSubmit={handleReview}>
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

            <div className="field">
              <label htmlFor="accessibilityRequirements">
                Accessibility requirements
              </label>
              <textarea
                id="accessibilityRequirements"
                name="accessibilityRequirements"
                rows={3}
                aria-describedby="accessibility-hint"
                value={form.accessibilityRequirements}
                onChange={updateField('accessibilityRequirements')}
              />
              <p className="field__hint" id="accessibility-hint">
                Optional. Applies to the whole event.
              </p>
            </div>
          </section>

          <section className="stack stack--tight">
            <h2 className="section-title">Sessions</h2>
            <p className="field__hint">
              Add a session for each block of time or each space you need.
              Sessions can run at the same time &mdash; for example a main
              programme and breakout rooms.
            </p>

            {form.sessions.map((session, index) => {
              // Ids must be unique on the page, so they carry the session's
              // place on the form.
              const id = (field) => `session-${index}-${field}`
              return (
                <fieldset className="session-card" key={session.formKey}>
                  <legend>{sessionLabel(session, index)}</legend>

                  <div className="field">
                    <label htmlFor={id('name')}>Session name</label>
                    <input
                      id={id('name')}
                      maxLength={200}
                      placeholder="For example: Main programme, Breakout A"
                      value={session.name}
                      onChange={updateSessionField(index, 'name')}
                      required
                    />
                  </div>

                  <div className="field">
                    <label htmlFor={id('start')}>Starts</label>
                    <input
                      id={id('start')}
                      type="datetime-local"
                      value={session.startTime}
                      onChange={updateSessionField(index, 'startTime')}
                      required
                    />
                  </div>

                  <div className="field">
                    <label htmlFor={id('end')}>Ends</label>
                    <input
                      id={id('end')}
                      type="datetime-local"
                      value={session.endTime}
                      onChange={updateSessionField(index, 'endTime')}
                      required
                    />
                  </div>

                  <div className="field">
                    <label htmlFor={id('attendance')}>Expected attendance</label>
                    <input
                      id={id('attendance')}
                      type="number"
                      min={1}
                      value={session.expectedAttendance}
                      onChange={updateSessionField(index, 'expectedAttendance')}
                      required
                    />
                  </div>

                  <div className="field">
                    <label htmlFor={id('location')}>Preferred location</label>
                    <input
                      id={id('location')}
                      aria-describedby={id('location-hint')}
                      value={session.locationPreference}
                      onChange={updateSessionField(index, 'locationPreference')}
                    />
                    <p className="field__hint" id={id('location-hint')}>
                      Optional. Your Coordinator selects the actual venue.
                    </p>
                  </div>

                  <div className="field">
                    <label htmlFor={id('layout')}>Preferred room layout</label>
                    <input
                      id={id('layout')}
                      aria-describedby={id('layout-hint')}
                      value={session.layoutPreference}
                      onChange={updateSessionField(index, 'layoutPreference')}
                    />
                    <p className="field__hint" id={id('layout-hint')}>
                      Optional. For example: theatre, classroom, banquet.
                    </p>
                  </div>

                  <div className="field">
                    <label htmlFor={id('equipment')}>Equipment requirements</label>
                    <textarea
                      id={id('equipment')}
                      rows={3}
                      aria-describedby={id('equipment-hint')}
                      value={session.equipmentRequirements}
                      onChange={updateSessionField(index, 'equipmentRequirements')}
                    />
                    <p className="field__hint" id={id('equipment-hint')}>
                      Optional. Describe what you need &mdash; Technical
                      Support will match it to available equipment.
                    </p>
                  </div>

                  {/* An event always keeps at least one session. */}
                  {form.sessions.length > 1 && (
                    <button
                      type="button"
                      className="button button--secondary button--small"
                      onClick={() => removeSession(index)}
                    >
                      Remove {sessionLabel(session, index)}
                    </button>
                  )}
                </fieldset>
              )
            })}

            <div>
              <button
                type="button"
                className="button button--secondary"
                onClick={addSession}
              >
                + Add session
              </button>
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
              disabled={saving || deleting}
            >
              Review request
            </button>
            {/* type="button" so saving skips the browser's required-field
                checks: a draft may be incomplete. */}
            <button
              type="button"
              className="button button--secondary"
              onClick={handleSaveDraft}
              disabled={saving || deleting}
            >
              {saving ? 'Saving…' : 'Save as draft'}
            </button>
            {/* Only once there is a saved draft to delete. */}
            {draftId && (
              <button
                type="button"
                className="button button--danger"
                onClick={handleDeleteDraft}
                disabled={saving || deleting}
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
