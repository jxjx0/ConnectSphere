import React from 'react'
import { formatDateTime, readableStatus } from '../eventDisplay'
import styles from './VenueBookingCard.module.css'

function getStatusClass(status) {
  switch (status) {
    case 'APPROVED':
      return styles.approved
    case 'PENDING_VENUE_APPROVAL':
      return styles.pending
    case 'AFFECTED_BY_UNAVAILABILITY':
    case 'REJECTED':
      return styles.rejected
    default:
      return styles.defaultStatus
  }
}

export default function VenueBookingCard({ booking, validationError, actions }) {
  if (!booking) return null

  const statusClass = getStatusClass(booking.status)
  // A venue is checked against its own session's attendance (T7-278);
  // bookings from before sessions fall back to the event's.
  const attendance = booking.session?.expected_attendance
    || booking.events?.expected_attendance || booking.expected_attendance

  return (
    <div className={`${styles.card} ${statusClass}`}>
      <div className={styles.header}>
        <strong className={styles.venueName}>
          {booking.venues?.name || `Venue ID: ${booking.venue_id}`}
        </strong>
        <span className="tag">{readableStatus(booking.status)}</span>
      </div>

      <div className={styles.grid}>
        {booking.session?.name && (
          <div>
            <span className={`note ${styles.label}`}>Session:</span>
            <span className={styles.value}>{booking.session.name}</span>
          </div>
        )}
        <div>
          <span className={`note ${styles.label}`}>Requested Layout:</span>
          <span className={styles.value}>{booking.room_layout}</span>
        </div>
        {attendance && (
          <div>
            <span className={`note ${styles.label}`}>Expected Attendance:</span>
            <span className={styles.value}>{attendance} people</span>
          </div>
        )}
        <div>
          <span className={`note ${styles.label}`}>Submitted On:</span>
          <span className={styles.value}>{formatDateTime(booking.created_at)}</span>
        </div>
        <div className={styles.fullWidth}>
          <span className={`note ${styles.label}`}>Event Period:</span>
          <span className={styles.value}>
            {formatDateTime(booking.start_at)} – {formatDateTime(booking.end_at)}
          </span>
        </div>
        {(booking.setup_buffer_minutes > 0 || booking.teardown_buffer_minutes > 0) && (
          <div className={styles.fullWidth}>
            <span className={`note ${styles.label}`}>Operational Buffers:</span>
            <span className={styles.value}>
              {booking.setup_buffer_minutes}m setup · {booking.teardown_buffer_minutes}m turnaround
            </span>
          </div>
        )}
      </div>

      {booking.status === 'AFFECTED_BY_UNAVAILABILITY' && (
        <p className="form-error" role="status">
          Originally approved. Venue now unavailable. Please arrange another venue.
        </p>
      )}

      {/* Validation Failure Banner */}
      {validationError && (
        <div className={`form-error ${styles.rejectionError}`}>
          <strong>Validation Issue:</strong> {validationError}
        </div>
      )}

      {booking.status === 'REJECTED' && booking.rejection_reason && (
        <div className={`form-error ${styles.rejectionError}`}>
          <strong>Rejection Reason:</strong> {booking.rejection_reason}
        </div>
      )}

      {booking.status === 'CANCELLED' && booking.cancellation_reason && (
        <p className={`note ${styles.rejectionError}`}>
          <strong>Cancellation reason:</strong> {booking.cancellation_reason}
        </p>
      )}

      {actions && <div className={`form-actions ${styles.actions}`}>{actions}</div>}
    </div>
  )
}
