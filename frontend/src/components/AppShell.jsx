// The shell for signed-in pages: a top bar over a full-width column. The
// signed-out pages use SplitLayout instead.

import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'

import { getNotifications } from '../api/notifications'
import { useAuth } from '../context/AuthContext'
import { countUnread, inboxLabel } from '../notificationInbox'

// `unreadCount` is only passed by the inbox page, which already has the
// list and keeps the count current as notifications are opened. Every
// other page leaves it out, and the shell fetches the count itself.
export default function AppShell({ children, unreadCount }) {
  const { user, token, logout } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [fetchedUnreadCount, setFetchedUnreadCount] = useState(0)

  // Refetch on every page change, so the count is fresh after navigating.
  // There is no polling and no pop-up: the count only shows in the link.
  useEffect(() => {
    if (unreadCount !== undefined) return
    getNotifications(token)
      .then((data) => setFetchedUnreadCount(countUnread(data.notifications)))
      // A failed count must not break the page; the link just shows "Inbox".
      .catch(() => setFetchedUnreadCount(0))
  }, [token, location.pathname, unreadCount])

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
            <Link to="/inbox" className="topbar__link">
              {inboxLabel(unreadCount ?? fetchedUnreadCount)}
            </Link>
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
