import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { createVenue, getVenues } from '../api/venues'
import AppShell from '../components/AppShell'
import { useAuth } from '../context/AuthContext'
import {
  validateAccessibility,
  validateOperatingHours,
  validateVenueLayouts,
  validateVenueName,
} from '../validation'

const EMPTY_LAYOUT = { name: '', capacity: '' }

function emptyForm() {
  return {
    name: '',
    location: '',
    capacity: '',
    facilities: '',
    accessibility: [],
    layouts: [{ ...EMPTY_LAYOUT }],
    open: '',
    close: '',
  }
}

function formatFacilities(facilities) {
  if (facilities === null || facilities === undefined) return 'None entered'
  if (Array.isArray(facilities)) return facilities.join(', ') || 'None entered'
  if (typeof facilities === 'object') {
    return Object.entries(facilities)
      .map(([name, value]) => `${name}: ${String(value)}`)
      .join(', ') || 'None entered'
  }
  return String(facilities)
}

export default function VenuePage({ createMode = false }) {
  const { token } = useAuth()
  const navigate = useNavigate()
  const [form, setForm] = useState(emptyForm)
  const [venues, setVenues] = useState([])
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (createMode) return

    getVenues(token)
      .then((data) => setVenues(data.venues))
      .catch((caught) => setError(caught.message))
      .finally(() => setLoading(false))
  }, [createMode, token])

  function updateField(field, value) {
    setForm((current) => ({ ...current, [field]: value }))
  }

  function updateLayout(index, field, value) {
    setForm((current) => ({
      ...current,
      layouts: current.layouts.map((layout, layoutIndex) =>
        layoutIndex === index ? { ...layout, [field]: value } : layout,
      ),
    }))
  }

  function updateAccessibility(index, value) {
    setForm((current) => ({
      ...current,
      accessibility: current.accessibility.map((feature, featureIndex) =>
        featureIndex === index ? value : feature,
      ),
    }))
  }

  function validateForm() {
    return (
      validateVenueName(form.name) ||
      (!form.capacity || Number(form.capacity) <= 0
        ? 'Overall capacity must be positive.'
        : null) ||
      validateVenueLayouts(form.layouts) ||
      validateAccessibility(form.accessibility) ||
      validateOperatingHours(form.open, form.close)
    )
  }

  async function handleSubmit(event) {
    event.preventDefault()
    setError('')
    setSuccess('')

    const validationError = validateForm()
    if (validationError) {
      setError(validationError)
      return
    }

    setSubmitting(true)
    const payload = {
      name: form.name.trim(),
      location: form.location.trim() || null,
      capacity: Number(form.capacity),
      facilities: form.facilities
        .split(',')
        .map((facility) => facility.trim())
        .filter(Boolean),
      accessibility: form.accessibility.map((feature) => feature.trim()).filter(Boolean),
      layouts: form.layouts.map((layout) => ({
        name: layout.name.trim(),
        capacity: Number(layout.capacity),
      })),
      operating_hours: { open: form.open, close: form.close },
    }

    try {
      await createVenue(payload, token)
      setForm(emptyForm())
      navigate('/venues')
    } catch (caught) {
      setError(caught.message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AppShell>
      <Link to="/dashboard" className="button button--secondary button--small">
        ← Back to Dashboard
      </Link>

      <div className="content__header">
        <h1>{createMode ? 'Create Venue Profile' : 'Venue Catalogue'}</h1>
        <p className="lead">{createMode
          ? 'Add a venue so organisers can include it in event planning.'
          : 'Review venue details, capacity, layouts and accessibility.'}</p>
      </div>

      {createMode && (
        <section className="stack stack--tight">
          <h2 className="section-title">Venue details</h2>

          <form className="form" onSubmit={handleSubmit}>
          <div className="field">
            <label htmlFor="venueName">Venue name</label>
            <input
              id="venueName"
              value={form.name}
              onChange={(event) => updateField('name', event.target.value)}
              maxLength={200}
              required
            />
          </div>

          <div className="field">
            <label htmlFor="location">Location or address</label>
            <input
              id="location"
              value={form.location}
              onChange={(event) => updateField('location', event.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="capacity">Overall capacity</label>
            <input
              id="capacity"
              type="number"
              min="1"
              value={form.capacity}
              onChange={(event) => updateField('capacity', event.target.value)}
              required
            />
          </div>

          <div className="field">
            <label htmlFor="facilities">Facilities</label>
            <input
              id="facilities"
              placeholder="Parking, Wi-Fi"
              value={form.facilities}
              onChange={(event) => updateField('facilities', event.target.value)}
            />
            <p className="field__hint">Separate facilities with commas.</p>
          </div>

          <div className="field">
            <label>Accessibility features</label>
            <div className="repeater">
              {form.accessibility.map((feature, index) => (
                <div className="repeater__row" key={index}>
                  <input
                    aria-label={`Accessibility feature ${index + 1}`}
                    value={feature}
                    onChange={(event) => updateAccessibility(index, event.target.value)}
                  />
                  {form.accessibility.length > 1 && (
                    <button
                      type="button"
                      className="button button--secondary button--small"
                      onClick={() =>
                        setForm((current) => ({
                          ...current,
                          accessibility: current.accessibility.filter(
                            (_, featureIndex) => featureIndex !== index,
                          ),
                        }))
                      }
                    >
                      Remove
                    </button>
                  )}
                </div>
              ))}
            </div>
            <button
              type="button"
              className="button button--secondary button--small"
              onClick={() =>
                setForm((current) => ({
                  ...current,
                  accessibility: [...current.accessibility, ''],
                }))
              }
            >
              Add accessibility feature
            </button>
          </div>

          <div className="field">
            <label>Supported layouts</label>
            <div className="repeater">
              {form.layouts.map((layout, index) => (
                <div className="repeater__row repeater__row--layout" key={index}>
                  <input
                    aria-label={`Layout ${index + 1} name`}
                    placeholder="Layout name"
                    value={layout.name}
                    onChange={(event) => updateLayout(index, 'name', event.target.value)}
                    required
                  />
                  <input
                    aria-label={`Layout ${index + 1} capacity`}
                    type="number"
                    min="1"
                    placeholder="Capacity"
                    value={layout.capacity}
                    onChange={(event) => updateLayout(index, 'capacity', event.target.value)}
                    required
                  />
                  {form.layouts.length > 1 && (
                    <button
                      type="button"
                      className="button button--secondary button--small"
                      onClick={() =>
                        setForm((current) => ({
                          ...current,
                          layouts: current.layouts.filter(
                            (_, layoutIndex) => layoutIndex !== index,
                          ),
                        }))
                      }
                    >
                      Remove
                    </button>
                  )}
                </div>
              ))}
            </div>
            <button
              type="button"
              className="button button--secondary button--small"
              onClick={() =>
                setForm((current) => ({
                  ...current,
                  layouts: [...current.layouts, { ...EMPTY_LAYOUT }],
                }))
              }
            >
              Add layout
            </button>
          </div>

          <div className="field">
            <label>Operating hours</label>
            <div className="repeater__row repeater__row--equal">
              <div className="repeater__field">
                <label htmlFor="openingTime">Opening time</label>
                <input
                  id="openingTime"
                  type="time"
                  value={form.open}
                  onChange={(event) => updateField('open', event.target.value)}
                  required
                />
              </div>
              <div className="repeater__field">
                <label htmlFor="closingTime">Closing time</label>
                <input
                  id="closingTime"
                  type="time"
                  value={form.close}
                  onChange={(event) => updateField('close', event.target.value)}
                  required
                />
              </div>
            </div>
          </div>

          {error && <p className="form-error" role="alert">{error}</p>}
          {success && <p className="form-success" role="status">{success}</p>}

          <div className="form-actions">
            <button type="submit" className="button" disabled={submitting}>
              {submitting ? 'Saving venue…' : 'Save venue'}
            </button>
          </div>
          </form>
        </section>
      )}

      {!createMode && (
      <section className="stack stack--tight">
        <h2 className="section-title">Venue catalogue</h2>
        <div className="form-actions">
          <Link to="/venues/create" className="button">
            Create Venue Profile
          </Link>
        </div>
        {loading && <p className="note">Loading venues…</p>}
        {!loading && venues.length === 0 && <p className="note">No venues have been added yet.</p>}
        {!loading && venues.length > 0 && (
          <div className="table-wrapper">
            <table className="venue-table">
              <caption className="visually-hidden">Venue catalogue</caption>
              <thead>
                <tr>
                  <th scope="col">Venue</th>
                  <th scope="col">Location</th>
                  <th scope="col">Operating hours</th>
                  <th scope="col">Overall capacity</th>
                  <th scope="col">Supported layouts</th>
                  <th scope="col">Accessibility</th>
                  <th scope="col">Facilities</th>
                </tr>
              </thead>
              <tbody>
                {venues.map((venue) => (
                  <tr key={venue.id}>
                    <th scope="row">{venue.name}</th>
                    <td>{venue.location || 'Not provided'}</td>
                    <td>
                      {venue.operating_hours.open}–{venue.operating_hours.close}
                    </td>
                    <td>{venue.capacity}</td>
                    <td>
                      <ul className="table-values">
                        {venue.layouts.map((layout) => (
                          <li key={`${venue.id}-${layout.name}`}>
                            {layout.name} ({layout.capacity})
                          </li>
                        ))}
                      </ul>
                    </td>
                    <td>
                      <ul className="table-values">
                        {venue.accessibility?.length ? (
                          venue.accessibility.map((feature) => (
                            <li key={`${venue.id}-${feature}`}>{feature}</li>
                          ))
                        ) : (
                          <li>None entered</li>
                        )}
                      </ul>
                    </td>
                    <td>{formatFacilities(venue.facilities)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      )}
    </AppShell>
  )
}
