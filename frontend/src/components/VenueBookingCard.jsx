import React from 'react'
import { formatDateTime, readableStatus } from '../eventDisplay'
import styles from './VenueBookingCard.module.css'

/**
 * Returns CSS module class corresponding to booking status style.
 */
function getStatusClass(status) {
  switch (status) {
    case 'APPROVED':
      return styles.approved
    case 'PENDING_VENUE_APPROVAL':
      return styles.pending
    case 'REJECTED':
      return styles.rejected
    default:
      return styles.defaultStatus
  }
}

export default function VenueBookingCard({ booking, actions }) {
  if (!booking) return null

  const statusClass = getStatusClass(booking.status)

  return (
    <div className={`${styles.card} ${statusClass}`}>
      <div className={styles.header}>
        <strong className={styles.venueName}>
          {booking.venues?.name || `Venue ID: ${booking.venue_id}`}
        </strong>
        <span className="tag">{readableStatus(booking.status)}</span>
      </div>

      <div className={styles.grid}>
        <div>
          <span className={`note ${styles.label}`}>Requested Layout:</span>
          <span className={styles.value}>{booking.room_layout}</span>
        </div>
        <div>
          <span className={`note ${styles.label}`}>Submitted On:</span>
          <span className={styles.value}>
            {formatDateTime(booking.created_at)}
          </span>
        </div>
        <div className={styles.fullWidth}>
          <span className={`note ${styles.label}`}>Event Period:</span>
          <span className={styles.value}>
            {formatDateTime(booking.start_at)} – {formatDateTime(booking.end_at)}
          </span>
        </div>
        {(booking.setup_buffer_minutes > 0 ||
          booking.teardown_buffer_minutes > 0) && (
          <div className={styles.fullWidth}>
            <span className={`note ${styles.label}`}>Operational Buffers:</span>
            <span className={styles.value}>
              {booking.setup_buffer_minutes}m setup ·{' '}
              {booking.teardown_buffer_minutes}m teardown
            </span>
          </div>
        )}
      </div>

      {booking.status === 'REJECTED' && booking.rejection_reason && (
        <div className={`form-error ${styles.rejectionError}`}>
          <strong>Rejection Reason:</strong> {booking.rejection_reason}
        </div>
      )}

      {actions && <div className={`form-actions ${styles.actions}`}>{actions}</div>}
    </div>
  )
}