import React, { useEffect, useRef, useState } from 'react'
import { getVenueAvailability } from '../api/venues'
import { formatDateRange } from '../eventDisplay'
import {
  calendarBlockPositions,
  calendarItemLabel,
  calendarItemShortLabel,
  calendarWeek,
  localDateValue,
  shiftCalendarDate,
  validateCalendarResponse,
} from '../venueAvailability'
import styles from './VenueScheduleCalendar.module.css'

// Presentation only: show the occupied period the existing approval checks use.
function requestHighlight(request, venueId) {
  if (!request || request.venue_id !== venueId) return null
  const setup = Math.max(request.venues?.setup_time_minutes ?? 0, request.setup_buffer_minutes ?? 0)
  const turnaround = Math.max(request.venues?.turnaround_time_minutes ?? 0, request.teardown_buffer_minutes ?? 0)
  const start = Math.min(Date.parse(request.start_at) - setup * 60000,
    request.effective_start_at ? Date.parse(request.effective_start_at) : Infinity)
  const end = Math.max(Date.parse(request.end_at) + turnaround * 60000,
    request.effective_end_at ? Date.parse(request.effective_end_at) : -Infinity)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) return null
  return { id: `request:${request.booking_id}`, type: 'pending_request', reason: 'This request',
    start_at: new Date(start).toISOString(), end_at: new Date(end).toISOString() }
}

export default function VenueScheduleCalendar({ venueId, operatingHours, initialDate, token, request }) {
  const [date, setDate] = useState(() => initialDate || localDateValue())
  const [result, setResult] = useState({ loading: false, error: '', data: null })
  const [selectedBlock, setSelectedBlock] = useState(null)
  const [refresh, setRefresh] = useState(0)
  const scrollRef = useRef(null)

  // Synchronize internal date state whenever initialDate prop changes
  useEffect(() => {
    if (initialDate) {
      setDate(initialDate)
    }
  }, [initialDate])

  let week
  let dateError = ''
  try {
    week = calendarWeek(date)
  } catch (error) {
    dateError = error.message
  }

  const start = week?.range.start_at
  const end = week?.range.end_at
  const key = `${venueId}/${start}/${end}/${refresh}`

  useEffect(() => {
    if (!venueId || !start || !end) return
    let active = true

    setSelectedBlock(null)
    setResult({ key, loading: true, error: '', data: null })
    getVenueAvailability(venueId, { start_at: start, end_at: end }, token)
      .then((data) => {
        if (active) {
          setResult({
            key,
            loading: false,
            error: '',
            data: validateCalendarResponse(data, venueId, { start_at: start, end_at: end }),
          })
        }
      })
      .catch((err) => {
        if (active) setResult({ key, loading: false, error: err.message, data: null })
      })

    return () => {
      active = false
    }
  }, [venueId, start, end, token, refresh])

  const current = result.key === key ? result : { loading: Boolean(start && end), error: '', data: null }
  const highlight = requestHighlight(request, venueId)
  const requestInWeek = highlight && start && end
    && Date.parse(highlight.start_at) < Date.parse(end) && Date.parse(start) < Date.parse(highlight.end_at)
  const items = (current.data?.items || []).filter(item => item.type !== 'tentative_hold' || Date.parse(item.expires_at) > Date.now())
  const overlaps = highlight ? items.filter(item => item.id !== request.booking_id
    && Date.parse(item.start_at) < Date.parse(highlight.end_at)
    && Date.parse(highlight.start_at) < Date.parse(item.end_at)) : []
  const overlappingIds = new Set(overlaps.map(item => item.id))
  const displayedItems = requestInWeek ? [...items, highlight] : items

  function focusRequest() {
    const container = scrollRef.current
    const marker = container?.querySelector('[data-request-highlight]')
    if (!marker) return
    const containerBox = container.getBoundingClientRect()
    const markerBox = marker.getBoundingClientRect()
    container.scrollTo({
      top: Math.max(0, container.scrollTop + markerBox.top - containerBox.top - 80),
      left: Math.max(0, container.scrollLeft + markerBox.left - containerBox.left - 60),
    })
  }

  useEffect(() => {
    focusRequest()
  }, [key, current.data, request?.booking_id])

  const formatDay = (val) =>
    val.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

  const blockDetails = selectedBlock && current.data
    ? items.find((item) => item.id === selectedBlock)
    : null

  // Compute non-operational shading regions as percentages of the 24-hour day
  const calculateNonOperatingRegions = () => {
    const hours = operatingHours
    if (!hours || typeof hours !== 'object') return null
    const open = hours.open
    const close = hours.close
    if (!open || !close) return null

    const parseTimeToPercent = (timeStr) => {
      const [h, m] = timeStr.split(':').map(Number)
      return ((h * 60 + m) / (24 * 60)) * 100
    }

    const openPct = parseTimeToPercent(open)
    const closePct = parseTimeToPercent(close)

    return {
      beforeOpen: { top: 0, height: openPct },
      afterClose: { top: closePct, height: 100 - closePct },
    }
  }

  const nonOpRegions = calculateNonOperatingRegions()

  return (
    <div className={styles.container}>
      {/* Visual Operating Hours Summary Banner */}
      {operatingHours?.open && operatingHours?.close && (
        <div className="notice notice--info" style={{ marginBottom: '1rem' }} role="status">
          <p><strong>Operating Hours:</strong> {operatingHours.open} – {operatingHours.close}</p>
        </div>
      )}
      {highlight && <p className={styles.requestSummary}>
        <strong>This request, including setup and turnaround</strong>
        <span>{formatDateRange(highlight.start_at, highlight.end_at)}</span>
      </p>}
      {request && !highlight && <p className="form-error" role="alert">The request period could not be highlighted. Check the booking details.</p>}

      <div className={styles.controls}>
        <div className="field">
          <label htmlFor="calendar-week">Week containing</label>
          <input
            id="calendar-week"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
      </div>

      <div className={styles.navigation}>
        {week && (
          <h3 className={styles.range}>
            {formatDay(week.days[0].start)} – {formatDay(week.days[6].start)}
          </h3>
        )}
        <div className="form-actions">
          <button
            type="button"
            className="button button--secondary button--small"
            disabled={!week}
            onClick={() => setDate(shiftCalendarDate(date, -7))}
          >
            Previous week
          </button>
          <button
            type="button"
            className="button button--secondary button--small"
            onClick={() => { setDate(initialDate || localDateValue()); focusRequest() }}
          >
            {initialDate ? 'Request week' : 'This week'}
          </button>
          <button
            type="button"
            className="button button--secondary button--small"
            disabled={!week}
            onClick={() => setDate(shiftCalendarDate(date, 7))}
          >
            Next week
          </button>
          <button type="button" className="button button--secondary button--small"
            onClick={() => setRefresh(value => value + 1)}>Refresh</button>
        </div>
      </div>

      {dateError && <p className="form-error" role="alert">{dateError}</p>}
      {current.loading && <p className="note" role="status">Loading schedule...</p>}
      {current.error && <p className="form-error" role="alert">{current.error}</p>}

      {!current.loading && week && current.data && (
        <>
          {current.data.verification_status === 'partial' && <p className="note" role="status">
            Some availability details could not be verified. Check the records before approving this request.
          </p>}
          {highlight && !requestInWeek && <p className="note" role="status">This request is outside the displayed week. Choose Request week to return to it.</p>}
          {requestInWeek && (overlaps.length ? <details className={styles.overlapNotice}>
            <summary>{overlaps.length} overlapping {overlaps.length === 1 ? 'record' : 'records'} in this week — review before approving</summary>
            <p className="note">A tentative hold may belong to this event. Availability is checked again when approving.</p>
            <ul>{overlaps.map(item => <li key={item.id}>
              <button type="button" onClick={() => setSelectedBlock(item.id)}>
                <strong>{calendarItemLabel(item)}: {item.reason}</strong>
                <span>{formatDateRange(item.start_at, item.end_at)}</span>
              </button>
            </li>)}</ul>
          </details> : <p className="note" role="status">No recorded overlaps in the displayed week. Availability is checked again when approving.</p>)}
          <div className="venue-calendar__key" aria-label="Calendar legend">
            {highlight && <span className={`note ${styles.requestLegend}`}>This request</span>}
            {overlaps.length > 0 && <span className={`note ${styles.overlapLegend}`}>Overlapping record</span>}
            <span className="note venue-calendar__legend">Blocked</span>
            <span className="note venue-calendar__legend venue-calendar__legend--booking">Confirmed</span>
            <span className="note venue-calendar__legend venue-calendar__legend--hold">Hold</span>
            {nonOpRegions && <span className="note venue-calendar__legend venue-calendar__legend--closed">Closed</span>}
            <span className="note">Local time</span>
          </div>
          <div ref={scrollRef} className={styles.scrollArea} tabIndex={0} role="region" aria-label="Weekly time grid">
            <div className={styles.timeGrid}>
              <div className={styles.timeHeading}>Time</div>
              {week.days.map((day) => (
                <div key={day.date} className={styles.timeHeading}>
                  <time dateTime={day.date}>
                    {day.start.toLocaleDateString('en-GB', {
                      weekday: 'short',
                      day: 'numeric',
                    })}
                  </time>
                </div>
              ))}

              <div className={styles.hours} aria-hidden="true">
                {Array.from({ length: 24 }, (_, hour) => (
                  <span key={hour}>
                    {hour % 12 || 12} {hour < 12 ? 'AM' : 'PM'}
                  </span>
                ))}
              </div>

              {week.days.map((day) => (
                <div key={day.date} className={styles.timeline} aria-label={day.date}>
                  {/* Non-Operational Hours Shading Overlays */}
                  {nonOpRegions && (
                    <>
                      {nonOpRegions.beforeOpen.height > 0 && (
                        <div
                          className={styles.nonOperatingOverlay}
                          style={{
                            top: `${nonOpRegions.beforeOpen.top}%`,
                            height: `${nonOpRegions.beforeOpen.height}%`,
                          }}
                          title={`Closed until ${operatingHours.open}`}
                        />
                      )}
                      {nonOpRegions.afterClose.height > 0 && (
                        <div
                          className={styles.nonOperatingOverlay}
                          style={{
                            top: `${nonOpRegions.afterClose.top}%`,
                            height: `${nonOpRegions.afterClose.height}%`,
                          }}
                          title={`Closed after ${operatingHours.close}`}
                        />
                      )}
                    </>
                  )}

                  <div className={styles.hourLines} aria-hidden="true">
                    {Array.from({ length: 24 }, (_, hour) => (
                      <span key={hour} />
                    ))}
                  </div>

                  {calendarBlockPositions(displayedItems, day).map(({ item, top, height, left, width }) => item === highlight ? (
                    <div key={item.id} data-request-highlight="true" className={styles.requestHighlight}
                      style={{ top: `${top}%`, height: `${height}%`, left: `${left}%`, width: `${width}%` }}
                      role="img" aria-label={`This request, including setup and turnaround: ${formatDateRange(item.start_at, item.end_at)}`}>
                      {height >= 100 / 24 && <strong>This request</strong>}
                    </div>
                  ) : (
                    <button
                      type="button"
                      key={item.id}
                      className={`${styles.timeBlock} ${item.type === 'confirmed_booking' ? styles.booking : item.type === 'tentative_hold' ? styles.hold : ''} ${height < 100 / 24 ? styles.timeBlockCompact : ''} ${overlappingIds.has(item.id) ? styles.overlapping : ''}`}
                      style={{ top: `${top}%`, height: `${height}%`, left: `${left}%`, width: `${width}%` }}
                      title={`${item.reason}. ${formatDateRange(item.start_at, item.end_at)}`}
                      aria-label={`${overlappingIds.has(item.id) ? 'Overlaps this request. ' : ''}${calendarItemLabel(item)}: ${item.reason}. ${formatDateRange(item.start_at, item.end_at)}`}
                      aria-expanded={blockDetails?.id === item.id}
                      aria-controls="request-calendar-block-details"
                      onClick={() => setSelectedBlock(item.id)}
                    >
                      {height >= 100 / 24 && <strong>{calendarItemShortLabel(item)}</strong>}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>

          {blockDetails && (
            <section id="request-calendar-block-details" className={`${styles.blockDetail} stack stack--tight`} aria-live="polite">
              <div className={styles.navigation}>
                <h3 style={{ fontSize: '0.875rem' }}>{calendarItemLabel(blockDetails)}</h3>
                <button
                  type="button"
                  className="button button--secondary button--small"
                  onClick={() => setSelectedBlock(null)}
                >
                  Close
                </button>
              </div>
              <p className={styles.period}>
                {formatDateRange(blockDetails.start_at, blockDetails.end_at)}
              </p>
              <p className="note">{blockDetails.reason}</p>
            </section>
          )}
        </>
      )}
    </div>
  )
}
