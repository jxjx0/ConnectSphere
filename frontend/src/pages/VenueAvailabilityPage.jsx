import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import { getVenues, getVenueAvailability } from '../api/venues'
import { getAssignedEventRequest } from '../api/events'
import AppShell from '../components/AppShell'
import BlockForm from '../components/BlockForm'
import BookingForm from '../components/BookingForm.jsx'
import { useAuth } from '../context/AuthContext'
import { formatDateRange } from '../eventDisplay'
import { EMPTY_VENUE_FILTERS, validateVenueSearch } from '../venueSearch.js'
import { blocksForDay, calendarBlockPositions, calendarOperatingHours, calendarWeek, calendarVenueOptions, localDateValue, shiftCalendarDate, validateCalendarResponse } from '../venueAvailability'

export default function VenueAvailabilityPage() {
  const { token, user } = useAuth()
  const [searchParams] = useSearchParams()
  const [catalogue, setCatalogue] = useState({ loading: true, error: '', venues: [] })
  const [venueId, setVenueId] = useState(() => searchParams.get('venueId') || '')
  const [date, setDate] = useState(() => searchParams.get('date') || localDateValue())
  const [refresh, setRefresh] = useState(0)
  const [result, setResult] = useState({ key: '', loading: false, error: '', data: null })
  const [venueSearch, setVenueSearch] = useState(null)
  const [selectedBlock, setSelectedBlock] = useState(null)
  const [venueOpen, setVenueOpen] = useState(false)
  const [activeVenue, setActiveVenue] = useState(0)
  const [blockingVenue, setBlockingVenue] = useState(null)
  const [eventContext, setEventContext] = useState({ id: '', event: null, error: '' })
  const [successMessage, setSuccessMessage] = useState('')

  const fromSearch = searchParams.get('from') === 'search' && user.role === 'coordinator'
  const fromCatalogue = searchParams.get('from') === 'catalogue' && user.role === 'venue_staff'
  const returnSearch = new URLSearchParams(searchParams.get('search') || '')
  if (fromSearch) returnSearch.set('resume', '1')

  const backTo = fromSearch ? `/venues/search?${returnSearch}` : fromCatalogue ? '/venues' : '/dashboard'
  const backLabel = fromSearch ? 'Back to Search Results' : fromCatalogue ? 'Back to Venue Catalogue' : 'Back to Dashboard'

  // Resolve eventId from search params or search context
  const eventId = searchParams.get('eventId') || (fromSearch ? returnSearch.get('eventId') : null)

  const filters = Object.fromEntries(Object.keys(EMPTY_VENUE_FILTERS).map((field) => [field, returnSearch.get(field) || '']))
  const requestedPeriod = fromSearch && filters.date && !validateVenueSearch(filters)
    ? formatDateRange(new Date(`${filters.date}T${filters.start_time}`).toISOString(),
      new Date(`${filters.end_date || filters.date}T${filters.end_time}`).toISOString()) : null

  let week
  let dateError = ''
  try { week = calendarWeek(date) } catch (error) { dateError = error.message }
  const start = week?.range.start_at
  const end = week?.range.end_at
  const key = `${venueId}/${start}/${end}/${refresh}`
  const [bookingVenue, setBookingVenue] = useState(null)

  useEffect(() => {
    let cancelled = false
    setCatalogue({ loading: true, error: '', venues: [] })
    getVenues(token).then(({ venues }) => {
      if (cancelled) return
      const sortedVenues = calendarVenueOptions(venues)
      setCatalogue({ loading: false, error: '', venues: sortedVenues })
      setVenueId((current) => sortedVenues.some((venue) => venue.id === current) ? current : '')
    }).catch((error) => {
      if (!cancelled) setCatalogue({ loading: false, error: error.message, venues: [] })
    })
    return () => { cancelled = true }
  }, [token, refresh])

  useEffect(() => {
    if (!venueId || !start || !end || catalogue.loading || catalogue.error) return
    let cancelled = false
    setResult({ key, loading: true, error: '', data: null })
    const range = { start_at: start, end_at: end }
    getVenueAvailability(venueId, range, token).then((data) => {
      if (!cancelled) setResult({ key, loading: false, error: '', data: validateCalendarResponse(data, venueId, range) })
    }).catch((error) => {
      if (!cancelled) setResult({ key, loading: false, error: error.message, data: null })
    })
    return () => { cancelled = true }
  }, [token, venueId, start, end, refresh, catalogue.loading, catalogue.error])

  useEffect(() => {
    if (!eventId) return
    let cancelled = false
    setEventContext({ id: eventId, event: null, error: '' })
    getAssignedEventRequest(eventId, token).then(({ event }) => {
      if (!event || event.id !== eventId) throw new Error('Event context could not be loaded.')
      if (!cancelled) setEventContext({ id: eventId, event, error: '' })
    }).catch(() => {
      if (!cancelled) setEventContext({ id: eventId, event: null, error: 'Event context could not be loaded. Return to search results to continue.' })
    })
    return () => { cancelled = true }
  }, [eventId, token])

  const current = result.key === key ? result : { loading: true, data: null, error: '' }
  const canShowCalendar = week && !catalogue.loading && !catalogue.error && venueId && current.data
  const matches = calendarVenueOptions(catalogue.venues, venueSearch || '')
  const selectedVenue = catalogue.venues.find((venue) => venue.id === venueId)
  const operatingHours = calendarOperatingHours(selectedVenue?.operating_hours)

  function closeVenues(event) {
    setVenueOpen(false)
    setVenueSearch(null)
    event.currentTarget?.closest('.venue-picker')?.querySelector('button')?.focus()
  }

  function chooseVenue(venue, event) {
    setVenueId(venue.id)
    closeVenues(event)
  }

  function openVenues() {
    setVenueSearch('')
    setActiveVenue(Math.max(0, catalogue.venues.findIndex((venue) => venue.id === venueId)))
    setVenueOpen(true)
  }

  const blockDetails = selectedBlock?.key === key && current.data
    ? current.data.items.find((item) => item.id === selectedBlock.id) : null
  const formatDay = (value) => value.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

  // Derived date values for initial form values
  const derivedStartDate = searchParams.get('date') || filters?.date || date || ''
  const derivedEndDate = searchParams.get('end_date') || filters?.end_date || derivedStartDate

  return (
    <AppShell>
      <div className="content__header venue-search__header">
        <Link to={backTo} className="venue-search__back">← {backLabel}</Link>
        <h1>Venue Availability</h1>
        <p className="lead">{fromSearch ? 'Review this venue’s schedule, then return to your matching venues.' : 'View recorded venue occupancy across dates and times.'}</p>
        
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

        {fromSearch && <div className="notice stack stack--tight">
          {eventId && (eventContext.id !== eventId || (!eventContext.event && !eventContext.error)) && <p className="note">Loading event context…</p>}
          {eventContext.id === eventId && eventContext.event && <p>Finding a venue for: <strong>{eventContext.event.name}</strong></p>}
          {eventContext.id === eventId && eventContext.error && <p role="alert">{eventContext.error}</p>}
          {requestedPeriod && <p>Requested period: {requestedPeriod}</p>}
          <div className="form-actions"><Link to={backTo} className="button button--secondary button--small">Return to matching venues</Link></div>
        </div>}
      </div>
      <section className="stack stack--default">
        <div className="venue-calendar__controls">
          <div className="field venue-picker" onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) { setVenueOpen(false); setVenueSearch(null) }
          }}>
            <label htmlFor="calendar-venue">Venue</label>
            <button id="calendar-venue" type="button" className="venue-picker__trigger"
              disabled={catalogue.loading || !catalogue.venues.length} aria-haspopup="listbox" aria-expanded={venueOpen}
              onClick={(event) => venueOpen ? closeVenues(event) : openVenues()}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); openVenues() }
              }}>
              <span>{selectedVenue?.name || 'Select a venue'}</span><span aria-hidden="true">▾</span>
            </button>
            {venueOpen && <div className="venue-picker__menu">
              <input type="search" autoFocus autoComplete="off" role="combobox" aria-label="Search venues"
                aria-expanded="true" aria-controls="calendar-venue-options" aria-autocomplete="list"
                aria-activedescendant={matches[activeVenue] ? `calendar-option-${matches[activeVenue].id}` : undefined}
                value={venueSearch || ''} placeholder="Search venue name or location"
                onChange={(event) => { setVenueSearch(event.target.value); setActiveVenue(0) }}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault()
                    setActiveVenue((index) => Math.max(0, Math.min(matches.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))))
                  } else if (event.key === 'Enter') {
                    event.preventDefault()
                    if (matches[activeVenue]) chooseVenue(matches[activeVenue], event)
                  } else if (event.key === 'Escape') { event.preventDefault(); closeVenues(event) }
                }} />
              <div id="calendar-venue-options" role="listbox" aria-label="Venues" className="venue-picker__options">
                {matches.map((venue, index) => <button key={venue.id} id={`calendar-option-${venue.id}`}
                  type="button" role="option" tabIndex={-1} aria-selected={venue.id === venueId}
                  className={`venue-picker__option${index === activeVenue ? ' venue-picker__option--active' : ''}`}
                  ref={(node) => { if (index === activeVenue) node?.scrollIntoView({ block: 'nearest' }) }}
                  onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setActiveVenue(index)}
                  onClick={(event) => chooseVenue(venue, event)}>
                  <strong>{venue.name}</strong>{venue.location && <span className="note">{venue.location}</span>}
                </button>)}
              </div>
              {!matches.length && <p className="note" role="status">No venues match your search.</p>}
            </div>}
          </div>
          <div className="field">
            <label htmlFor="calendar-week">Week containing</label>
            <input id="calendar-week" type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          </div>
        </div>
        {selectedVenue && <div className="stack stack--tight venue-calendar__selection">
          <h2>{selectedVenue.name}</h2>
          {selectedVenue.location && <p className="note">{selectedVenue.location}</p>}
          <p className="note">{operatingHours ? `Operating hours: ${operatingHours.label}` : 'Operating hours unavailable.'}</p>
        </div>}
        {user.role === 'venue_staff' && <div className="form-actions">
          <button type="button" className="button button--secondary button--small"
            disabled={!selectedVenue || catalogue.loading || Boolean(catalogue.error) || blockingVenue !== null}
            onClick={() => setBlockingVenue(selectedVenue)}>Block Venue</button>
        </div>}
        <div className="venue-calendar__navigation">
          {week && <h3 className="venue-calendar__range">{formatDay(week.days[0].start)} – {formatDay(week.days[6].start)}</h3>}
          <div className="form-actions">
            <button className="button button--secondary button--small" disabled={!week} onClick={() => setDate(shiftCalendarDate(date, -7))}>Previous week</button>
            <button className="button button--secondary button--small" onClick={() => setDate(localDateValue())}>This week</button>
            <button className="button button--secondary button--small" disabled={!week} onClick={() => setDate(shiftCalendarDate(date, 7))}>Next week</button>
            <button className="button button--secondary button--small" onClick={() => setRefresh((value) => value + 1)}>Refresh</button>

            {/* Action button toolbar */}
            {user?.role === 'coordinator' && selectedVenue && (
              <button
                type="button"
                className="button button--primary button--small"
                onClick={() => setBookingVenue(selectedVenue)}
              >
                Request Venue Booking
              </button>
            )}
          </div>
        </div>

        {/* Render BookingForm modal */}
        {bookingVenue && (
          <BookingForm
            venue={bookingVenue}
            eventId={eventId}
            initialValues={{
              eventId: eventId || '',
              eventName: eventContext.event?.name || '',
              startDate: derivedStartDate,
              endDate: derivedEndDate,
              startTime: searchParams.get('start_time') || filters?.start_time || '',
              endTime: searchParams.get('end_time') || filters?.end_time || '',
              layout: searchParams.get('required_layout') || filters?.required_layout || (eventContext.event?.layout_preference || ''),
            }}
            onClose={() => setBookingVenue(null)}
            onCreated={() => {
              const venueName = bookingVenue.name
              setBookingVenue(null) // Closes modal
              setSuccessMessage(`Booking request for ${venueName} successfully submitted!`)
              setRefresh((val) => val + 1) // Refresh calendar data
            }}
          />
        )}

        {catalogue.loading && <p role="status" className="note">Loading venues…</p>}
        {catalogue.error && <p role="alert" className="form-error">{catalogue.error}</p>}
        {!catalogue.loading && !catalogue.error && !catalogue.venues.length && <p className="note">No venues to display.</p>}
        {!catalogue.loading && !catalogue.error && catalogue.venues.length > 0 && !venueId && <p className="note">Select a venue to view its calendar.</p>}
        {dateError && <p role="alert" className="form-error">{dateError}</p>}
        {!catalogue.loading && !catalogue.error && venueId && week && current.loading && <p role="status" className="note">Loading venue occupancy…</p>}
        {current.error && !catalogue.loading && !catalogue.error && !dateError && <p role="alert" className="form-error">{current.error}</p>}
        {canShowCalendar && <>
          <div className="venue-calendar__key" aria-label="Calendar legend">
            <span className="note venue-calendar__legend">Recorded block</span>
            {operatingHours && <span className="note venue-calendar__legend venue-calendar__legend--closed">Closed</span>}
            <span className="note venue-calendar__timezone">Local time</span>
          </div>
          <div className="venue-calendar__scroll" tabIndex={0} role="region" aria-label="Weekly time grid, scroll to see all hours">
            <div className="venue-calendar__time-grid">
              <div className="venue-calendar__time-heading">Time</div>
              {week.days.map((day) => <div key={day.date} className="venue-calendar__time-heading">
                <time dateTime={day.date}>{day.start.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}</time>
              </div>)}
              <div className="venue-calendar__hours" aria-hidden="true">
                {Array.from({ length: 24 }, (_, hour) => <span key={hour}>{hour % 12 || 12} {hour < 12 ? 'AM' : 'PM'}</span>)}
              </div>
              {week.days.map((day) => <div key={day.date} className="venue-calendar__timeline" aria-label={day.date}>
                {(calendarOperatingHours(selectedVenue?.operating_hours, day)?.closed || []).map(({ item, top, height }, index) => (
                  <div key={`closed-${index}`} className="venue-calendar__closed" role="img"
                    style={{ top: `${top}%`, height: `${height}%` }}
                    aria-label={`Closed: ${formatDateRange(item.start_at, item.end_at)}`}>
                    {height >= 100 / 24 && <span>Closed</span>}
                  </div>
                ))}
                <div className="venue-calendar__hour-lines" aria-hidden="true">
                  {Array.from({ length: 24 }, (_, hour) => <span key={hour} />)}
                </div>
                {calendarBlockPositions(current.data.items, day).map(({ item, top, height, left, width }) => (
                  <button type="button" key={item.id}
                    className={`venue-calendar__time-block${height < 100 / 24 ? ' venue-calendar__time-block--compact' : ''}`}
                    style={{ top: `${top}%`, height: `${height}%`, left: `${left}%`, width: `${width}%` }}
                    title={`${item.reason}. ${formatDateRange(item.start_at, item.end_at)}`}
                    aria-label={`Operational block: ${item.reason}. ${formatDateRange(item.start_at, item.end_at)}`}
                    aria-controls="calendar-block-details" aria-expanded={blockDetails?.id === item.id}
                    onClick={() => setSelectedBlock({ key, id: item.id })}>
                    {height >= 100 / 24 && <strong>{item.reason}</strong>}
                  </button>
                ))}
              </div>)}
            </div>
          </div>
          {blockDetails && <section id="calendar-block-details" className="venue-calendar__time-detail stack stack--tight"
            aria-labelledby="calendar-block-heading" aria-live="polite">
            <div className="venue-calendar__navigation">
              <h3 id="calendar-block-heading">Operational block</h3>
              <button type="button" className="button button--secondary button--small"
                onClick={() => setSelectedBlock(null)}>Close details</button>
            </div>
            <strong>{selectedVenue?.name}</strong>
            <p className="venue-calendar__period">{formatDateRange(blockDetails.start_at, blockDetails.end_at)}</p>
            <p>{blockDetails.reason}</p>
          </section>}
          <details className="venue-calendar__list">
            <summary>View daily block details</summary>
            <div className="venue-calendar__week" aria-label="Weekly venue occupancy">
              {week.days.map((day) => {
                const items = blocksForDay(current.data.items, day)
                return <section key={day.date} className="venue-calendar__day" aria-label={day.date}>
                  <h3 className="venue-calendar__day-heading"><time dateTime={day.date}>
                    <span>{day.start.toLocaleDateString('en-GB', { weekday: 'short' })}</span>
                    <span className="note">{day.start.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>
                  </time></h3>
                  {!items.length && <p className="note">No recorded occupancy</p>}
                  {items.map((item) => <article key={item.id} className="venue-calendar__block">
                    <p className="venue-calendar__period">{formatDateRange(item.start_at, item.end_at)}</p>
                    <strong className="note">Operational block</strong>
                    <p className="note">{item.reason}</p>
                    {new Date(item.start_at) < day.start && <p className="note">Continues from previous day</p>}
                    {new Date(item.end_at) > day.end && <p className="note">Continues into next day</p>}
                  </article>)}
                </section>
              })}
            </div>
          </details>
        </>}
      </section>
      {blockingVenue && <BlockForm venue={blockingVenue} onClose={() => setBlockingVenue(null)}
        onCreated={() => { setSelectedBlock(null); setRefresh((value) => value + 1) }} />}
    </AppShell>
  )
}
