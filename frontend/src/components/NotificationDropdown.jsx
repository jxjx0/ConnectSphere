// The bell button in the top bar (with an unread badge) and the
// notification dropdown it opens.
//
// The list is fetched on every page change, so the unread count stays
// fresh as the user moves around. There is no polling and no pop-up: the
// dropdown only opens when the user clicks the button.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

import { getNotifications, markNotificationRead } from '../api/notifications'
import { useAuth } from '../context/AuthContext'
import { formatDateTime } from '../eventDisplay'
import { inboxLabel, markReadInList } from '../notificationInbox'

export default function NotificationDropdown() {
  const { token, user } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  // The list holds the newest notifications only; the unread count comes
  // from the backend so it covers all of them.
  const [notifications, setNotifications] = useState([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [isOpen, setIsOpen] = useState(false)
  // Two kinds of error: the list failing to load, and a single notification
  // failing to be marked read. They are cleared at different times.
  const [loadError, setLoadError] = useState('')
  const [markError, setMarkError] = useState('')
  const containerRef = useRef(null)
  // Counts load requests. Only the most recent one may update the state, so
  // an older, slower response that finishes late cannot overwrite a newer one.
  const latestRequest = useRef(0)

  // Loads the list and unread count from the backend, the source of truth.
  const refresh = useCallback(() => {
    latestRequest.current += 1
    const requestId = latestRequest.current

    getNotifications(token)
      .then((data) => {
        if (requestId !== latestRequest.current) return
        setNotifications(data.notifications)
        setUnreadCount(data.unread_count)
        setLoadError('')
      })
      .catch((caught) => {
        if (requestId !== latestRequest.current) return
        setLoadError(caught.message)
      })
  }, [token])

  useEffect(() => {
    refresh()
    setIsOpen(false)
  }, [refresh, location.pathname])

  // An old "could not mark read" message should not linger once the user
  // closes the dropdown.
  useEffect(() => {
    if (!isOpen) setMarkError('')
  }, [isOpen])

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
  //
  // It is shown as read straight away, so a second click does nothing.
  // Once the backend has saved or rejected it, the list and count are
  // reloaded from the backend rather than adjusted by hand. A hand-made
  // "+1" could count the same notification twice if the list was refreshed
  // while the request was still pending.
  function handleOpen(notification) {
    if (!notification.is_read) {
      setMarkError('')
      setNotifications((current) => markReadInList(current, notification.id))
      setUnreadCount((count) => Math.max(count - 1, 0))

      markNotificationRead(notification.id, token)
        .catch((caught) => setMarkError(caught.message))
        .finally(refresh)
    }

    if (notification.event_id && user?.role === 'coordinator') {
      navigate(`/event-reviews/${notification.event_id}`)
    } else if (notification.event_id && user?.role === 'organiser') {
      navigate(`/my-events/${notification.event_id}`)
    } else if (
      notification.event_id
      && notification.type === 'event_cancelled'
      && user?.role === 'attendee'
    ) {
      navigate(`/attendee/events/${notification.event_id}`)
    }
  }

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

          {loadError && (
            <p className="form-error inbox__message" role="alert">{loadError}</p>
          )}
          {markError && (
            <p className="form-error inbox__message" role="alert">{markError}</p>
          )}

          {!loadError && notifications.length === 0 && (
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
