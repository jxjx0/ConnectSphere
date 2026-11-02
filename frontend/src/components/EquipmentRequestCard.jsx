import React from 'react'
import { lineProgress } from '../equipmentCatalogue'
import { formatDateRange, formatDateTime } from '../eventDisplay'
import styles from './VenueBookingCard.module.css'

// Laid out like VenueBookingCard, so a session's venue and equipment read
// the same way: the colour and tag show the status, then the details.
function getStatusClass(status) {
  switch (status) {
    case 'Approved':
      return styles.approved
    case 'Pending Technical Approval':
      return styles.pending
    case 'Rejected':
    case 'Affected by Session Change':
      return styles.rejected
    default:
      return styles.defaultStatus
  }
}

// One session's equipment request. Without a request, it shows what the
// Organiser asked for instead, and `actions` can offer to request it.
export default function EquipmentRequestCard({ title, eventName, request, timing, needs, actions }) {
  const allocated = request?.equipment_bookings || []
  const lines = lineProgress(request)

  return (
    <div className={`${styles.card} ${getStatusClass(request?.status)}`}>
      <div className={styles.header}>
        <strong className={styles.venueName}>{title}</strong>
        <span className="tag">{request ? request.status : 'Not requested'}</span>
      </div>

      <div className={styles.grid}>
        {eventName && (
          <div>
            <span className={`note ${styles.label}`}>Event:</span>
            <span className={styles.value}>{eventName}</span>
          </div>
        )}
        {request && (
          <div>
            <span className={`note ${styles.label}`}>Submitted On:</span>
            <span className={styles.value}>{formatDateTime(request.created_at)}</span>
          </div>
        )}
        <div className={styles.fullWidth}>
          <span className={`note ${styles.label}`}>Needed For:</span>
          <span className={styles.value}>
            {formatDateRange(timing?.start_time, timing?.end_time)}
          </span>
        </div>
        <div className={styles.fullWidth}>
          <span className={`note ${styles.label}`}>
            {request ? 'Requested Equipment:' : "Organiser's Equipment Needs:"}
          </span>
          {lines.length > 0 ? lines.map((line) => (
            <span className={styles.value} style={{ display: 'block' }} key={line.id}>
              {line.item_name}: {line.allocated}/{line.quantity} allocated
              {line.specifics && ` · ${line.specifics}`}
            </span>
          )) : (
            <span className={styles.value}>
              {request
                ? request.request_details
                : needs?.trim() || 'None listed. A request is optional.'}
            </span>
          )}
        </div>
        {request && (
          <div className={styles.fullWidth}>
            <span className={`note ${styles.label}`}>Allocated:</span>
            <span className={styles.value}>
              {allocated.length > 0
                ? allocated.map((booking) => booking.equipment?.name || 'Equipment').join(', ')
                : 'Nothing allocated yet.'}
            </span>
          </div>
        )}
      </div>

      {request?.status === 'Affected by Session Change' && (
        <p className="form-error" role="status">
          Its session was moved or removed by an approved change request.
          Cancel this request and request equipment again.
        </p>
      )}

      {request?.status === 'Cancelled' && request.cancellation_reason && (
        <p className={`note ${styles.rejectionError}`}>
          <strong>Cancellation reason:</strong> {request.cancellation_reason}
        </p>
      )}

      {request?.status === 'Pending Technical Approval' && (
        <p className={`note ${styles.rejectionError}`}>
          Technical Support is checking availability and allocating suitable equipment.
        </p>
      )}

      {actions && <div className={`form-actions ${styles.actions}`}>{actions}</div>}
    </div>
  )
}
