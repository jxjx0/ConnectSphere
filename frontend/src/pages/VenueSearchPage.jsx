import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import { getVenues, searchVenues } from '../api/venues'
import { getAssignedEventRequest } from '../api/events'
import { formatDateRange } from '../eventDisplay'
import AppShell from '../components/AppShell'
import { useAuth } from '../context/AuthContext'
import {
  EMPTY_VENUE_FILTERS, INITIAL_VENUE_SEARCH, runVenueSearch,
  validateVenueSearch, venueAvailabilityLabel, venueLayoutOptions, eventVenueFilters,
  venueAccessibilityOptions, venueAvailabilitySummary, venueFacilityOptions,
} from '../venueSearch.js'
import BookingForm from '../components/BookingForm'

function formatPeriod(start, end) {
  return `${new Date(start).toLocaleString()} – ${new Date(end).toLocaleString()}`
}

function formatFeatures(value) {
  if (Array.isArray(value)) return value.join(', ') || 'None listed'
  if (value && typeof value === 'object') {
    return Object.entries(value).map(([name, feature]) => `${name}: ${feature}`).join(', ') || 'None listed'
  }
  return value || 'None listed'
}

export default function VenueSearchPage() {
  const { token, user } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()
  const eventId = searchParams.get('eventId')
  const [form, setForm] = useState(EMPTY_VENUE_FILTERS)
  const [result, setResult] = useState(INITIAL_VENUE_SEARCH)
  const [layouts, setLayouts] = useState({ options: [], accessibilityOptions: [], facilityOptions: [], loading: true, error: '' })
  const [context, setContext] = useState({ eventId, phase: eventId === null ? 'standalone' : 'loading', event: null, error: '' })
  const searchGeneration = useRef(0)
  const contextBlocked = eventId !== null && (context.eventId !== eventId || context.phase !== 'success')
  const loading = result.phase === 'loading'
  const disabled = loading || contextBlocked
  const availabilitySummary = venueAvailabilitySummary(result)
  const requestedPeriod = result.requested_period || (result.venues[0]?.requested_start ? {
    start: result.venues[0].requested_start, end: result.venues[0].requested_end,
  } : null)
  const [quickBookingVenue, setQuickBookingVenue] = useState(null)
  const [successMessage, setSuccessMessage] = useState('')

  useEffect(() => {
    let active = true
    const savedFilters = searchParams.get('filters') === '1'
      ? Object.fromEntries(Object.keys(EMPTY_VENUE_FILTERS).map((field) => [field, searchParams.get(field) || ''])) : null
    searchGeneration.current += 1
    const generation = searchGeneration.current
    async function resumeSearch() {
      if (!active || generation !== searchGeneration.current || !savedFilters || searchParams.get('resume') !== '1') return
      const error = validateVenueSearch(savedFilters)
      if (error) {
        setResult({ ...INITIAL_VENUE_SEARCH, phase: 'error', error })
        return
      }
      setResult({ ...INITIAL_VENUE_SEARCH, phase: 'loading' })
      const next = await runVenueSearch(savedFilters, token, searchVenues)
      if (active && generation === searchGeneration.current) setResult(next)
    }
    setForm(savedFilters || { ...EMPTY_VENUE_FILTERS })
    setResult(INITIAL_VENUE_SEARCH)
    setLayouts({ options: [], accessibilityOptions: [], facilityOptions: [], loading: true, error: '' })
    setContext({ eventId, phase: eventId === null ? 'standalone' : 'loading', event: null, error: '' })
    const catalogue = getVenues(token)
      .then((data) => ({ options: venueLayoutOptions(data.venues), accessibilityOptions: venueAccessibilityOptions(data.venues), facilityOptions: venueFacilityOptions(data.venues), loading: false, error: '' }))
      .catch(() => ({ options: [], accessibilityOptions: [], facilityOptions: [], loading: false, error: 'Catalogue filter options could not be loaded. You can still search using the other filters.' }))
    catalogue.then((data) => { if (active) setLayouts(data) })
    if (eventId !== null) {
      const assignedEvent = eventId.trim()
        ? getAssignedEventRequest(eventId, token)
        : Promise.reject(new Error('An event ID is required for contextual search.'))
      Promise.all([assignedEvent, catalogue])
        .then(([data, catalogueData]) => {
          if (!active) return
          if (!data.event || data.event.id !== eventId) throw new Error('The requested event could not be loaded.')
          setForm(savedFilters || eventVenueFilters(data.event, catalogueData.options))
          setContext({ eventId, phase: 'success', event: data.event, error: '' })
          resumeSearch()
        })
        .catch((error) => {
          if (active) setContext({ eventId, phase: 'error', event: null, error: error.message || 'Unable to load this assigned event.' })
        })
    } else {
      catalogue.then(() => { if (active) resumeSearch() })
    }
    return () => { active = false; searchGeneration.current += 1 }
  }, [eventId, token])

  function rememberFilters(filters, resume = false) {
    const params = new URLSearchParams()
    if (eventId !== null) params.set('eventId', eventId)
    params.set('filters', '1')
    if (resume) params.set('resume', '1')
    for (const [field, value] of Object.entries(filters)) if (value) params.set(field, value)
    setSearchParams(params, { replace: true })
  }

  function updateField(field, value) {
    searchGeneration.current += 1
    const next = { ...form, [field]: value }
    setForm(next)
    rememberFilters(next)
    setResult(INITIAL_VENUE_SEARCH)
  }

  function clearFilters() {
    searchGeneration.current += 1
    setForm({ ...EMPTY_VENUE_FILTERS })
    rememberFilters(EMPTY_VENUE_FILTERS)
    setResult(INITIAL_VENUE_SEARCH)
  }

  async function handleSubmit(event) {
    event.preventDefault()
    if (contextBlocked) return
    const error = validateVenueSearch(form)
    if (error) {
      setResult({ ...INITIAL_VENUE_SEARCH, phase: 'error', error })
      return
    }
    rememberFilters(form, true)
    setResult({ ...INITIAL_VENUE_SEARCH, phase: 'loading' })
    const generation = ++searchGeneration.current
    const next = await runVenueSearch(form, token, searchVenues)
    if (generation === searchGeneration.current) setResult(next)
  }

  return (
    <AppShell>
      <div className="content__header venue-search__header">
        <Link to={eventId !== null ? `/event-reviews/${encodeURIComponent(eventId)}` : '/dashboard'} className="venue-search__back">
          {eventId !== null ? '← Back to Event' : '← Back to Dashboard'}
        </Link>
        <h1>Search Venues</h1>
        <p className="lead">Find a suitable venue for your event.</p>

        {/* SUCCESS BANNER IN HEADER */}
        {successMessage && (
          <div
            className="notice"
            style={{
              backgroundColor: 'var(--accent-faint)',
              borderColor: 'var(--accent)',
              color: 'var(--accent)',
              marginTop: 'var(--space-3)'
            }}
            role="status"
          >
            <p><strong>✓ {successMessage}</strong></p>
          </div>
        )}

        {eventId !== null && contextBlocked && context.phase !== 'error' && <p className="note">Loading assigned event…</p>}
        {eventId !== null && context.eventId === eventId && context.phase === 'error' && (
          <p className="form-error" role="alert">Unable to load event context: {context.error}</p>
        )}
        {eventId !== null && !contextBlocked && (
          <div className="notice">
            <p>Searching venues for: <strong>{context.event.name}</strong></p>
            <p>{formatDateRange(context.event.start_time, context.event.end_time)} · {context.event.expected_attendance} expected</p>
            {context.event.layout_preference && <p>Preferred layout: {context.event.layout_preference}</p>}
            {context.event.layout_preference && !layouts.options.some((name) => name.toLowerCase() === context.event.layout_preference.trim().toLowerCase()) && (
              <p className="note">The preferred layout is not available in the catalogue. Choose a layout to filter by it.</p>
            )}
            {context.event.location_preference && <p>Preferred location: {context.event.location_preference}</p>}
            {context.event.accessibility_requirements && <p>Accessibility needs: {context.event.accessibility_requirements}</p>}
            <p className="note">Editing search filters does not change this event.</p>
          </div>
        )}
      </div>
      <div className="venue-search">
        <form className="form venue-search__form" onSubmit={handleSubmit}>
          <div className="venue-search__filter-heading">
            <h2 className="section-title">Search filters</h2>
            <p className="field__hint">All filters are optional. Leave them blank to browse all venues.</p>
          </div>
          <fieldset className="venue-search__filter-group">
            <legend className="section-title">Venue requirements</legend>
            <div className="venue-search__grid">
              <div className="field venue-search__wide">
                <label htmlFor="searchLocation">Location</label>
                <input id="searchLocation" type="text" placeholder="e.g. Stamford Road" disabled={disabled} value={form.location || ''}
                  onChange={(event) => updateField('location', event.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="searchAttendance">Expected attendance</label>
                <input id="searchAttendance" type="number" min="1" step="1" placeholder="e.g. 100" disabled={disabled}
                  value={form.expected_attendance}
                  onChange={(event) => updateField('expected_attendance', event.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="searchFacility">Required facility</label>
                <select id="searchFacility" disabled={disabled || layouts.loading || Boolean(layouts.error)} value={form.required_facility}
                  onChange={(event) => updateField('required_facility', event.target.value)}>
                  <option value="">Any facility</option>
                  {(layouts.facilityOptions || []).map((name) => <option key={name} value={name}>{name}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="searchLayout">Required layout</label>
                <select id="searchLayout" disabled={disabled || layouts.loading || Boolean(layouts.error)} value={form.required_layout}
                  onChange={(event) => updateField('required_layout', event.target.value)}>
                  <option value="">Any layout</option>
                  {layouts.options.map((name) => <option key={name} value={name}>{name}</option>)}
                </select>
                {layouts.loading && <p className="field__hint">Loading layout options…</p>}
                {layouts.error && <p className="field__error" role="alert">{layouts.error}</p>}
              </div>
              <div className="field">
                <label htmlFor="searchAccessibility">Accessibility</label>
                <select id="searchAccessibility" disabled={disabled || layouts.loading || Boolean(layouts.error)} value={form.required_accessibility}
                  onChange={(event) => updateField('required_accessibility', event.target.value)}>
                  <option value="">Any accessibility</option>
                  {(layouts.accessibilityOptions || []).map((name) => <option key={name} value={name}>{name}</option>)}
                </select>
              </div>
            </div>
          </fieldset>
          <fieldset className="venue-search__filter-group">
            <legend className="section-title">Availability</legend>
            <div className="venue-search__grid">
              <div className="field">
                <label htmlFor="searchDate">Start date</label>
                <input id="searchDate" type="date" disabled={disabled} value={form.date}
                  aria-describedby="searchTimeHint" onChange={(event) => updateField('date', event.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="searchEndDate">End date (optional)</label>
                <input id="searchEndDate" type="date" disabled={disabled} value={form.end_date}
                  aria-describedby="searchTimeHint" onChange={(event) => updateField('end_date', event.target.value)} />
                <p className="field__hint">Leave blank for the same day as the start date.</p>
              </div>
              <div className="field">
                <label htmlFor="searchStart">Start time</label>
                <input id="searchStart" type="time" disabled={disabled} value={form.start_time}
                  aria-describedby="searchTimeHint" onChange={(event) => updateField('start_time', event.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="searchEnd">End time</label>
                <input id="searchEnd" type="time" disabled={disabled} value={form.end_time}
                  aria-describedby="searchTimeHint" onChange={(event) => updateField('end_time', event.target.value)} />
              </div>
            </div>
          </fieldset>
          <p className="field__hint" id="searchTimeHint">To check availability, enter date, start and end time together. Times use your local timezone.</p>
          <div className="form-actions">
            <button type="submit" className="button" disabled={disabled}>{loading ? 'Searching…' : 'Search venues'}</button>
            <button type="button" className="button button--secondary" disabled={disabled} onClick={clearFilters}>Clear filters</button>
          </div>
        </form>
        <section className="stack stack--tight venue-search__results" aria-live="polite" aria-busy={loading}>
          {result.phase === 'idle' && <p className="note">Choose filters, or search to view all venues.</p>}
          {loading && <p className="note">Searching venues…</p>}
          {result.phase === 'error' && <p className="form-error" role="alert">{result.error}</p>}
          {result.phase === 'success' && (
            <>
              <div className="venue-search__results-heading">
                <h2 className="section-title">Search results</h2>
                <p className="note">{result.venues.length} {result.venues.length === 1 ? 'venue' : 'venues'}</p>
              </div>
              {requestedPeriod && <p className="note">Requested period: {formatPeriod(requestedPeriod.start, requestedPeriod.end)}</p>}
              {availabilitySummary && <p className="note" role="status">{availabilitySummary}</p>}
              {result.venues.length === 0 && <p className="note">No venues match the selected filters.</p>}
              {result.venues.length > 0 && (
                <div className="table-wrapper" tabIndex={0} role="region" aria-label="Venue search results">
                  <table className="venue-table venue-search__table">
                    <caption className="visually-hidden">Venues matching the submitted filters</caption>
                    <thead><tr>
                      <th scope="col">Venue</th><th scope="col">Overall capacity</th>
                      <th scope="col">Layouts</th><th scope="col">Facilities &amp; accessibility</th>
                      {result.venues.some((venue) => venue.requested_start) && <th scope="col">Availability</th>}
                      <th scope="col">Actions</th>
                    </tr></thead>
                    <tbody>{result.venues.map((venue) => (
                      <tr key={venue.id}>
                        <th scope="row">{venue.name}<span className="venue-search__detail">{venue.location || 'Location not provided'}</span></th>
                        <td>{venue.capacity}</td>
                        <td>{venue.selected_layout
                          ? `${venue.selected_layout} — capacity ${venue.layout_capacity}`
                          : <ul className="table-values">{venue.layouts.map((layout) => <li key={layout.name}>{layout.name} ({layout.capacity})</li>)}</ul>}
                        </td>
                        <td><span>{formatFeatures(venue.facilities)}</span>
                          <span className="venue-search__detail">Accessibility: {formatFeatures(venue.accessibility)}</span></td>
                        {venue.requested_start && <td>
                          <span className="venue-search__availability">{venueAvailabilityLabel(venue)}</span>
                          {venue.availability_status === 'unverified' && <span className="venue-search__detail">No operational block conflict</span>}
                          {venue.effective_start && venue.effective_end && <span className="venue-search__detail">Including setup and turnaround: {formatPeriod(venue.effective_start, venue.effective_end)}</span>}
                        </td>}
                        <td>
                          <Link className="button button--secondary button--small"
                            to={`/venues/availability?${new URLSearchParams({
                              venueId: venue.id, from: 'search',
                              ...(form.date ? { date: form.date } : {}), search: searchParams.toString()
                            })}`}>
                            View Availability
                          </Link>
                          <button
                            type="button"
                            className="button button--primary button--small"
                            disabled={!venue.requested_start || venue.availability_status === 'conflict'}
                            title={!venue.requested_start ? 'Enter search date & times to enable quick booking' : ''}
                            onClick={() => setQuickBookingVenue(venue)}>
                            Quick Book
                          </button>
                        </td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </section>
      </div>

      {/* Render BookingForm modal at bottom of page component */}
      {quickBookingVenue && (
        <BookingForm
          venue={quickBookingVenue}
          eventId={eventId}
          initialValues={{
            eventId: eventId || '',
            eventName: context.event?.name || '',
            startDate: form.date || '',
            endDate: form.end_date || form.date || '',
            startTime: form.start_time || '',
            endTime: form.end_time || '',
            layout: quickBookingVenue.selected_layout || form.required_layout || (context.event?.layout_preference || ''),
          }}
          onClose={() => setQuickBookingVenue(null)}
          onCreated={() => {
            const venueName = quickBookingVenue.name
            setQuickBookingVenue(null) // Closes modal
            setSuccessMessage(`Booking request for ${venueName} successfully submitted!`)
          }}
        />
      )}
    </AppShell>
  )
}