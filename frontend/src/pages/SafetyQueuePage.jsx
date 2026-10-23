import { useState, useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import AppShell from '../components/AppShell'
import { formatSessionSummary } from '../eventDisplay'
import { getSafetyQueue } from '../api/events'
import { useAuth } from '../context/AuthContext'

// Helper function to convert snake_case strings to Title Case
const formatStatus = (status) => {
  if (!status) return 'Awaiting Safety Check'
  return status
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

const formatDateTime = (isoString) => {
  if (!isoString) return { date: 'TBD', time: '' }
  const dateObj = new Date(isoString)
  if (isNaN(dateObj.getTime())) return { date: isoString, time: '' }

  const formattedDate = dateObj.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })

  const formattedTime = dateObj.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })

  return { date: formattedDate, time: formattedTime }
}

// Combines start and end times into a readable range (e.g., "Oct 19, 2026 at 9:00 AM – 5:00 PM")
const formatEventTiming = (startIso, endIso) => {
  const start = formatDateTime(startIso)
  const end = formatDateTime(endIso)

  if (start.date === 'TBD') return 'TBD'

  // If start and end are on the same day, display as single date with time range
  if (start.date === end.date) {
    return `${start.date}${start.time ? ` (${start.time} –${end.time})` : ''}`
  }

  // Multi-day event
  return `${start.date} ${start.time} – ${end.date} ${end.time}`
}

// Calculates relative time since status update (e.g., "2 hours ago")
const formatTimeAgo = (isoString) => {
  if (!isoString) return ''
  const date = new Date(isoString)
  if (isNaN(date.getTime())) return ''

  const seconds = Math.floor((new Date() - date) / 1000)
  if (seconds < 30) return 'Just now'

  const intervals = [
    { label: 'day', seconds: 86400 },
    { label: 'hour', seconds: 3600 },
    { label: 'minute', seconds: 60 },
  ]

  for (const i of intervals) {
    const count = Math.floor(seconds / i.seconds)
    if (count >= 1) {
      return `${count} ${i.label}${count > 1 ? 's' : ''} ago`
    }
  }
  return 'Just now'
}

export default function SafetyQueuePage() {
  const { token } = useAuth()
  const navigate = useNavigate()
  const [queue, setQueue] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    fetchQueue()
  }, [token])

  const fetchQueue = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await getSafetyQueue(token)
      const queueList = Array.isArray(res)
        ? res
        : res?.queue || res?.events || []
      setQueue(queueList)
    } catch (err) {
      const message =
        err.response?.data?.error || err.message || 'Failed to load safety queue.'
      setError(message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <AppShell>
      <div className="content__header" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <div>
          <button
            type="button"
            className="button button--secondary button--small"
            onClick={() => navigate('/dashboard')}
            style={{ marginBottom: '0.75rem', display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}
          >
            ← Back to Dashboard
          </button>
          <h1>Safety Check Queue</h1>
          <p className="lead">
            Events requiring safety review and compliance approval.
          </p>
        </div>
      </div>

      {loading && <p className="note">Loading safety queue...</p>}

      {error && <p className="form-error" role="alert">{error}</p>}

      {!loading && !error && queue.length === 0 && (
        <section className="stack stack--tight">
          <p className="note">
            No events are currently waiting for safety review.
          </p>
        </section>
      )}

      {!loading && !error && queue.length > 0 && (
        <section className="stack stack--tight">
          <div className="table-wrapper">
            <table className="venue-table">
              <caption className="visually-hidden">Safety Check Queue</caption>
              <thead>
                <tr>
                  <th scope="col">Event Name</th>
                  <th scope="col">Category</th>
                  <th scope="col">Event Timing</th>
                  <th scope="col">Ready for Review</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="venue-table__actions">Actions</th>
                </tr>
              </thead>
              <tbody>
                {queue.map((item) => {
                  const eventTiming = formatEventTiming(item.start_time, item.end_time)
                  const transitionTime = item.updated_at || item.created_at
                  const readyDate = formatDateTime(transitionTime)
                  const relativeTime = formatTimeAgo(transitionTime)

                  return (
                    <tr key={item.id}>
                      <th scope="row">{item.name}</th>
                      <td>{item.category ? formatStatus(item.category) : 'General'}</td>
                      <td>
                        <div>{eventTiming}</div>
                        <div style={{ fontSize: '0.8rem', color: '#666', marginTop: '2px' }}>
                          {formatSessionSummary(item)}
                        </div>
                      </td>
                      <td>
                        <div>{readyDate.date}</div>
                        {relativeTime && (
                          <div style={{ fontSize: '0.8rem', color: '#666', marginTop: '2px' }}>
                            {relativeTime}
                          </div>
                        )}
                      </td>
                      <td>
                        <span className="tag">
                          {formatStatus(item.status)}
                        </span>
                      </td>
                      <td className="venue-table__actions">
                        <div className="venue-table__action-buttons">
                          <Link
                            to={`/safetyreview/${item.id}`}
                            className="button button--primary button--small"
                          >
                            Review Event
                          </Link>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </AppShell>
  )
}