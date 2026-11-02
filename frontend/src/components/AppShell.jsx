// The shell for signed-in pages: a top bar over a full-width column. The
// signed-out pages use SplitLayout instead.

import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom'

import { useAuth } from '../context/AuthContext'
import NotificationDropdown from './NotificationDropdown'
import './AttendeeLayout.css'
import '../styles/venueStaff.css'

export default function AppShell({ children }) {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const isVenueStaff = user.role === 'venue_staff'
  const inCatalogue = pathname === '/venues' || pathname === '/venues/create' || /^\/venues\/[^/]+\/edit$/.test(pathname)

  function handleLogout() {
    logout()
    navigate('/')
  }

  const shell = (
    <>
      <header className="topbar">
        <div className="topbar__inner">
          <Link to="/dashboard" className="wordmark">
            ConnectSphere
          </Link>

          <div className="topbar__user">
            <NotificationDropdown />
            <span className="topbar__name">{user.full_name}</span>
            <button
              type="button"
              className="button button--secondary button--small"
              onClick={handleLogout}
            >
              Log out
            </button>
          </div>
        </div>
      </header>

      <main id={isVenueStaff ? 'venue-workspace-main' : undefined} className="app-main">
        {isVenueStaff && <nav className="form-actions attendee-tabs venue-workspace__nav" aria-label="Venue staff">
          <NavLink to="/dashboard" end className="button button--small button--secondary">Overview</NavLink>
          <Link to="/venues" aria-current={inCatalogue ? 'page' : undefined} className="button button--small button--secondary">Venue catalogue</Link>
          <NavLink to="/venues/availability" className="button button--small button--secondary">Availability</NavLink>
          <NavLink to="/venues/reviewRequests" className="button button--small button--secondary">Booking requests</NavLink>
        </nav>}
        {children}
      </main>
    </>
  )

  // Reuse the existing Attendee theme; staff CSS only adapts task layouts.
  return isVenueStaff ? <div className="attendee-ui venue-workspace">
    <a className="venue-workspace__skip" href="#venue-workspace-main">Skip to content</a>
    {shell}
  </div> : shell
}
