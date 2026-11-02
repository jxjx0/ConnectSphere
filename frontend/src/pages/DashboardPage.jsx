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

  if (user.role === 'organiser') {
    return (
      <div className="organiser-ui">
        <AppShell>
          <div className="organiser-dashboard">
            <header className="organiser-dashboard__header">
              <p className="organiser-dashboard__eyebrow">Organiser workspace</p>
              <h1>Welcome back, {user.full_name}</h1>
              <p className="organiser-dashboard__lead">
                Plan your next event and keep track of your requests in one place.
              </p>
            </header>

            <section
              className="organiser-dashboard__section"
              aria-labelledby="organiser-actions-title"
            >
              <div className="organiser-dashboard__section-heading">
                <h2 id="organiser-actions-title">Your event requests</h2>
                <p>What would you like to do today?</p>
              </div>

              <div className="organiser-dashboard__cards">
                <article className="organiser-dashboard__card">
                  <div className="organiser-dashboard__card-content">
                    <p className="organiser-dashboard__card-label">Get started</p>
                    <h3>Request an event</h3>
                    <p>
                      Tell us about your event and submit a request for the team to review.
                    </p>
                  </div>
                  <Link to="/my-events/new" className="button">
                    Create an event request
                  </Link>
                </article>

                <article className="organiser-dashboard__card">
                  <div className="organiser-dashboard__card-content">
                    <p className="organiser-dashboard__card-label">Your activity</p>
                    <h3>My event requests</h3>
                    <p>
                      Check progress, respond to questions, or continue working on a draft.
                    </p>
                  </div>
                  <Link to="/my-events" className="button button--secondary">
                    View my requests
                  </Link>
                </article>
              </div>
            </section>

          </div>
        </AppShell>
      </div>
    )
  }

  return (
    <AppShell>
      <div className="content__header">
        <h1>Dashboard</h1>
        <p className="lead">
          Access your tasks and manage the arrangements relevant to your role.
        </p>
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
          <div className="form-actions">
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
            <Link to="/venues/reviewRequests" className="button button--secondary">
              Review Venue Requests
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
