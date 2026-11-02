import { useEffect, useState } from 'react'

import {
  assignCoordinatorToEvent,
  getCoordinatorsList,
  getLeadCoordinatorEvents,
  getUnassignedEventsQueue,
} from '../api/events'
import AppShell from '../components/AppShell'
import WorkspaceDialog from '../components/WorkspaceDialog'
import { categoryLabel } from '../eventCategories'
import { formatDateRange, formatSessionSummary } from '../eventDisplay'
import { statusLabel } from '../eventStatus'
import { coordinatorOptionLabel, formatTimeAgo } from '../leadCoordinatorView'

export default function UnassignedQueuePage() {
  const [queue, setQueue] = useState([])
  const [coordinators, setCoordinators] = useState([])
  const [assignedEvents, setAssignedEvents] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [selectedEvent, setSelectedEvent] = useState(null)
  const [selectedCoordinatorId, setSelectedCoordinatorId] = useState('')
  const [assignmentReason, setAssignmentReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [assignError, setAssignError] = useState('')
  const [actionSuccess, setActionSuccess] = useState('')

  async function fetchData() {
    setLoading(true)
    setError('')
    try {
      const token = localStorage.getItem('connectsphere.token')
      const [queueRes, coordinatorsRes, overview] = await Promise.all([
        getUnassignedEventsQueue(token),
        getCoordinatorsList(token),
        // Only adds each Coordinator's workload, so assigning works without it.
        getLeadCoordinatorEvents(token).catch(() => []),
      ])
      setQueue(Array.isArray(queueRes) ? queueRes : queueRes?.events || [])
      setCoordinators(Array.isArray(coordinatorsRes) ? coordinatorsRes : coordinatorsRes?.coordinators || [])
      setAssignedEvents(Array.isArray(overview) ? overview : [])
    } catch (caught) {
      setError(caught.response?.data?.error || caught.message || 'Could not load unassigned events.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchData()
  }, [])

  function openAssign(event) {
    setSelectedEvent(event)
    setSelectedCoordinatorId('')
    setAssignmentReason('')
    setAssignError('')
    setActionSuccess('')
  }

  async function handleAssign(submit) {
    submit.preventDefault()
    if (!selectedCoordinatorId) {
      setAssignError('Choose a coordinator to assign.')
      return
    }

    setSubmitting(true)
    setAssignError('')
    try {
      const token = localStorage.getItem('connectsphere.token')
      await assignCoordinatorToEvent(selectedEvent.id, selectedCoordinatorId, assignmentReason, token)
      setActionSuccess(`${selectedEvent.name} has been assigned.`)
      setSelectedEvent(null)
      fetchData()
    } catch (caught) {
      setAssignError(caught.response?.data?.error || caught.message || 'Could not assign this event.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AppShell>
      <div className="content__header">
        <h1>Unassigned Events</h1>
        <p className="lead">Assign a coordinator to each new event request.</p>
      </div>

      {loading && <p className="note">Loading unassigned events…</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {actionSuccess && <p className="form-success" role="status">{actionSuccess}</p>}

      {!loading && !error && queue.length === 0 && (
        <p className="workspace-empty">All caught up. Every event request has a coordinator.</p>
      )}

      {!loading && !error && queue.length > 0 && (
        <section className="stack stack--tight">
          <p className="note">
            <strong>{queue.length}</strong> {queue.length === 1 ? 'event needs' : 'events need'} a coordinator
          </p>
          <div className="table-wrapper">
            <table className="venue-table">
              <caption className="visually-hidden">Unassigned events</caption>
              <thead>
                <tr>
                  <th scope="col">Event</th>
                  <th scope="col">Category</th>
                  <th scope="col">When</th>
                  <th scope="col">Submitted</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="venue-table__actions">Actions</th>
                </tr>
              </thead>
              <tbody>
                {queue.map((item) => (
                  <tr key={item.id}>
                    <th scope="row">{item.name}</th>
                    <td>{categoryLabel(item.category, item.category_other)}</td>
                    <td>
                      <div>{formatDateRange(item.start_time, item.end_time)}</div>
                      <div className="field__hint">{formatSessionSummary(item)}</div>
                    </td>
                    <td>{formatTimeAgo(item.created_at) || 'Unknown'}</td>
                    <td><span className="tag">{statusLabel(item.status)}</span></td>
                    <td className="venue-table__actions">
                      <button type="button" className="button button--small" onClick={() => openAssign(item)}>
                        Assign
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {selectedEvent && (
        <WorkspaceDialog title={`Assign ${selectedEvent.name}`} onClose={() => setSelectedEvent(null)}>
          <form className="form" onSubmit={handleAssign}>
            <div className="field">
              <label htmlFor="coordinator-select">Coordinator</label>
              <select
                id="coordinator-select"
                value={selectedCoordinatorId}
                onChange={(change) => setSelectedCoordinatorId(change.target.value)}
                required
                autoFocus
              >
                <option value="">Choose a coordinator…</option>
                {coordinators.map((coordinator) => (
                  <option key={coordinator.id} value={coordinator.id}>
                    {coordinatorOptionLabel(coordinator, assignedEvents)}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="assignment-reason">Notes (optional)</label>
              <textarea
                id="assignment-reason"
                rows={3}
                value={assignmentReason}
                onChange={(change) => setAssignmentReason(change.target.value)}
                placeholder="e.g. Has run similar conferences."
              />
            </div>
            {assignError && <p className="form-error" role="alert">{assignError}</p>}
            <div className="form-actions">
              <button type="submit" className="button" disabled={submitting}>
                {submitting ? 'Assigning…' : 'Assign coordinator'}
              </button>
              <button
                type="button"
                className="button button--secondary"
                onClick={() => setSelectedEvent(null)}
                disabled={submitting}
              >
                Cancel
              </button>
            </div>
          </form>
        </WorkspaceDialog>
      )}
    </AppShell>
  )
}
