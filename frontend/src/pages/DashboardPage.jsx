import { useEffect, useState } from 'react'

import { getAssignedEventRequests } from '../api/events'
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

  return (
    <AppShell>
      <div className={user.role === 'venue_staff' ? 'content__header venue-overview__header' : 'content__header'}>
        <h1>{user.role === 'venue_staff' ? 'Venue management' : 'Dashboard'}</h1>
        {user.role === 'venue_staff' && <Link to="/venues/create" className="button">
          <span aria-hidden="true">+</span> Create venue profile
        </Link>}
        {user.role !== 'venue_staff' && <p className="lead">
          Access your tasks and manage the arrangements relevant to your role.
        </p>}
      </div>

      {user.role === 'organiser' && (
        <section className="stack stack--tight">
          <h2 className="section-title">Event Requests</h2>
          <div className="form-actions">
            <Link to="/my-events/new" className="button">
              Request an Event
            </Link>
            <Link to="/my-events" className="button button--secondary">
              My Event Requests
            </Link>
          </div>
        </section>
      )}

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
          <div className="form-actions">
            <Link to="/venues/search" className="backlink">Browse Venues</Link>
          </div>
        </section>
      )}

      {user.role === 'venue_staff' && (
        <section className="attendee-grid venue-overview__grid" aria-label="Venue management tasks">
          <Link to="/venues/reviewRequests" className="venue-overview__card">
            <span className="venue-overview__icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <rect x="5" y="4" width="14" height="17" rx="2" />
                <path d="M9 3h6v3H9zM9 11l2 2 4-4M9 17h6" />
              </svg>
            </span>
            <h2>Booking requests</h2>
            <p>Review booking details and compare requests with the venue schedule.</p>
            <span className="venue-overview__card-action">Review requests <span aria-hidden="true">&rarr;</span></span>
          </Link>
          <Link to="/venues/availability" className="venue-overview__card">
            <span className="venue-overview__icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="5" width="18" height="16" rx="2" />
                <path d="M7 3v4M17 3v4M3 10h18M7 14h3M14 14h3M7 17h3" />
              </svg>
            </span>
            <h2>Venue availability</h2>
            <p>Check booked time, operational blocks and tentative holds.</p>
            <span className="venue-overview__card-action">View calendar <span aria-hidden="true">&rarr;</span></span>
          </Link>
          <Link to="/venues" className="venue-overview__card">
            <span className="venue-overview__icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 21h18M5 21V5l7-2 7 2v16M9 21v-5h6v5M9 8h1M14 8h1M9 12h1M14 12h1" />
              </svg>
            </span>
            <h2>Venue catalogue</h2>
            <p>Manage venue details, room layouts, capacity and facilities.</p>
            <span className="venue-overview__card-action">View Venue Catalogue <span aria-hidden="true">&rarr;</span></span>
          </Link>
        </section>
      )}

      {user.role === 'tech_support' && ( 
        <section className="stack stack--tight"> 
          <h2 className="section-title">Equipment Management</h2>
          <div className="form-actions"> 
            <Link to="/equipment-requests" className="button">
              Review equipment requests
            </Link>
            <Link to="/equipment" className="button"> 
              View Equipment Catalogue 
            </Link> 
            <Link to="/equipment/new" className="button button--secondary"> 
              Create Equipment Profile 
            </Link> 
          </div> 
        </section> 
      )} 

      {user.role === 'safety_officer' && ( 
        <section className="stack stack--tight"> 
          <h2 className="section-title">Safety Check</h2>
          <div className="form-actions"> 
            <Link to="/safetyreview" className="button">
              View Safety Check Queue
            </Link>
            {/* <Link to="/equipment/new" className="button button--secondary"> 
              Create Equipment Profile 
            </Link>  */}
          </div> 
        </section> 
      )} 

      {user.role === 'event_coordinator_lead' && ( 
        <section className="stack stack--tight"> 
          <h2 className="section-title">Event Overview</h2>
          <div className="form-actions"> 
            <Link to="/lead/dashboard" className="button"> 
              View Event Overview 
            </Link> 
            <Link to="/events/unassigned-queue" className="button button--secondary"> 
              View Unassigned Events 
            </Link> 
          </div> 
        </section> 
      )} 

      {user.role !== 'venue_staff' && <section className="stack stack--tight">
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
      </section>}
    </AppShell>
  )
}
