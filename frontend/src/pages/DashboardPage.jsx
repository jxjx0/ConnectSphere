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
      <div className="content__header">
        <h1>Dashboard</h1>
        <p className="lead">
          Access your tasks and manage the arrangements relevant to your role.
        </p>
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
            <Link to="/equipment-requests" className="button">
              Request event equipment
            </Link>
            <Link to="/venues/search" className="backlink">Browse Venues</Link>
          </div>
        </section>
      )}

      {user.role === 'venue_staff' && (
        <section className="stack stack--tight">
          <h2 className="section-title">Venue Management</h2>
          <div className="form-actions">
            <Link to="/venues" className="button">
              View Venue Catalogue
            </Link>
            <Link to="/venues/create" className="button button--secondary">
              Create Venue Profile
            </Link>
            <Link to="/venues/availability" className="button button--secondary">
              View Venue Availability
            </Link>
          </div>
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

      {user.role === 'event_coordinator_lead' && ( 
        <section className="stack stack--tight"> 
          <h2 className="section-title">Event Overview</h2>
          <div className="form-actions"> 
            <Link to="/lead/dashboard" className="button"> 
              View Event Overview 
            </Link> 
            {/* <Link to="/equipment/new" className="button button--secondary"> 
              Create Equipment Profile 
            </Link>  */}
          </div> 
        </section> 
      )} 

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
    </AppShell>
  )
}
