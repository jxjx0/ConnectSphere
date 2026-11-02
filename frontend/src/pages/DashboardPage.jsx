import { useEffect, useState } from 'react'

import { getAssignedEventRequests } from '../api/events'
import { getPendingVenueBookings } from '../api/venues'
import AppShell from '../components/AppShell'
import AssignedRequestTabs from '../components/AssignedRequestTabs'
import { useAuth } from '../context/AuthContext'
import { Link } from 'react-router-dom'

// Roles arrive as 'venue_staff'; people read "Venue staff".
function readableRole(role) {
  const words = role.replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export default function DashboardPage() {
  const { user, token } = useAuth()
  const isCoordinator = user.role === 'coordinator'
  const isVenueStaff = user.role === 'venue_staff'
  const [pendingRequests, setPendingRequests] = useState({ count: null, error: false })
  const [assignedEvents, setAssignedEvents] = useState([])
  const [assignedError, setAssignedError] = useState('')
  const [assignedLoading, setAssignedLoading] = useState(isCoordinator)

  useEffect(() => {
    if (!isCoordinator) return
    getAssignedEventRequests(token)
      .then((data) => setAssignedEvents(data.events))
      .catch((caught) => setAssignedError(caught.message))
      .finally(() => setAssignedLoading(false))
  }, [isCoordinator, token])

  useEffect(() => {
    if (!isVenueStaff) return
    let active = true
    setPendingRequests({ count: null, error: false })
    getPendingVenueBookings(token)
      .then((data) => {
        if (!Array.isArray(data.bookings)) throw new Error('Invalid booking response')
        if (active) setPendingRequests({ count: data.bookings.length, error: false })
      })
      .catch(() => {
        if (active) setPendingRequests({ count: null, error: true })
      })
    return () => { active = false }
  }, [isVenueStaff, token])

  return (
    <AppShell>
      <div className={isVenueStaff ? 'content__header venue-overview__header' : 'content__header'}>
        <h1>{isVenueStaff ? 'Venue management' : isCoordinator ? 'My Events' : 'Dashboard'}</h1>
        {isVenueStaff && <Link to="/venues/create" className="button">
          <span aria-hidden="true">+</span> Create venue profile
        </Link>}
        {!isVenueStaff && <p className="lead">
          {isCoordinator
            ? 'See what needs you next, and manage the arrangements for each event.'
            : 'Access your tasks and manage the arrangements relevant to your role.'}
        </p>}
      </div>

      {isCoordinator && (
        <section className="stack stack--tight">
          <h2 className="section-title">Assigned Event Requests</h2>
          {assignedLoading && (
            <p className="note">Loading assigned event requests…</p>
          )}
          {assignedError && (
            <p className="form-error" role="alert">{assignedError}</p>
          )}
          {!assignedLoading && !assignedError && (
            <AssignedRequestTabs events={assignedEvents} />
          )}
        </section>
      )}

      {user.role === 'venue_staff' && (
        <section className="attendee-grid venue-overview__grid" aria-label="Venue management tasks">
          <Link to="/venues/reviewRequests" className={`venue-overview__card${pendingRequests.count > 0 ? ' venue-overview__card--pending' : ''}`}>
            <div className="venue-overview__card-heading">
              <h2>Venue booking requests</h2>
              <span role="status">
                {pendingRequests.error ? <span className="note">Count unavailable</span>
                  : pendingRequests.count === null ? <span className="note">Checking requests...</span>
                  : pendingRequests.count > 0 ? <span className="tag venue-overview__pending-count">{pendingRequests.count} pending</span>
                  : <span className="tag tag--registered">All caught up</span>}
              </span>
            </div>
            <span className="venue-overview__card-action">Review requests <span aria-hidden="true">&rarr;</span></span>
          </Link>
          <Link to="/venues/availability" className="venue-overview__card">
            <h2>Venue calendar availability</h2>
            <span className="venue-overview__card-action">View calendar <span aria-hidden="true">&rarr;</span></span>
          </Link>
          <Link to="/venues" className="venue-overview__card">
            <h2>Venue catalogue</h2>
            <span className="venue-overview__card-action">View Venue Catalogue <span aria-hidden="true">&rarr;</span></span>
          </Link>
        </section>
      )}

      {/* Coordinators and Venue Staff already have their name in the top bar. */}
      {!isCoordinator && !isVenueStaff && (
        <section className="stack stack--tight">
          <h2 className="section-title">Your account</h2>

          <dl className="detail-list">
            <div className="detail-list__row">
              <dt>Name</dt>
              <dd>{user.full_name}</dd>
            </div>
            <div className="detail-list__row">
              <dt>Role</dt>
              <dd>
                <span className="tag">{readableRole(user.role)}</span>
              </dd>
            </div>
          </dl>
        </section>
      )}
    </AppShell>
  )
}
