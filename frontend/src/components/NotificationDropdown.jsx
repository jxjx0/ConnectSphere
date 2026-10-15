// The "Inbox (n)" button in the top bar and the dropdown it opens.
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
  const [openId, setOpenId] = useState(null)
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

  return (
    <div className="inbox" ref={containerRef}>
      <button
        type="button"
        className="topbar__link"
        aria-expanded={isOpen}
        aria-controls="inbox-panel"
        onClick={() => setIsOpen((open) => !open)}
      >
        {inboxLabel(countUnread(notifications))}
      </button>

      {isOpen && (
        <div id="inbox-panel" className="inbox__panel">
          {error && <p className="form-error" role="alert">{error}</p>}

          {!error && notifications.length === 0 && (
            <p className="note">You have no notifications yet.</p>
          )}

          {notifications.length > 0 && (
            <ul className="inbox__list">
              {notifications.map((notification) => {
                const isItemOpen = openId === notification.id
                return (
                  <li key={notification.id} className="inbox__item">
                    <button
                      type="button"
                      className={notification.is_read
                        ? 'inbox__title'
                        : 'inbox__title inbox__title--unread'}
                      aria-expanded={isItemOpen}
                      onClick={() => handleToggle(notification)}
                    >
                      {!notification.is_read && (
                        <span className="visually-hidden">Unread: </span>
                      )}
                      {notification.title}
                    </button>

                    {isItemOpen && (
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
      )}
    </div>
  )
}
