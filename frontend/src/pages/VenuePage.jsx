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
  validateVenueBuffers,
  validateVenueLayouts,
  validateVenueName,
} from '../validation'
import BlockForm from "../components/BlockForm";

const EMPTY_LAYOUT = { name: '', capacity: '' }
const VENUES_PER_PAGE = 6

function RequiredMark() {
  return <span aria-hidden="true" style={{ color: 'var(--danger)' }}>*</span>
}

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
    setup_time_minutes: '0',
    turnaround_time_minutes: '0',
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
  if (['setup_time_minutes', 'turnaround_time_minutes'].includes(field)) return `${value} minutes`
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
    setup_time_minutes: 'Setup time',
    turnaround_time_minutes: 'Turnaround time',
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
  const [bufferImpact, setBufferImpact] = useState(null)
  const [query = '', setQuery] = useState('')
  const [page = 1, setPage] = useState(1)
  const visibleVenues = venues.filter((venue) => [venue.name, venue.location].filter(Boolean).join(' ').toLowerCase().includes(query.trim().toLowerCase()))
  const pageCount = Math.max(1, Math.ceil(visibleVenues.length / VENUES_PER_PAGE))
  const currentPage = Math.min(page, pageCount)
  const pageStart = (currentPage - 1) * VENUES_PER_PAGE
  const pagedVenues = visibleVenues.slice(pageStart, pageStart + VENUES_PER_PAGE)
  const editableVenue = editMode && venues.some((venue) => venue.id === venueId)

  useEffect(() => {
    setBufferImpact(null)
    setSuccess('')
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
            setup_time_minutes: String(venue.setup_time_minutes ?? ''),
            turnaround_time_minutes: String(venue.turnaround_time_minutes ?? ''),
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
      validateVenueBuffers(form.setup_time_minutes, form.turnaround_time_minutes) ||
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
      setup_time_minutes: Number(form.setup_time_minutes),
      turnaround_time_minutes: Number(form.turnaround_time_minutes),
    }

    try {
      if (editMode) {
        const result = await updateVenue(venueId, payload, token)
        if (result?.buffer_impact) {
          setBufferImpact(result.buffer_impact)
          setSuccess('Venue updated.')
          return
        }
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
      <div className="content__header venue-search__header">
        <Link to={createMode || editMode ? '/venues' : '/dashboard'} className="venue-search__back"
          aria-label={createMode || editMode ? 'Back to Venue Catalogue' : 'Back to Dashboard'}>
          ← Back
        </Link>
        <div className="venue-workspace__page-title">
          <h1>{createMode ? 'Create Venue Profile' : editMode ? 'Edit Venue Profile' : 'Venue Catalogue'}</h1>
          {!createMode && !editMode && <Link to="/venues/create" className="button">+ Create Venue Profile</Link>}
        </div>
      </div>

      {editMode && loading && <p className="note">Loading venue…</p>}
      {editMode && !loading && !editableVenue && error && <p className="form-error" role="alert">{error}</p>}

      {bufferImpact && <section className="notice stack stack--tight" role="status">
        <p><strong>{success}</strong></p>
        {bufferImpact.status !== 'verified' && <p>Some bookings need manual checking. Your venue changes are saved.</p>}
        {bufferImpact.affected_bookings && <>
          <p>{bufferImpact.affected_bookings.length
            ? `${bufferImpact.affected_bookings.length} booking(s) need review.` : 'No newly affected bookings.'}</p>
          <ul>{bufferImpact.affected_bookings.map(booking => <li key={booking.booking_id}>
            {booking.event_name || 'Venue booking'} — {formatAuditDate(booking.effective_start)}–{formatAuditDate(booking.effective_end)}
            {booking.status_update === 'failed' || booking.status_update === 'unverified'
              ? ' — Booking status could not be verified.' : ''}
            {booking.status_update === 'not_updated' ? ' — Booking changed during review; check its status.' : ''}
            {['failed', 'missing_coordinator'].includes(booking.notification_status) ? ' — Coordinator could not be notified.' : ''}
          </li>)}</ul>
          {bufferImpact.affected_bookings.length > 0 && bufferImpact.status === 'verified' && <p>Coordinators notified.</p>}
        </>}
        <Link to="/venues" className="button button--secondary">Back to Venue Catalogue</Link>
      </section>}

      {!bufferImpact && (createMode || (editableVenue && !loading)) && (
        <section className="venue-profile">
          <nav className="venue-profile__nav" aria-label="Venue profile sections">
            <h2>Venue profile</h2>
            <a href="#venue-basics"><span>01</span> Basic information</a>
            <a href="#venue-layouts"><span>02</span> Layouts &amp; capacity</a>
            <a href="#venue-features"><span>03</span> Facilities &amp; access</a>
            <a href="#venue-hours"><span>04</span> Hours &amp; preparation</a>
          </nav>

          <form className="form venue-profile-form" onSubmit={handleSubmit} aria-busy={submitting}>
            <p className="field__hint">Fields marked * are required.</p>
            <fieldset id="venue-basics" className="venue-profile-form__group">
              <legend><span>01</span> Basic information</legend>
              <div className="field">
                <label htmlFor="venueName">Venue name <RequiredMark /></label>
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

            </fieldset>
            <fieldset id="venue-layouts" className="venue-profile-form__group">
              <legend><span>02</span> Layouts and capacity</legend>
              <div className="field">
                <label htmlFor="capacity">Maximum Overall Capacity <RequiredMark /></label>
                <input
                  id="capacity"
                  type="number"
                  min="1"
                  value={form.capacity}
                  onChange={(event) => updateField('capacity', event.target.value)}
                  required
                />
              </div>
              <p className="field__hint">Add each supported room layout and the number of people it can accommodate.</p>
              <div className="field">
                <span className="venue-profile-form__label">Supported layouts <RequiredMark /></span>
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
                          aria-label={`Remove layout ${index + 1}`}
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

            </fieldset>
            <fieldset id="venue-features" className="venue-profile-form__group">
              <legend><span>03</span> Facilities and accessibility</legend>
              <div className="field">
                <span className="venue-profile-form__label">Facilities</span>
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
                        aria-label={`Remove facility ${index + 1}`}
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
                <span className="venue-profile-form__label">Accessibility features</span>
                <div className="repeater">
                  {form.accessibility.map((feature, index) => (
                    <div className="repeater__row" key={index}>
                      <input
                        aria-label={`Accessibility feature ${index + 1}`}
                        value={feature}
                        onChange={(event) => updateAccessibility(index, event.target.value)}
                      />
                      <button
                        type="button"
                        className="button button--secondary button--small"
                        aria-label={`Remove accessibility feature ${index + 1}`}
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

            </fieldset>
            <fieldset id="venue-hours" className="venue-profile-form__group">
              <legend><span>04</span> Operating hours and preparation</legend>
              <div className="field">
                <span className="venue-profile-form__label">Operating hours</span>
                <div className="repeater__row repeater__row--equal">
                  <div className="repeater__field">
                    <label htmlFor="openingTime">Opening time <RequiredMark /></label>
                    <input
                      id="openingTime"
                      type="time"
                      value={form.open}
                      onChange={(event) => updateField('open', event.target.value)}
                      required
                    />
                  </div>
                  <div className="repeater__field">
                    <label htmlFor="closingTime">Closing time <RequiredMark /></label>
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

              <div className="field">
                <div className="repeater__row repeater__row--equal">
                  <div className="repeater__field">
                    <label htmlFor="setupTime">Setup time (minutes) <RequiredMark /></label>
                    <input id="setupTime" type="number" min="0" step="1" max="2147483647" required
                      aria-describedby="venueBufferHint" value={form.setup_time_minutes}
                      onChange={(event) => updateField('setup_time_minutes', event.target.value)} />
                  </div>
                  <div className="repeater__field">
                    <label htmlFor="turnaroundTime">Turnaround time (minutes) <RequiredMark /></label>
                    <input id="turnaroundTime" type="number" min="0" step="1" max="2147483647" required
                      aria-describedby="venueBufferHint" value={form.turnaround_time_minutes}
                      onChange={(event) => updateField('turnaround_time_minutes', event.target.value)} />
                  </div>
                </div>
                <p className="field__hint" id="venueBufferHint">Time needed before and after each event, used in availability and conflict checks. Enter 0 if none is needed.</p>
              </div>
            </fieldset>

            <div className="venue-profile__save">
              {error && <p className="form-error" role="alert">{error}</p>}
              {success && <p className="form-success" role="status">{success}</p>}
              <div className="form-actions">
                <button type="submit" className="button" disabled={submitting}>
                  {submitting ? 'Saving venue…' : editMode ? 'Save changes' : 'Save venue'}
                </button>
                <Link to="/venues" className="button button--secondary">Back to catalogue</Link>
              </div>
            </div>
          </form>
        </section>
      )}

      {editableVenue && !loading && (
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
        <section className="stack stack--default" aria-label="Venue catalogue">
          <div className="attendee-list-tools attendee-list-tools--search-only">
            <div className="field">
              <label htmlFor="venue-catalogue-search">Search venues</label>
              <input id="venue-catalogue-search" type="search" placeholder="Search by venue name or location"
                value={query} onChange={(event) => { setQuery(event.target.value); setPage(1) }} />
            </div>
            {!loading && !error && <p className="note attendee-result-count" role="status">
              {query.trim() ? `${visibleVenues.length} of ${venues.length}` : venues.length} {venues.length === 1 ? 'venue' : 'venues'}
            </p>}
            {query && <button type="button" className="attendee-text-button" onClick={() => { setQuery(''); setPage(1) }}>Clear search</button>}
          </div>
          {loading && <p className="venue-workspace__state" role="status">Loading venues…</p>}
          {!loading && error && <p className="form-error" role="alert">{error}</p>}
          {!loading && !error && venues.length === 0 && <div className="venue-workspace__state">
            <h2>Your venue catalogue starts here</h2>
            <p>Create a venue profile to make its capacity, layouts and availability available for event planning.</p>
          </div>}
          {!loading && !error && venues.length > 0 && <>
            {pageCount > 1 && <nav className="venue-list-pagination" aria-label="Venue catalogue pages, top">
              <p className="note" role="status">Showing {pageStart + 1}–{Math.min(pageStart + VENUES_PER_PAGE, visibleVenues.length)} of {visibleVenues.length} venues</p>
              <div className="venue-list-pagination__controls">
                <button type="button" className="button button--secondary button--small" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>Previous</button>
                <span className="note">Page {currentPage} of {pageCount}</span>
                <button type="button" className="button button--secondary button--small" disabled={currentPage === pageCount} onClick={() => setPage(currentPage + 1)}>Next</button>
              </div>
            </nav>}
            {visibleVenues.length === 0 && <p className="venue-workspace__state">No venues match your search. Try another name or location.</p>}
            <div className="attendee-grid venue-catalogue__grid">
              {pagedVenues.map((venue) => (
                <article className="session-card venue-catalogue__card" key={venue.id}>
                  <header className="session-card__head">
                    <div className="venue-workspace__section-header">
                      <h2>{venue.name}</h2>
                      <span className="tag">Up to {venue.capacity} people</span>
                    </div>
                    <p className="note">{venue.location || 'Location not provided'}</p>
                  </header>
                  <div className="session-card__body">
                    <dl className="venue-catalogue__facts">
                      <div><dt>Operating hours</dt><dd>{venue.operating_hours.open}–{venue.operating_hours.close}</dd></div>
                      <div><dt>Preparation time</dt><dd>{venue.setup_time_minutes != null && venue.turnaround_time_minutes != null
                        ? `${venue.setup_time_minutes}m setup · ${venue.turnaround_time_minutes}m turnaround` : 'Not specified'}</dd></div>
                    </dl>
                    <section className="venue-catalogue__layouts" aria-label="Supported layouts">
                      <h3>Room layouts</h3>
                      <div className="venue-catalogue__chips">{venue.layouts.map((layout) => (
                        <span className="tag" key={`${venue.id}-${layout.name}`}>{layout.name} · {layout.capacity}</span>
                      ))}</div>
                    </section>
                    <div className="venue-catalogue__features">
                      <div><h3>Accessibility</h3><p className="note">{venue.accessibility?.length ? venue.accessibility.join(', ') : 'None entered'}</p></div>
                      <div><h3>Facilities</h3><p className="note">{formatFacilities(venue.facilities)}</p></div>
                    </div>
                    <div className="venue-catalogue__actions">
                      <Link to={`/venues/availability?${new URLSearchParams({ venueId: venue.id, from: 'catalogue' })}`}
                        className="button button--small">View Availability</Link>
                      <Link to={`/venues/${venue.id}/edit`} className="button button--secondary button--small" aria-label={`Edit ${venue.name}`}>Edit</Link>
                      <button type="button" className="button button--secondary button--small"
                        aria-label={`Block / Tentative Hold for ${venue.name}`}
                        disabled={blockingVenue !== null} onClick={() => setBlockingVenue(venue)}>Block / Tentative Hold</button>
                    </div>
                  </div>
                </article>
              ))}
            </div>
            {pageCount > 1 && <nav className="venue-list-pagination" aria-label="Venue catalogue pages, bottom">
              <p className="note">Showing {pageStart + 1}–{Math.min(pageStart + VENUES_PER_PAGE, visibleVenues.length)} of {visibleVenues.length} venues</p>
              <div className="venue-list-pagination__controls">
                <button type="button" className="button button--secondary button--small" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>Previous</button>
                <span className="note">Page {currentPage} of {pageCount}</span>
                <button type="button" className="button button--secondary button--small" disabled={currentPage === pageCount} onClick={() => setPage(currentPage + 1)}>Next</button>
              </div>
            </nav>}
          </>}
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
