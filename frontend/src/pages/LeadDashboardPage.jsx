import { useState, useEffect, useMemo } from 'react'
import AppShell from '../components/AppShell'
import { getLeadCoordinatorEvents } from '../api/events'

// Helper function to convert snake_case strings to Title Case
const formatStatus = (status) => {
  if (!status) return 'Pending'
  return status
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

export default function LeadDashboardPage() {
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Filters
  const [nameFilter, setNameFilter] = useState('')
  const [coordinatorFilter, setCoordinatorFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')

  // Selected Event Modal
  const [selectedEvent, setSelectedEvent] = useState(null)

  useEffect(() => {
    const fetchLeadEvents = async () => {
      try {
        setLoading(true)
        const token = localStorage.getItem('connectsphere.token')
        const data = await getLeadCoordinatorEvents(token)
        setEvents(data || [])
      } catch (err) {
        const message =
          err.response?.data?.error || err.message || 'Failed to load lead coordinator events.'
        setError(message)
      } finally {
        setLoading(false)
      }
    }

    fetchLeadEvents()
  }, [])

  // Dynamically derive unique coordinator options from loaded events
  const coordinatorOptions = useMemo(() => {
    const names = events
      .map((evt) => evt.coordinator_name)
      .filter((name) => Boolean(name))
    return Array.from(new Set(names))
  }, [events])

  // Filter Logic
  const filteredEvents = events.filter((event) => {
    const nameMatch = (event.name || '')
      .toLowerCase()
      .includes(nameFilter.toLowerCase())

    const coordinatorMatch =
      coordinatorFilter === '' ||
      (event.coordinator_name || 'Unassigned') === coordinatorFilter

    const statusMatch =
      statusFilter === '' ||
      (event.status || '').toLowerCase() === statusFilter.toLowerCase()

    return nameMatch && coordinatorMatch && statusMatch
  })

  return (
    <AppShell>
      <div className="content__header">
        <div>
          <h1>Event Coordinator Overview</h1>
        </div>
      </div>

      {loading && <p className="note">Loading lead overview dashboard...</p>}

      {error && <p className="form-error" role="alert">{error}</p>}

      {!loading && !error && events.length === 0 && (
        <section className="stack stack--tight">
          <p className="note">No events assigned under coordinator oversight yet.</p>
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
                  <option value="draft">Draft</option>
                  <option value="under_review">Under Review</option>
                  <option value="change_requested">Change Requested</option>
                  <option value="awaiting_clarification">Awaiting Clarification</option>
                  <option value="planning">Planning</option>
                  <option value="confirmed">Confirmed</option>
                </select>
              </div>
            </div>
          </div>

          {/* Results Counter & Clear Filters Button */}
          <div
            style={{
              display: 'flex',
              justify: 'space-between',
              alignItems: 'center',
            }}
          >
            <p className="note">
              Showing <strong>{filteredEvents.length}</strong> of{' '}
              <strong>{events.length}</strong> total events
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

          {/* Venue-style Data Table */}
          {filteredEvents.length === 0 ? (
            <p className="note">No events match your selected criteria.</p>
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
                      <td>{event.coordinator_name || 'Unassigned'}</td>
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
                            onClick={() => setSelectedEvent(event)}
                          >
                            View Details
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

      {/* Details Modal */}
      {selectedEvent && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex',
            justify: 'center',
            alignItems: 'center',
            zIndex: 1000,
          }}
        >
          <div className="form-card" style={{ width: '100%', maxWidth: '550px', margin: 0 }}>
            <h2>{selectedEvent.name}</h2>
            <div className="stack stack--tight" style={{ marginTop: '1rem' }}>
              <div className="form-group">
                <label className="form-label">Coordinator</label>
                <p className="form-input" style={{ background: '#f5f5f5' }}>
                  {selectedEvent.coordinator_name || 'Unassigned'}
                </p>
              </div>

              <div className="form-group">
                <label className="form-label">Status</label>
                <p className="form-input" style={{ background: '#f5f5f5' }}>
                  {formatStatus(selectedEvent.status)}
                </p>
              </div>

              <div className="form-group">
                <label className="form-label">Venue</label>
                <p className="form-input" style={{ background: '#f5f5f5' }}>
                  {selectedEvent.venue_name || 'No venue assigned'}
                </p>
              </div>

              <div className="form-group">
                <label className="form-label">Expected Attendance</label>
                <p className="form-input" style={{ background: '#f5f5f5' }}>
                  {selectedEvent.expected_attendance ?? 0}
                </p>
              </div>

              <div className="form-group">
                <label className="form-label">Equipment Requirements</label>
                <p className="form-input" style={{ background: '#f5f5f5' }}>
                  {selectedEvent.equipment_requirements || 'None requested'}
                </p>
              </div>
            </div>

            <div style={{ display: 'flex', gap: '1rem', marginTop: '1.5rem' }}>
              <button
                type="button"
                className="button button--secondary"
                onClick={() => setSelectedEvent(null)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  )
}