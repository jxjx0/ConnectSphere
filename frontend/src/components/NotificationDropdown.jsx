// The bell button in the top bar (with an unread badge) and the
// notification dropdown it opens.
//
// The list is fetched on every page change, so the unread count stays
// fresh as the user moves around. There is no polling and no pop-up: the
// dropdown only opens when the user clicks the button.

import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'

import { getNotifications, markNotificationRead } from '../api/notifications'
import { useAuth } from '../context/AuthContext'
import { formatDateTime } from '../eventDisplay'
import { countUnread, inboxLabel, markReadInList } from '../notificationInbox'

export default function NotificationDropdown() {
  const { token } = useAuth()
  const location = useLocation()
  const [notifications, setNotifications] = useState([])
  const [isOpen, setIsOpen] = useState(false)
  const [error, setError] = useState('')
  const containerRef = useRef(null)

  useEffect(() => {
    getNotifications(token)
      .then((data) => {
        setNotifications(data.notifications)
        setError('')
      })
      .catch((caught) => setError(caught.message))
    setIsOpen(false)
  }, [token, location.pathname])

  // Close the dropdown when the user clicks outside it or presses Escape.
  useEffect(() => {
    if (!isOpen) return undefined

    function handleClick(event) {
      if (!containerRef.current.contains(event.target)) setIsOpen(false)
    }
    function handleKey(event) {
      if (event.key === 'Escape') setIsOpen(false)
    }

    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [isOpen])

  // The whole notification is already visible, so clicking it is what
  // "opening" means: it marks the notification read.
  function handleOpen(notification) {
    if (notification.is_read) return

    markNotificationRead(notification.id, token)
      .then(() => {
        setNotifications((current) => markReadInList(current, notification.id))
      })
      .catch((caught) => setError(caught.message))
  }

  const unreadCount = countUnread(notifications)

  return (
    <div className="inbox" ref={containerRef}>
      <button
        type="button"
        className="inbox__bell"
        aria-label={inboxLabel(unreadCount)}
        aria-expanded={isOpen}
        aria-controls="inbox-panel"
        onClick={() => setIsOpen((open) => !open)}
      >
        <BellIcon />
        {unreadCount > 0 && (
          <span className="inbox__badge" aria-hidden="true">{unreadCount}</span>
        )}
      </button>

      {isOpen && (
        <div id="inbox-panel" className="inbox__panel">
          <div className="inbox__header">
            <h2 className="inbox__heading">
              Notifications
              {unreadCount > 0 && (
                <span className="inbox__count">{unreadCount}</span>
              )}
            </h2>
            <button
              type="button"
              className="inbox__close"
              aria-label="Close notifications"
              onClick={() => setIsOpen(false)}
            >
              ×
            </button>
          </div>

          {error && <p className="form-error inbox__message" role="alert">{error}</p>}

          {!error && notifications.length === 0 && (
            <p className="note inbox__message">You have no notifications yet.</p>
          )}

          {notifications.length > 0 && (
            <ul className="inbox__list">
              {notifications.map((notification) => (
                <li key={notification.id}>
                  <button
                    type="button"
                    className={notification.is_read
                      ? 'inbox__item'
                      : 'inbox__item inbox__item--unread'}
                    onClick={() => handleOpen(notification)}
                  >
                    <span className="inbox__dot" aria-hidden="true" />
                    <span className="inbox__text">
                      {!notification.is_read && (
                        <span className="visually-hidden">Unread: </span>
                      )}
                      <span className="inbox__title">{notification.title}</span>
                      <span className="inbox__body">{notification.body}</span>
                      <span className="inbox__time">
                        {formatDateTime(notification.created_at)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

function BellIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  )
}
