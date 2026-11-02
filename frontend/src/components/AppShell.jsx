// The shell for signed-in pages: a top bar over a full-width column. The
// signed-out pages use SplitLayout instead.

import { Link, useNavigate } from 'react-router-dom'

import { useAuth } from '../context/AuthContext'
import CoordinatorTabs from './CoordinatorTabs'
import NotificationDropdown from './NotificationDropdown'
import './WorkspaceLayout.css'

export default function AppShell({ children }) {
  const { user, logout } = useAuth()
  const navigate = useNavigate()

  function handleLogout() {
    logout()
    navigate('/')
  }

  const isCoordinator = user.role === 'coordinator'
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

      <main className="app-main">
        {isCoordinator && <CoordinatorTabs />}
        {children}
      </main>
    </>
  )

  // Coordinators have their own workspace on every page they share with others.
  return isCoordinator ? <div className="workspace-ui">{shell}</div> : shell
}
