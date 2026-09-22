import { useState } from 'react'
import { Link } from 'react-router-dom'

import { submitEvent } from '../api/events'
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

export default function EventRequestPage() {
  const { token } = useAuth()

  const [form, setForm] = useState(emptyForm)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  // Holds the event the backend created, which is what the confirmation
  // message is built from. Null until a request has been submitted.
  const [submitted, setSubmitted] = useState(null)

  function updateField(field) {
    return (event) => setForm({ ...form, [field]: event.target.value })
  }

  async function handleSubmit(event) {
    event.preventDefault()
    setError('')

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
      const data = await submitEvent(
        {
          name: form.name,
          description: form.description,
          purpose: form.purpose,
          category: form.category,
          category_other:
            form.category === OTHER_CATEGORY ? form.categoryOther : null,
          // The datetime-local input has no timezone, so send the
          // browser's local time as an explicit UTC timestamp.
          start_time: new Date(form.startTime).toISOString(),
          end_time: new Date(form.endTime).toISOString(),
          expected_attendance: Number(form.expectedAttendance),
          location_preference: form.locationPreference,
          layout_preference: form.layoutPreference,
          accessibility_requirements: form.accessibilityRequirements,
          equipment_requirements: form.equipmentRequirements,
        },
        token,
      )
      setSubmitted(data.event)
    } catch (caught) {
      setError(caught.message)
    } finally {
      setSubmitting(false)
    }
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
                setSubmitted(null)
              }}
            >
              Submit another request
            </button>
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
          <h1>Request an event</h1>
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

          <div className="form-actions">
            <button type="submit" className="button" disabled={submitting}>
              {submitting ? 'Submitting…' : 'Submit request'}
            </button>
            <Link to="/dashboard">Cancel</Link>
          </div>
        </form>
      </div>
    </AppShell>
  )
}
