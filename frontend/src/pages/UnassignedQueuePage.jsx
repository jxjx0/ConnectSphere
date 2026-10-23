import { useState, useEffect } from 'react'
import AppShell from '../components/AppShell'
import { formatSessionSummary } from '../eventDisplay'
import {
  getUnassignedEventsQueue,
  getCoordinatorsList,
  assignCoordinatorToEvent,
} from '../api/events'

// Helper function to convert snake_case strings to Title Case
const formatStatus = (status) => {
  if (!status) return 'Under Review'
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

// Calculates relative time since request creation (e.g., "2 hours ago")
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

export default function UnassignedQueuePage() {
  const [queue, setQueue] = useState([])
  const [coordinators, setCoordinators] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Modal State
  const [selectedEvent, setSelectedEvent] = useState(null)
  const [selectedCoordinatorId, setSelectedCoordinatorId] = useState('')
  const [assignmentReason, setAssignmentReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [actionSuccess, setActionSuccess] = useState('')

  useEffect(() => {
    fetchData()
  }, [])

  const fetchData = async () => {
    setLoading(true)
    setError(null)
    try {
      const token = localStorage.getItem('connectsphere.token')
      const [queueRes, coordinatorsRes] = await Promise.all([
        getUnassignedEventsQueue(token),
        getCoordinatorsList(token),
      ])

      // Safely extract arrays from response structures
      const queueList = Array.isArray(queueRes)
        ? queueRes
        : queueRes?.events || []
      setQueue(queueList)

      const coordsList = Array.isArray(coordinatorsRes)
        ? coordinatorsRes
        : coordinatorsRes?.coordinators || []
      setCoordinators(coordsList)
    } catch (err) {
      const message =
        err.response?.data?.error || err.message || 'Failed to load unassigned queue data.'
      setError(message)
    } finally {
      setLoading(false)
    }
  }

  const handleOpenAssignModal = (event) => {
    setSelectedEvent(event)
    setSelectedCoordinatorId('')
    setAssignmentReason('')
    setActionSuccess('')
    setError(null)
  }

  const handleCloseModal = () => {
    setSelectedEvent(null)
    setSelectedCoordinatorId('')
    setAssignmentReason('')
  }

  const handleAssignSubmit = async (e) => {
    e.preventDefault()
    if (!selectedCoordinatorId) {
      setError('Please select a coordinator to assign.')
      return
    }

    setSubmitting(true)
    setError(null)

    try {
      const token = localStorage.getItem('connectsphere.token')
      await assignCoordinatorToEvent(
        selectedEvent.id,
        selectedCoordinatorId,
        assignmentReason,
        token
      )

      setActionSuccess(`Successfully assigned "${selectedEvent.name}"!`)
      handleCloseModal()
      fetchData()
    } catch (err) {
      const message =
        err.response?.data?.error || err.message || 'Failed to assign coordinator.'
      setError(message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AppShell>
      <div className="content__header">
        <div>
          <h1>Unassigned Events Queue</h1>
        </div>
      </div>

      {loading && <p className="note">Loading unassigned queue...</p>}

      {error && <p className="form-error" role="alert">{error}</p>}

      {actionSuccess && (
        <p className="note" style={{ color: 'green', fontWeight: 'bold' }}>
          {actionSuccess}
        </p>
      )}

      {!loading && !error && queue.length === 0 && (
        <section className="stack stack--tight">
          <p className="note">No unassigned events found. All submitted event requests are currently assigned.</p>
        </section>
      )}

      {!loading && !error && queue.length > 0 && (
        <section className="stack stack--tight">
          <div className="table-wrapper">
            <table className="venue-table">
              <caption className="visually-hidden">Unassigned Events Queue</caption>
              <thead>
                <tr>
                  <th scope="col">Event Name</th>
                  <th scope="col">Category</th>
                  <th scope="col">Start Date</th>
                  <th scope="col">Submitted</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="venue-table__actions">Actions</th>
                </tr>
              </thead>
              <tbody>
                {queue.map((item) => {
                  const schedule = formatDateTime(item.start_time)
                  const submitted = formatDateTime(item.created_at)
                  const relativeTime = formatTimeAgo(item.created_at)

                  return (
                    <tr key={item.id}>
                      <th scope="row">{item.name}</th>
                      <td>{item.category ? formatStatus(item.category) : 'N/A'}</td>
                      <td>
                        <div>{schedule.date} {schedule.time && `at ${schedule.time}`}</div>
                        <div style={{ fontSize: '0.8rem', color: '#666', marginTop: '2px' }}>
                          {formatSessionSummary(item)}
                        </div>
                      </td>
                      <td>
                        <div>{submitted.date}</div>
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
                          <button
                            type="button"
                            className="button button--secondary button--small"
                            onClick={() => handleOpenAssignModal(item)}
                          >
                            Assign Coordinator
                          </button>
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

      {/* Centered Assignment Modal */}
      {selectedEvent && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            width: '100vw',
            height: '100vh',
            background: 'rgba(0,0,0,0.5)',
            display: 'grid',
            placeItems: 'center',
            zIndex: 1000,
            padding: '1.5rem',
            boxSizing: 'border-box',
          }}
        >
          <div
            className="form-card"
            style={{
              width: '100%',
              maxWidth: '550px',
              maxHeight: '85vh',
              overflowY: 'auto',
              margin: 'auto',
            }}
          >
            <h2>Assign Coordinator</h2>
            <p className="note" style={{ marginBottom: '1rem' }}>
              Assigning event request: <strong>{selectedEvent.name}</strong>
            </p>

            <form onSubmit={handleAssignSubmit} className="stack stack--tight">
              <div className="form-group">
                <label className="form-label" htmlFor="coordinator-select">
                  Select Coordinator
                </label>
                <select
                  id="coordinator-select"
                  className="form-input"
                  value={selectedCoordinatorId}
                  onChange={(e) => setSelectedCoordinatorId(e.target.value)}
                  required
                >
                  <option value="">-- Choose Coordinator --</option>
                  {(Array.isArray(coordinators) ? coordinators : []).map((coord) => (
                    <option key={coord.id} value={coord.id}>
                      {coord.full_name || coord.email || coord.id}
                    </option>
                  ))}
                </select>
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="assignment-reason">
                  Reason / Notes (Optional)
                </label>
                <textarea
                  id="assignment-reason"
                  className="form-input"
                  value={assignmentReason}
                  onChange={(e) => setAssignmentReason(e.target.value)}
                  rows={3}
                  placeholder="e.g. Assigned based on domain experience with conference events."
                />
              </div>

              <div style={{ display: 'flex', gap: '1rem', marginTop: '1.5rem' }}>
                <button
                  type="submit"
                  className="button button--primary"
                  disabled={submitting}
                >
                  {submitting ? 'Assigning...' : 'Confirm Assignment'}
                </button>
                <button
                  type="button"
                  className="button button--secondary"
                  onClick={handleCloseModal}
                  disabled={submitting}
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </AppShell>
  )
}