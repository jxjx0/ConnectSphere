// The shell for signed-in pages: a top bar over a full-width column. The
// signed-out pages use SplitLayout instead.

import { Link, useLocation, useNavigate } from 'react-router-dom'

import { useAuth } from '../context/AuthContext'
import NotificationDropdown from './NotificationDropdown'

const NAVIGATION_BY_ROLE = {
  organiser: [
    { to: '/dashboard', label: 'Dashboard' },
    { to: '/my-events', label: 'My events' },
    {
      to: '/my-events/new',
      label: 'New event',
      activePaths: ['/my-events/new', '/my-events/drafts'],
    },
  ],
  attendee: [
    { to: '/attendee/events', label: 'Browse events' },
    { to: '/attendee/registrations', label: 'My registrations' },
  ],
  coordinator: [
    {
      to: '/dashboard',
      label: 'Dashboard',
      activePaths: ['/dashboard', '/event-reviews'],
    },
    { to: '/venues/search', label: 'Venue search' },
    { to: '/venues/availability', label: 'Venue availability' },
    { to: '/equipment-requests', label: 'Equipment requests' },
  ],
  tech_support: [
    { to: '/dashboard', label: 'Dashboard' },
    { to: '/equipment', label: 'Equipment' },
    {
      to: '/equipment/bookings',
      label: 'Bookings',
      matches: (pathname) => /^\/equipment\/[^/]+\/bookings$/.test(pathname),
    },
    { to: '/equipment-requests', label: 'Equipment requests' },
  ],
  venue_staff: [
    { to: '/dashboard', label: 'Dashboard' },
    { to: '/venues', label: 'Venues' },
    { to: '/venues/availability', label: 'Availability' },
    { to: '/venues/reviewRequests', label: 'Review requests' },
  ],
  safety_officer: [
    { to: '/safetyreview', label: 'Safety reviews' },
  ],
  event_coordinator_lead: [
    { to: '/lead/dashboard', label: 'Event overview' },
    { to: '/events/unassigned-queue', label: 'Unassigned events' },
  ],
}

function isWithinPath(pathname, path) {
  return pathname === path || pathname.startsWith(`${path}/`)
}

function activeNavigationItem(items, pathname) {
  const matchLength = (item) => {
    const activePaths = item.activePaths || [item.to]
    const pathLength = Math.max(0, ...activePaths
      .filter((path) => isWithinPath(pathname, path))
      .map((path) => path.length))

    return item.matches?.(pathname)
      ? Math.max(pathLength, item.to.length)
      : pathLength
  }

  return items.reduce((active, item) => (
    matchLength(item) > (active ? matchLength(active) : 0) ? item : active
  ), null)
}

export default function AppShell({ children }) {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const navigation = NAVIGATION_BY_ROLE[user.role] || []
  const activeItem = activeNavigationItem(navigation, location.pathname)

  function handleLogout() {
    logout()
    navigate('/')
  }

  return (
    <>
      <header className="topbar">
        <div className="topbar__inner">
          <Link to="/dashboard" className="wordmark">
            ConnectSphere
          </Link>

          {navigation.length > 0 && (
            <nav className="topbar__nav" aria-label="Main navigation">
              {navigation.map((item) => {
                const current = item === activeItem
                return (
                  <Link
                    key={item.to}
                    to={item.to}
                    className="topbar__nav-link"
                    aria-current={current ? 'page' : undefined}
                  >
                    {item.label}
                  </Link>
                )
              })}
            </nav>
          )}

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

      <main className="app-main">{children}</main>
    </>
  )
}
