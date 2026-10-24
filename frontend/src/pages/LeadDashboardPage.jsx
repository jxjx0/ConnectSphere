import { useState, useEffect, useMemo } from 'react'
import AppShell from '../components/AppShell'
import { formatSessionSummary, readableStatus } from '../eventDisplay'
import {
  getLeadCoordinatorEvents,
  getCoordinatorsList,
  assignCoordinatorToEvent,
  getEventActivityLogs,
} from '../api/events'

// Helper function to convert snake_case strings to Title Case
const formatStatus = (status) => {
  if (!status) return 'Pending'
  return status
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

const formatDateTime = (isoString) => {
  if (!isoString) return { date: 'Unassigned', time: '' }
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

export default function LeadDashboardPage() {
  const [events, setEvents] = useState([])
  const [coordinators, setCoordinators] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Filters
  const [nameFilter, setNameFilter] = useState('')
  const [coordinatorFilter, setCoordinatorFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')

  // Selected Event & Audit Trail State
  const [selectedEvent, setSelectedEvent] = useState(null)
  const [activityLogs, setActivityLogs] = useState([])
  const [loadingLogs, setLoadingLogs] = useState(false)

  // Reassignment Form State
  const [showReassignForm, setShowReassignForm] = useState(false)
  const [selectedCoordinatorId, setSelectedCoordinatorId] = useState('')
  const [reassignReason, setReassignReason] = useState('')
  const [reassigning, setReassigning] = useState(false)
  const [reassignError, setReassignError] = useState('')
  const [actionSuccess, setActionSuccess] = useState('')

  useEffect(() => {
    fetchDashboardData()
  }, [])

  const fetchDashboardData = async () => {
    try {
      setLoading(true)
      setError(null)
      const token = localStorage.getItem('connectsphere.token')
      
      const [eventsData, coordsRes] = await Promise.all([
        getLeadCoordinatorEvents(token),
        getCoordinatorsList(token),
      ])

      // Strictly exclude draft events AND unassigned events
      const assignedNonDraftEvents = (eventsData || []).filter((evt) => {
        const isDraft = (evt.status || '').toLowerCase() === 'draft'
        const isUnassigned =
          !evt.coordinator_id ||
          !evt.coordinator_name ||
          evt.coordinator_name.toLowerCase() === 'unassigned'

        return !isDraft && !isUnassigned
      })

      setEvents(assignedNonDraftEvents)
      
      const coordsList = Array.isArray(coordsRes)
        ? coordsRes
        : coordsRes?.coordinators || []
      setCoordinators(coordsList)
    } catch (err) {
      const message =
        err.response?.data?.error || err.message || 'Failed to load lead coordinator events.'
      setError(message)
    } finally {
      setLoading(false)
    }
  }

  // Derive coordinator options for filter bar (Only assigned coordinator names)
  const coordinatorOptions = useMemo(() => {
    const names = events
      .map((evt) => evt.coordinator_name)
      .filter((name) => Boolean(name) && name.toLowerCase() !== 'unassigned')
    return Array.from(new Set(names))
  }, [events])

  // Filter Logic
  const filteredEvents = events.filter((event) => {
    // Safety check: ignore drafts and unassigned events
    if ((event.status || '').toLowerCase() === 'draft') return false
    if (
      !event.coordinator_id ||
      !event.coordinator_name ||
      event.coordinator_name.toLowerCase() === 'unassigned'
    ) {
      return false
    }

    const nameMatch = (event.name || '')
      .toLowerCase()
      .includes(nameFilter.toLowerCase())

    const coordinatorMatch =
      coordinatorFilter === '' ||
      event.coordinator_name === coordinatorFilter

    const statusMatch =
      statusFilter === '' ||
      (event.status || '').toLowerCase() === statusFilter.toLowerCase()

    return nameMatch && coordinatorMatch && statusMatch
  })

  const handleOpenReassignModal = async (event) => {
    setSelectedEvent(event)
    setShowReassignForm(false)
    setSelectedCoordinatorId('')
    setReassignReason('')
    setReassignError('')
    setActionSuccess('')

    // Fetch activity logs for audit trail
    setLoadingLogs(true)
    try {
      const token = localStorage.getItem('connectsphere.token')
      const logsData = await getEventActivityLogs(event.id, token)
      setActivityLogs(logsData.logs || logsData || [])
    } catch (err) {
      setActivityLogs([])
    } finally {
      setLoadingLogs(false)
    }
  }

  const handleCloseModal = () => {
    setSelectedEvent(null)
    setShowReassignForm(false)
    setSelectedCoordinatorId('')
    setReassignReason('')
    setReassignError('')
    setActivityLogs([])
  }

  const handleReassignSubmit = async (e) => {
    e.preventDefault()
    if (!selectedCoordinatorId) {
      setReassignError('Please select a coordinator.')
      return
    }

    setReassigning(true)
    setReassignError('')

    try {
      const token = localStorage.getItem('connectsphere.token')
      await assignCoordinatorToEvent(
        selectedEvent.id,
        selectedCoordinatorId,
        reassignReason,
        token
      )

      setActionSuccess(`Successfully reassigned "${selectedEvent.name}"!`)
      handleCloseModal()
      fetchDashboardData()
    } catch (err) {
      const message =
        err.response?.data?.error || err.message || 'Failed to reassign event.'
      setReassignError(message)
    } finally {
      setReassigning(false)
    }
  }

  const start = selectedEvent ? formatDateTime(selectedEvent.start_time || selectedEvent.start_date) : null
  const end = selectedEvent ? formatDateTime(selectedEvent.end_time || selectedEvent.end_date) : null

  return (
    <AppShell>
      <div className="content__header">
        <div>
          <h1>Event Coordinator Overview</h1>
        </div>
      </div>

      {loading && <p className="note">Loading lead overview dashboard...</p>}

      {error && <p className="form-error" role="alert">{error}</p>}

      {actionSuccess && (
        <p className="note" style={{ color: 'green', fontWeight: 'bold' }}>
          {actionSuccess}
        </p>
      )}

      {!loading && !error && events.length === 0 && (
        <section className="stack stack--tight">
          <p className="note">No assigned events found under coordinator oversight yet.</p>
        </section>
      )}

      {!loading && !error && events.length > 0 && (
        <section className="stack stack--tight">
          {/* Filter Bar */}
          <div className="filter-card">
            <div className="filter-grid">
              <div className="form-group">
                <label className="form-label" htmlFor="name-filter">
                  Search Event Name
                </label>
                <input
                  id="name-filter"
                  type="text"
                  className="form-input"
                  placeholder="Filter by event name..."
                  value={nameFilter}
                  onChange={(e) => setNameFilter(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="coordinator-filter">
                  Filter by Coordinator
                </label>
                <select
                  id="coordinator-filter"
                  className="form-input"
                  value={coordinatorFilter}
                  onChange={(e) => setCoordinatorFilter(e.target.value)}
                >
                  <option value="">All Coordinators</option>
                  {coordinatorOptions.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="status-filter">
                  Filter by Status
                </label>
                <select
                  id="status-filter"
                  className="form-input"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                >
                  <option value="">All Statuses</option>
                  <option value="under_review">Under Review</option>
                  <option value="change_requested">Change Requested</option>
                  <option value="awaiting_clarification">Awaiting Clarification</option>
                  <option value="planning">Planning</option>
                  <option value="confirmed">Confirmed</option>
                </select>
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <p className="note">
              Showing <strong>{filteredEvents.length}</strong> of{' '}
              <strong>{events.length}</strong> total assigned events
            </p>
            {(nameFilter || coordinatorFilter || statusFilter) && (
              <button
                type="button"
                className="button button--secondary button--small"
                onClick={() => {
                  setNameFilter('')
                  setCoordinatorFilter('')
                  setStatusFilter('')
                }}
              >
                Clear Filters
              </button>
            )}
          </div>

          {filteredEvents.length === 0 ? (
            <p className="note">No assigned events match your selected criteria.</p>
          ) : (
            <div className="table-wrapper">
              <table className="venue-table">
                <caption className="visually-hidden">Events overview</caption>
                <thead>
                  <tr>
                    <th scope="col">Event Name</th>
                    <th scope="col">Coordinator</th>
                    <th scope="col">Status</th>
                    <th scope="col" className="venue-table__actions">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredEvents.map((event) => (
                    <tr key={event.id}>
                      <th scope="row">{event.name}</th>
                      <td>{event.coordinator_name}</td>
                      <td>
                        <span className="tag">
                          {formatStatus(event.status)}
                        </span>
                      </td>
                      <td className="venue-table__actions">
                        <div className="venue-table__action-buttons">
                          <button
                            type="button"
                            className="button button--secondary button--small"
                            onClick={() => handleOpenReassignModal(event)}
                          >
                            View & Reassign
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* Details & Reassignment Modal */}
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
              margin: 'auto' 
            }}
          >
            <h2>{selectedEvent.name}</h2>

            {!showReassignForm ? (
              /* View Details View with Audit Trail */
              <div className="stack stack--tight" style={{ marginTop: '1rem' }}>
                <div className="form-group">
                  <label className="form-label">Current Coordinator</label>
                  <p className="form-input" style={{ background: '#f5f5f5' }}>
                    {selectedEvent.coordinator_name}
                  </p>
                </div>

                <div className="form-group">
                  <label className="form-label">Event Schedule</label>
                  <p className="form-input" style={{ background: '#f5f5f5', marginBottom: '0.5rem' }}>
                    <strong>Start:</strong> {start.date} {start.time && `at ${start.time}`}
                  </p>
                  <p className="form-input" style={{ background: '#f5f5f5' }}>
                    <strong>End:</strong> {end.date} {end.time && `at ${end.time}`}
                  </p>
                </div>

                <div className="form-group">
                  <label className="form-label">Status</label>
                  <p className="form-input" style={{ background: '#f5f5f5' }}>
                    {formatStatus(selectedEvent.status)}
                  </p>
                </div>

                <div className="form-group">
                  <label className="form-label">Venues</label>
                  {/* One per session (T7-278); cancelled and rejected ones are left out. */}
                  <p className="form-input" style={{ background: '#f5f5f5' }}>
                    {selectedEvent.venues?.length
                      ? selectedEvent.venues.map((venue) => (
                        <span key={`${venue.session_name}-${venue.venue_name}`} style={{ display: 'block' }}>
                          {venue.session_name}: {venue.venue_name} ({readableStatus(venue.status).toLowerCase()})
                        </span>
                      ))
                      : 'No venue assigned'}
                  </p>
                </div>

                <div className="form-group">
                  <label className="form-label">Sessions and attendance</label>
                  <p className="form-input" style={{ background: '#f5f5f5' }}>
                    {formatSessionSummary(selectedEvent)}
                  </p>
                </div>

                {/* Audit Trail & Reassignment History */}
                <div className="form-group" style={{ marginTop: '1rem' }}>
                  <label className="form-label">Audit Trail & Reassignment History</label>
                  {loadingLogs ? (
                    <p className="note">Loading history logs...</p>
                  ) : activityLogs.length === 0 ? (
                    <p className="note">No previous reassignments recorded.</p>
                  ) : (
                    <ul className="stack stack--tight" style={{ listStyle: 'none', paddingLeft: 0, marginTop: '0.5rem' }}>
                      {activityLogs.map((log) => {
                        const logTime = formatDateTime(log.created_at)
                        return (
                          <li
                            key={log.id}
                            style={{
                              border: '1px solid #e2e8f0',
                              borderRadius: '6px',
                              padding: '0.75rem',
                              background: '#fafafa',
                            }}
                          >
                            <div>
                              <strong>
                                {log.action_type === 'ASSIGNMENT' ? 'Assigned to: ' : 'Reassigned to: '}
                              </strong>
                              {log.new_coordinator?.full_name || 'Coordinator'}
                              {log.previous_coordinator && (
                                <span> (previously {log.previous_coordinator.full_name})</span>
                              )}
                            </div>
                            <div style={{ fontSize: '0.85rem', color: '#666' }}>
                              By {log.changed_by?.full_name || 'System'} on {logTime.date} {logTime.time && `at ${logTime.time}`}
                            </div>
                            {log.reason && (
                              <div style={{ marginTop: '0.25rem', fontSize: '0.9rem' }}>
                                <em>Reason: "{log.reason}"</em>
                              </div>
                            )}
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </div>

                <div style={{ display: 'flex', gap: '1rem', marginTop: '1.5rem' }}>
                  <button
                    type="button"
                    className="button button--primary"
                    onClick={() => setShowReassignForm(true)}
                  >
                    Reassign Coordinator
                  </button>
                  <button
                    type="button"
                    className="button button--secondary"
                    onClick={handleCloseModal}
                  >
                    Close
                  </button>
                </div>
              </div>
            ) : (
              /* Reassignment Form View */
              <form onSubmit={handleReassignSubmit} className="stack stack--tight" style={{ marginTop: '1rem' }}>
                <h3>Reassign Event</h3>
                
                {reassignError && <p className="form-error" role="alert">{reassignError}</p>}

                <div className="form-group">
                  <label className="form-label" htmlFor="reassign-select">
                    Select New Coordinator
                  </label>
                  <select
                    id="reassign-select"
                    className="form-input"
                    value={selectedCoordinatorId}
                    onChange={(e) => setSelectedCoordinatorId(e.target.value)}
                    required
                  >
                    <option value="">-- Choose Coordinator --</option>
                    {coordinators
                      .filter((c) => c.id !== selectedEvent.coordinator_id)
                      .map((coord) => (
                        <option key={coord.id} value={coord.id}>
                          {coord.full_name || coord.email}
                        </option>
                      ))}
                  </select>
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="reassign-reason">
                    Reason for Reassignment
                  </label>
                  <textarea
                    id="reassign-reason"
                    className="form-input"
                    value={reassignReason}
                    onChange={(e) => setReassignReason(e.target.value)}
                    rows={3}
                    placeholder="Provide a reason for changing the assigned coordinator..."
                    required
                  />
                </div>

                <div style={{ display: 'flex', gap: '1rem', marginTop: '1.5rem' }}>
                  <button
                    type="submit"
                    className="button button--primary"
                    disabled={reassigning}
                  >
                    {reassigning ? 'Reassigning...' : 'Confirm Reassignment'}
                  </button>
                  <button
                    type="button"
                    className="button button--secondary"
                    onClick={() => setShowReassignForm(false)}
                    disabled={reassigning}
                  >
                    Back to Details
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </AppShell>
  )
}