export function attendeeNotificationTarget(notification, registrations = []) {
  if (!notification.event_id) return '/attendee/registrations'
  if (notification.type === 'registration_withdrawn') {
    // Match the withdrawal at the time of the notification, even if the
    // attendee has since registered again or withdrawn a second time.
    const notifiedAt = Date.parse(notification.created_at)
    const registration = registrations
      .filter((item) => item.event_id === notification.event_id
        && item.status === 'withdrawn'
        && (!Number.isFinite(notifiedAt) || Date.parse(item.withdrawn_at) <= notifiedAt))
      .sort((a, b) => Date.parse(b.withdrawn_at) - Date.parse(a.withdrawn_at))[0]
    if (registration) return `/attendee/registrations/${registration.id}`
  }
  return `/attendee/events/${notification.event_id}`
}
