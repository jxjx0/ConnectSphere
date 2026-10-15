import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

import { getNotifications, markNotificationRead } from '../api/notifications'
import AppShell from '../components/AppShell'
import { useAuth } from '../context/AuthContext'
import { formatDateTime } from '../eventDisplay'
import { countUnread, markReadInList } from '../notificationInbox'

export default function InboxPage() {
  const { token } = useAuth()
  const [notifications, setNotifications] = useState([])
  const [openId, setOpenId] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getNotifications(token)
      .then((data) => setNotifications(data.notifications))
      .catch((caught) => setError(caught.message))
      .finally(() => setLoading(false))
  }, [token])

  // Opening a notification shows its message and marks it read. Clicking
  // an open one again closes it.
  function handleToggle(notification) {
    if (openId === notification.id) {
      setOpenId(null)
      return
    }
    setOpenId(notification.id)

    if (!notification.is_read) {
      markNotificationRead(notification.id, token)
        .then(() => {
          setNotifications((current) => markReadInList(current, notification.id))
        })
        .catch((caught) => setError(caught.message))
    }
  }

  // The inbox owns the list, so it gives the top bar the live unread count
  // instead of the top bar fetching its own copy.
  const unreadCount = countUnread(notifications)

  if (loading) {
    return (
      <AppShell unreadCount={unreadCount}>
        <p className="page-state">Loading your notifications…</p>
      </AppShell>
    )
  }

  return (
    <AppShell unreadCount={unreadCount}>
      <div className="content">
        <Link to="/dashboard" className="backlink">← Dashboard</Link>
        <div className="content__header">
          <h1>Inbox</h1>
          <p className="lead">Updates about your events.</p>
        </div>

        {error && <p className="form-error" role="alert">{error}</p>}

        {!error && notifications.length === 0 && (
          <p className="note">You have no notifications yet.</p>
        )}

        {notifications.length > 0 && (
          <ul className="inbox">
            {notifications.map((notification) => {
              const isOpen = openId === notification.id
              return (
                <li key={notification.id} className="inbox__item">
                  <button
                    type="button"
                    className={notification.is_read
                      ? 'inbox__title'
                      : 'inbox__title inbox__title--unread'}
                    aria-expanded={isOpen}
                    onClick={() => handleToggle(notification)}
                  >
                    {!notification.is_read && (
                      <span className="visually-hidden">Unread: </span>
                    )}
                    {notification.title}
                  </button>

                  {isOpen && (
                    <div className="inbox__detail">
                      <p>{notification.body}</p>
                      <p className="note">
                        {formatDateTime(notification.created_at)}
                      </p>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </AppShell>
  )
}
