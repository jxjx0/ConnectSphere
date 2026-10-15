// Small pure helpers for the notification inbox, kept out of the page so
// they can be unit tested.

// Returns a new list with one notification's is_read set; the rest unchanged.
function setReadInList(notifications, notificationId, isRead) {
  return notifications.map((notification) => (
    notification.id === notificationId
      ? { ...notification, is_read: isRead }
      : notification
  ))
}

export function markReadInList(notifications, notificationId) {
  return setReadInList(notifications, notificationId, true)
}

// Used to undo markReadInList when the backend could not save it.
export function markUnreadInList(notifications, notificationId) {
  return setReadInList(notifications, notificationId, false)
}

// "Inbox" on its own when nothing is unread, otherwise "Inbox (3)".
export function inboxLabel(unreadCount) {
  return unreadCount > 0 ? `Inbox (${unreadCount})` : 'Inbox'
}
