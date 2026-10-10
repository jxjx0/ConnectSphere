import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'

import {
  createVenue,
  getVenueHistory,
  getVenues,
  updateVenue,
} from '../api/venues'
import AppShell from '../components/AppShell'
import { useAuth } from '../context/AuthContext'
import {
  validateAccessibility,
  validateOperatingHours,
  validateVenueLayouts,
  validateVenueName,
} from '../validation'
import BlockForm from "../components/BlockForm";

const EMPTY_LAYOUT = { name: '', capacity: '' }

function emptyForm() {
  return {
    name: '',
    location: '',
    capacity: '',
    facilities: [],
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

function formatAuditDate(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unknown date'

  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const hours = date.getHours()
  const hour = hours % 12 || 12
  const period = hours >= 12 ? 'PM' : 'AM'
  return `${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}, `
    + `${hour}:${String(date.getMinutes()).padStart(2, '0')} ${period}`
}

function formatAuditValue(value, field) {
  if (value === null || value === undefined) return 'None'
  if (field === 'operating_hours' && typeof value === 'object') {
    return `${value.open}–${value.close}`
  }
  if (field === 'layouts' && Array.isArray(value)) {
    return value.map((layout) => `${layout.name} (${layout.capacity})`).join(', ')
  }
  if (field === 'accessibility' && Array.isArray(value)) {
    return value.join(', ') || 'None'
  }
  if (field === 'facilities' && Array.isArray(value)) {
    return value.join(', ') || 'None'
  }
  if (field === 'facilities' && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value)
      .map(([name, feature]) => `${name}: ${feature}`)
      .join(', ') || 'None'
  }
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function formatAuditField(field) {
  return {
    operating_hours: 'Operating Hours',
  }[field] || field.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

export default function VenuePage({ createMode = false }) {
  const { token } = useAuth()
  const navigate = useNavigate()
  const { venueId } = useParams()
  const editMode = Boolean(venueId)
  const [form, setForm] = useState(emptyForm)
  const [venues, setVenues] = useState([])
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [blockingVenue, setBlockingVenue] = useState(null)
  const [history, setHistory] = useState([])
  const [historyError, setHistoryError] = useState('')

  useEffect(() => {
    if (createMode) return

    getVenues(token)
      .then((data) => {
        setVenues(data.venues)
        if (editMode) {
          const venue = data.venues.find((candidate) => candidate.id === venueId)
          if (!venue) {
            setError('Venue was not found.')
            return
          }
          setForm({
            name: venue.name,
            location: venue.location || '',
            capacity: String(venue.capacity),
            facilities: Array.isArray(venue.facilities) ? venue.facilities : [],
            accessibility: venue.accessibility || [],
            layouts: venue.layouts.map((layout) => ({
              name: layout.name,
              capacity: String(layout.capacity),
            })),
            open: venue.operating_hours.open,
            close: venue.operating_hours.close,
          })
          getVenueHistory(venueId, token)
            .then((historyData) => setHistory(historyData.history))
            .catch((caught) => setHistoryError(caught.message))
        }
      })
      .catch((caught) => setError(caught.message))
      .finally(() => setLoading(false))
  }, [createMode, editMode, token, venueId])

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

  function updateFacility(index, value) {
    setForm((current) => ({
      ...current,
      facilities: current.facilities.map((facility, facilityIndex) =>
        facilityIndex === index ? value : facility,
      ),
    }))
  }

  function validateForm() {
    return (
      validateVenueName(form.name) ||
      (!form.capacity || Number(form.capacity) <= 0
        ? 'Overall capacity must be positive.'
        : null) ||
      validateVenueLayouts(form.layouts, form.capacity) ||
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
      facilities: form.facilities.map((facility) => facility.trim()).filter(Boolean),
      accessibility: form.accessibility.map((feature) => feature.trim()).filter(Boolean),
      layouts: form.layouts.map((layout) => ({
        name: layout.name.trim(),
        capacity: Number(layout.capacity),
      })),
      operating_hours: { open: form.open, close: form.close },
    }

    try {
      if (editMode) {
        await updateVenue(venueId, payload, token)
      } else {
        await createVenue(payload, token)
      }
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
      {editMode && <Link to="/dashboard" className="button button--secondary button--small">
        ← Back to Dashboard
      </Link>}

      <div className={`content__header${!editMode ? ' venue-search__header' : ''}`}>
        {!editMode && <Link to="/dashboard" className="venue-search__back">
          ← Back to Dashboard
        </Link>}
        <h1>{createMode ? 'Create Venue Profile' : editMode ? 'Edit Venue Profile' : 'Venue Catalogue'}</h1>
        <p className="lead">{createMode
          ? 'Add a venue so organisers can include it in event planning.'
          : editMode
            ? 'Update the venue details used by organisers when planning events.'
          : 'Review venue details, capacity, layouts and accessibility.'}</p>
      </div>

      {editMode && loading && <p className="note">Loading venue…</p>}

      {(createMode || (editMode && !loading && !error)) && (
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
              <label htmlFor="capacity">Maximum Overall Capacity</label>
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
              <label>Facilities (optional)</label>
              <div className="repeater">
                {form.facilities.map((facility, index) => (
                  <div className="repeater__row" key={index}>
                    <input
                      aria-label={`Facility ${index + 1}`}
                      value={facility}
                      onChange={(event) => updateFacility(index, event.target.value)}
                    />
                    <button
                      type="button"
                      className="button button--secondary button--small"
                      onClick={() =>
                        setForm((current) => ({
                          ...current,
                          facilities: current.facilities.filter(
                            (_, facilityIndex) => facilityIndex !== index,
                          ),
                        }))
                      }
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
              <button
                type="button"
                className="button button--secondary button--small"
                onClick={() =>
                  setForm((current) => ({
                    ...current,
                    facilities: [...current.facilities, ''],
                  }))
                }
              >
                Add facility
              </button>
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
                {submitting ? 'Saving venue…' : editMode ? 'Save changes' : 'Save venue'}
              </button>
            </div>
          </form>
        </section>
      )}

      {editMode && !loading && !error && (
        <section className="stack stack--tight">
          <details>
            <summary className="section-title">Edit History</summary>
            {historyError && <p className="form-error" role="alert">{historyError}</p>}
            {history.length === 0 && <p className="note">No edit history yet.</p>}
            {history.length > 0 && (
              <div className="table-wrapper">
                <table className="venue-table">
                  <caption className="visually-hidden">Venue edit history</caption>
                  <thead>
                    <tr>
                      <th scope="col">Date &amp; Time</th>
                      <th scope="col">User</th>
                      <th scope="col">Details</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((record) => (
                      <tr key={record.id}>
                        <td>{formatAuditDate(record.changed_at)}</td>
                        <td>{record.changed_by_name || 'Unknown user'}</td>
                        <td>
                          <ul className="table-values">
                            {record.changed_fields.map((field) => (
                              <li key={`${record.id}-${field}`}>
                                <strong>{formatAuditField(field)}:</strong>{' '}
                                {formatAuditValue(record.old_values[field], field)}
                                {' → '}
                                {formatAuditValue(record.new_values[field], field)}
                              </li>
                            ))}
                          </ul>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </details>
        </section>
      )}

      {!createMode && !editMode && (
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
                      <th scope="row">{venue.name}
                        {/* Button to initiate Blocking of venue */}
                        <br />
                        <Link
                          to={`/venues/${venue.id}/edit`}
                          className="button button--secondary button--small"
                        >
                          Edit
                        </Link>
                        {' '}
                        <button
                          type="button"
                          className="button button--secondary button--small"
                          disabled={blockingVenue !== null}
                          onClick={() => setBlockingVenue(venue)}
                        >
                          Block
                        </button>
                      </th>
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

      {blockingVenue && (
        <BlockForm
          venue={blockingVenue}
          onClose={() => setBlockingVenue(null)}
        />
      )}

    </AppShell>
  )
}
