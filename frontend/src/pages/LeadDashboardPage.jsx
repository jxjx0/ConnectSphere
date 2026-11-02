import { useEffect, useMemo, useState } from 'react'

import {
  assignCoordinatorToEvent,
  getCoordinatorsList,
  getEventActivityLogs,
  getLeadCoordinatorEvents,
} from '../api/events'
import AppShell from '../components/AppShell'
import WorkspaceDialog from '../components/WorkspaceDialog'
import {
  formatDateRange,
  formatDateTime,
  formatSessionSummary,
  readableStatus,
} from '../eventDisplay'
import { openRequestBadges, statusLabel } from '../eventStatus'
import { coordinatorOptionLabel } from '../leadCoordinatorView'

// Open requests are filtered by the badge flags, not the status.
const OPEN_REQUEST_FLAGS = {
  clarification: 'has_open_clarification',
  change: 'has_pending_change_request',
  cancellation: 'has_pending_cancellation_request',
}

const STAGE_OPTIONS = [
  'under_review', 'planning', 'awaiting_safety_check', 'confirmed',
  'completed', 'rejected', 'cancelled',
]

function isAssigned(event) {
  return (event.status || '').toLowerCase() !== 'draft'
    && event.coordinator_id
    && event.coordinator_name
    && event.coordinator_name.toLowerCase() !== 'unassigned'
}

export default function LeadDashboardPage() {
  const [events, setEvents] = useState([])
  const [coordinators, setCoordinators] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [nameFilter, setNameFilter] = useState('')
  const [coordinatorFilter, setCoordinatorFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [openRequestFilter, setOpenRequestFilter] = useState('')

  const [selectedEvent, setSelectedEvent] = useState(null)
  const [activityLogs, setActivityLogs] = useState([])
  const [loadingLogs, setLoadingLogs] = useState(false)

  const [showReassignForm, setShowReassignForm] = useState(false)
  const [selectedCoordinatorId, setSelectedCoordinatorId] = useState('')
  const [reassignReason, setReassignReason] = useState('')
  const [reassigning, setReassigning] = useState(false)
  const [reassignError, setReassignError] = useState('')
  const [actionSuccess, setActionSuccess] = useState('')

  async function fetchDashboardData() {
    setLoading(true)
    setError('')
    try {
      const token = localStorage.getItem('connectsphere.token')
      const [eventsData, coordinatorsRes] = await Promise.all([
        getLeadCoordinatorEvents(token),
        getCoordinatorsList(token),
      ])
      setEvents((eventsData || []).filter(isAssigned))
      setCoordinators(Array.isArray(coordinatorsRes) ? coordinatorsRes : coordinatorsRes?.coordinators || [])
    } catch (caught) {
      setError(caught.response?.data?.error || caught.message || 'Could not load events.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchDashboardData()
  }, [])

  const coordinatorNames = useMemo(
    () => Array.from(new Set(events.map((event) => event.coordinator_name))).sort(),
    [events],
  )

  const filteredEvents = events.filter((event) => (
    (event.name || '').toLowerCase().includes(nameFilter.trim().toLowerCase())
    && (!coordinatorFilter || event.coordinator_name === coordinatorFilter)
    && (!statusFilter || (event.status || '').toLowerCase() === statusFilter)
    && (!openRequestFilter || Boolean(event[OPEN_REQUEST_FLAGS[openRequestFilter]]))
  ))
  const hasFilters = Boolean(nameFilter || coordinatorFilter || statusFilter || openRequestFilter)

  async function openDetails(event) {
    setSelectedEvent(event)
    setShowReassignForm(false)
    setSelectedCoordinatorId('')
    setReassignReason('')
    setReassignError('')
    setActionSuccess('')
    setActivityLogs([])

    setLoadingLogs(true)
    try {
      const token = localStorage.getItem('connectsphere.token')
      const logsData = await getEventActivityLogs(event.id, token)
      setActivityLogs(logsData.logs || logsData || [])
    } catch {
      setActivityLogs([])
    } finally {
      setLoadingLogs(false)
    }
  }

  async function handleReassign(submit) {
    submit.preventDefault()
    if (!selectedCoordinatorId) {
      setReassignError('Choose a coordinator.')
      return
    }

    setReassigning(true)
    setReassignError('')
    try {
      const token = localStorage.getItem('connectsphere.token')
      await assignCoordinatorToEvent(selectedEvent.id, selectedCoordinatorId, reassignReason, token)
      setActionSuccess(`${selectedEvent.name} has been reassigned.`)
      setSelectedEvent(null)
      fetchDashboardData()
    } catch (caught) {
      setReassignError(caught.response?.data?.error || caught.message || 'Could not reassign this event.')
    } finally {
      setReassigning(false)
    }
  }

  const otherCoordinators = coordinators.filter((coordinator) => coordinator.id !== selectedEvent?.coordinator_id)

  return (
    <AppShell>
      <div className="content__header">
        <h1>All Events</h1>
        <p className="lead">See every assigned event, and reassign one when plans change.</p>
      </div>

      {loading && <p className="note">Loading events…</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {actionSuccess && <p className="form-success" role="status">{actionSuccess}</p>}

      {!loading && !error && events.length === 0 && (
        <p className="workspace-empty">No events have been assigned to a coordinator yet.</p>
      )}

      {!loading && !error && events.length > 0 && (
        <section className="stack stack--tight">
          <div className="workspace-filters">
            <div className="field">
              <label htmlFor="name-filter">Event</label>
              <input
                id="name-filter"
                type="search"
                placeholder="Search by event name…"
                value={nameFilter}
                onChange={(change) => setNameFilter(change.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="coordinator-filter">Coordinator</label>
              <select id="coordinator-filter" value={coordinatorFilter} onChange={(change) => setCoordinatorFilter(change.target.value)}>
                <option value="">All coordinators</option>
                {coordinatorNames.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="status-filter">Stage</label>
              <select id="status-filter" value={statusFilter} onChange={(change) => setStatusFilter(change.target.value)}>
                <option value="">All stages</option>
                {STAGE_OPTIONS.map((status) => <option key={status} value={status}>{statusLabel(status)}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="open-request-filter">Open request</label>
              <select id="open-request-filter" value={openRequestFilter} onChange={(change) => setOpenRequestFilter(change.target.value)}>
                <option value="">Any</option>
                <option value="clarification">Clarification open</option>
                <option value="change">Change pending</option>
                <option value="cancellation">Cancellation pending</option>
              </select>
            </div>
          </div>

          <div className="workspace-result-bar">
            <p className="note" role="status">
              Showing <strong>{filteredEvents.length}</strong> of <strong>{events.length}</strong> events
            </p>
            {hasFilters && (
              <button
                type="button"
                className="button button--secondary button--small"
                onClick={() => {
                  setNameFilter('')
                  setCoordinatorFilter('')
                  setStatusFilter('')
                  setOpenRequestFilter('')
                }}
              >
                Clear filters
              </button>
            )}
          </div>

          {filteredEvents.length === 0 ? (
            <p className="workspace-empty">No events match these filters.</p>
          ) : (
            <div className="table-wrapper">
              <table className="venue-table">
                <caption className="visually-hidden">All assigned events</caption>
                <thead>
                  <tr>
                    <th scope="col">Event</th>
                    <th scope="col">Coordinator</th>
                    <th scope="col">When</th>
                    <th scope="col">Status</th>
                    <th scope="col" className="venue-table__actions">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredEvents.map((event) => (
                    <tr key={event.id}>
                      <th scope="row">{event.name}</th>
                      <td>{event.coordinator_name}</td>
                      <td>{formatDateRange(event.start_time, event.end_time)}</td>
                      <td>
                        <div className="event-card__tags" style={{ marginTop: 0 }}>
                          <span className="tag">{statusLabel(event.status)}</span>
                          {openRequestBadges(event, 'lead coordinator').map((badge) => (
                            <span className="tag tag--warning" key={badge.kind}>{badge.label}</span>
                          ))}
                        </div>
                      </td>
                      <td className="venue-table__actions">
                        <button type="button" className="button button--secondary button--small" onClick={() => openDetails(event)}>
                          View details
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {selectedEvent && (
        <WorkspaceDialog title={selectedEvent.name} onClose={() => setSelectedEvent(null)}>
          {!showReassignForm ? (
            <div className="stack stack--tight">
              <dl className="detail-list">
                <div className="detail-list__row">
                  <dt>Coordinator</dt>
                  <dd>{selectedEvent.coordinator_name}</dd>
                </div>
                <div className="detail-list__row">
                  <dt>When</dt>
                  <dd>{formatDateRange(selectedEvent.start_time, selectedEvent.end_time)}</dd>
                </div>
                <div className="detail-list__row">
                  <dt>Status</dt>
                  <dd>{statusLabel(selectedEvent.status)}</dd>
                </div>
                <div className="detail-list__row">
                  <dt>Sessions</dt>
                  <dd>{formatSessionSummary(selectedEvent)}</dd>
                </div>
                <div className="detail-list__row">
                  <dt>Venues</dt>
                  {/* One per session (T7-278); cancelled and rejected ones are left out. */}
                  <dd>
                    {selectedEvent.venues?.length
                      ? selectedEvent.venues.map((venue) => (
                        <span key={`${venue.session_name}-${venue.venue_name}`} style={{ display: 'block' }}>
                          {venue.session_name}: {venue.venue_name} ({readableStatus(venue.status).toLowerCase()})
                        </span>
                      ))
                      : 'No venue yet'}
                  </dd>
                </div>
              </dl>

              <h3>Assignment history</h3>
              {loadingLogs && <p className="note">Loading history…</p>}
              {!loadingLogs && activityLogs.length === 0 && (
                <p className="note">No assignments have been recorded.</p>
              )}
              {!loadingLogs && activityLogs.map((log) => (
                <article className="notice" key={log.id}>
                  <p>
                    <strong>{log.action_type === 'ASSIGNMENT' ? 'Assigned to' : 'Reassigned to'}</strong>
                    {' '}{log.new_coordinator?.full_name || 'Coordinator'}
                    {log.previous_coordinator && ` (previously ${log.previous_coordinator.full_name})`}
                  </p>
                  <p className="field__hint">
                    By {log.changed_by?.full_name || 'System'} on {formatDateTime(log.created_at)}
                  </p>
                  {log.reason && <p>Reason: {log.reason}</p>}
                </article>
              ))}

              <div className="form-actions">
                <button type="button" className="button" onClick={() => setShowReassignForm(true)}>
                  Reassign
                </button>
                <button type="button" className="button button--secondary" onClick={() => setSelectedEvent(null)}>
                  Close
                </button>
              </div>
            </div>
          ) : (
            <form className="form" onSubmit={handleReassign}>
              <p className="note">Currently with <strong>{selectedEvent.coordinator_name}</strong>.</p>
              <div className="field">
                <label htmlFor="reassign-select">New coordinator</label>
                <select
                  id="reassign-select"
                  value={selectedCoordinatorId}
                  onChange={(change) => setSelectedCoordinatorId(change.target.value)}
                  required
                  autoFocus
                >
                  <option value="">Choose a coordinator…</option>
                  {otherCoordinators.map((coordinator) => (
                    <option key={coordinator.id} value={coordinator.id}>
                      {coordinatorOptionLabel(coordinator, events)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="reassign-reason">Reason</label>
                <textarea
                  id="reassign-reason"
                  rows={3}
                  value={reassignReason}
                  onChange={(change) => setReassignReason(change.target.value)}
                  placeholder="Why is this event moving to someone else?"
                  required
                />
              </div>
              {reassignError && <p className="form-error" role="alert">{reassignError}</p>}
              <div className="form-actions">
                <button type="submit" className="button" disabled={reassigning}>
                  {reassigning ? 'Reassigning…' : 'Confirm reassignment'}
                </button>
                <button
                  type="button"
                  className="button button--secondary"
                  onClick={() => setShowReassignForm(false)}
                  disabled={reassigning}
                >
                  Back
                </button>
              </div>
            </form>
          )}
        </WorkspaceDialog>
      )}
    </AppShell>
  )
}
