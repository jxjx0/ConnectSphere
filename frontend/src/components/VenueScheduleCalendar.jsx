import React, { useEffect, useState } from 'react'
import { getVenueAvailability } from '../api/venues'
import { formatDateRange } from '../eventDisplay'
import {
  calendarBlockPositions,
  calendarWeek,
  localDateValue,
  shiftCalendarDate,
  validateCalendarResponse,
} from '../venueAvailability'
import styles from './VenueScheduleCalendar.module.css'

export default function VenueScheduleCalendar({ venueId, initialDate, token }) {
  const [date, setDate] = useState(() => initialDate || localDateValue())
  const [result, setResult] = useState({ loading: false, error: '', data: null })
  const [selectedBlock, setSelectedBlock] = useState(null)

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

  useEffect(() => {
    if (!venueId || !start || !end) return
    let active = true

    setResult({ loading: true, error: '', data: null })
    getVenueAvailability(venueId, { start_at: start, end_at: end }, token)
      .then((data) => {
        if (active) {
          setResult({
            loading: false,
            error: '',
            data: validateCalendarResponse(data, venueId, { start_at: start, end_at: end }),
          })
        }
      })
      .catch((err) => {
        if (active) setResult({ loading: false, error: err.message, data: null })
      })

    return () => {
      active = false
    }
  }, [venueId, start, end, token])

  const formatDay = (val) =>
    val.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

  const blockDetails = selectedBlock && result.data
    ? result.data.items.find((item) => item.id === selectedBlock)
    : null

  return (
    <div className={styles.container}>
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
            Prev
          </button>
          <button
            type="button"
            className="button button--secondary button--small"
            onClick={() => setDate(initialDate || localDateValue())}
          >
            Today
          </button>
          <button
            type="button"
            className="button button--secondary button--small"
            disabled={!week}
            onClick={() => setDate(shiftCalendarDate(date, 7))}
          >
            Next
          </button>
        </div>
      </div>

      {dateError && <p className="form-error" role="alert">{dateError}</p>}
      {result.loading && <p className="note">Loading schedule...</p>}
      {result.error && <p className="form-error" role="alert">{result.error}</p>}

      {!result.loading && week && result.data && (
        <>
          <div className={styles.scrollArea} tabIndex={0} role="region" aria-label="Weekly time grid">
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
                  <div className={styles.hourLines} aria-hidden="true">
                    {Array.from({ length: 24 }, (_, hour) => (
                      <span key={hour} />
                    ))}
                  </div>

                  {calendarBlockPositions(result.data.items, day).map(({ item, top, height, left, width }) => (
                    <button
                      type="button"
                      key={item.id}
                      className={`${styles.timeBlock} ${height < 100 / 24 ? styles.timeBlockCompact : ''}`}
                      style={{ top: `${top}%`, height: `${height}%`, left: `${left}%`, width: `${width}%` }}
                      title={`${item.reason}. ${formatDateRange(item.start_at, item.end_at)}`}
                      onClick={() => setSelectedBlock(item.id)}
                    >
                      {height >= 100 / 24 && <strong>{item.reason}</strong>}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>

          {blockDetails && (
            <section className={`${styles.blockDetail} stack stack--tight`}>
              <div className={styles.navigation}>
                <h3 style={{ fontSize: '0.875rem' }}>Block Details</h3>
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