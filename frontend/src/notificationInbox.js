// Small pure helpers for the notification inbox, kept out of the page so
// they can be unit tested.

export function countUnread(notifications) {
  return notifications.filter((notification) => !notification.is_read).length
}

// Returns a new list with one notification marked read; the rest unchanged.
export function markReadInList(notifications, notificationId) {
  return notifications.map((notification) => (
    notification.id === notificationId
      ? { ...notification, is_read: true }
      : notification
  ))
}

// "Inbox" on its own when nothing is unread, otherwise "Inbox (3)".
export function inboxLabel(unreadCount) {
  return unreadCount > 0 ? `Inbox (${unreadCount})` : 'Inbox'
}
