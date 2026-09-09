// The shell for signed-in pages: a top bar over a full-width column. The
// signed-out pages use SplitLayout instead.

import { Link, useNavigate } from 'react-router-dom'

import { useAuth } from '../context/AuthContext'

export default function AppShell({ children }) {
  const { user, logout } = useAuth()
  const navigate = useNavigate()

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

          <div className="topbar__user">
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
