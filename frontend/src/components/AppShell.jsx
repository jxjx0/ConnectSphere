// The shell for signed-in pages: a top bar over a full-width column. The
// signed-out pages use SplitLayout instead.

import { Link, useNavigate } from 'react-router-dom'

import { useAuth } from '../context/AuthContext'
import CoordinatorTabs from './CoordinatorTabs'
import LeadTabs from './LeadTabs'
import NotificationDropdown from './NotificationDropdown'
import SafetyTabs from './SafetyTabs'
import './WorkspaceLayout.css'

// Roles with their own tabs and workspace, on every page they share with others.
const WORKSPACE_TABS = {
  coordinator: CoordinatorTabs,
  event_coordinator_lead: LeadTabs,
  safety_officer: SafetyTabs,
}

export default function AppShell({ children }) {
  const { user, logout } = useAuth()
  const navigate = useNavigate()

  function handleLogout() {
    logout()
    navigate('/')
  }

  const WorkspaceTabs = WORKSPACE_TABS[user.role]
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
        {WorkspaceTabs && <WorkspaceTabs />}
        {children}
      </main>
    </>
  )

  return WorkspaceTabs ? <div className="workspace-ui">{shell}</div> : shell
}
