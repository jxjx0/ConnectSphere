// Attendee workspace keeps its navigation and design separate from other roles.

import { Link, useLocation, useNavigate } from 'react-router-dom'

import { useAuth } from '../context/AuthContext'
import AttendeeNotificationDropdown from './AttendeeNotificationDropdown'
import AttendeeTabs from './AttendeeTabs'
import './AttendeeLayout.css'

export default function AttendeeShell({ children }) {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const { pathname } = useLocation()

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
            <AttendeeNotificationDropdown />
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

      <main className="app-main">
        <AttendeeTabs current={pathname.startsWith('/attendee/registrations')
          ? '/attendee/registrations' : '/attendee/events'} />
        {children}
      </main>
    </>
  )

  return <div className="attendee-ui">{shell}</div>
}
