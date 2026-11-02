import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

import { getAllEquipmentBookings, getEquipmentRequests } from '../api/equipmentRequests'
import TechSupportShell from '../components/TechSupportShell'
import EquipmentMonthCalendar, { stepMonth } from '../components/EquipmentMonthCalendar'
import { useAuth } from '../context/AuthContext'
import { monthRange } from '../equipmentCalendar'
import { statusTagClass } from '../equipmentCatalogue'
import { formatDateRange } from '../eventDisplay'
import styles from '../styles/TechSupport.module.css'

export default function EquipmentBookingCalendarPage() {
  const { token } = useAuth()
  const today = new Date()
  const [month, setMonth] = useState({ year: today.getFullYear(), month: today.getMonth() })
  const [bookings, setBookings] = useState([])
  const [requests, setRequests] = useState([])
  const [selectedBooking, setSelectedBooking] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const loadBookings = useCallback(() => {
    const { from, to } = monthRange(month.year, month.month)
    setError('')
    setLoading(true)
    return getAllEquipmentBookings(from, to, token)
      .then((result) => setBookings(result.bookings))
      .catch((caught) => setError(caught.message))
      .finally(() => setLoading(false))
  }, [month, token])

  useEffect(() => {
    loadBookings()
  }, [loadBookings])

  // Only adds the session and Organiser to a booking's details, so the
  // calendar still works without it.
  useEffect(() => {
    getEquipmentRequests(token)
      .then((data) => setRequests(data.requests))
      .catch(() => setRequests([]))
  }, [token])

  const selectedRequest = requests.find((request) => request.id === selectedBooking?.request_id)

  return (
    <TechSupportShell>
      <div className={styles.page}>
        <div className="content__header">
          <h1>Shared Equipment Bookings</h1>
          <p className="lead">Reservations across all equipment. Select one to see what was booked.</p>
        </div>

        {error && <p className="form-error" role="alert">{error}</p>}
        {loading && <p className="page-state">Loading shared bookings…</p>}

        <EquipmentMonthCalendar
          title="Shared equipment bookings"
          year={month.year}
          month={month.month}
          bookings={bookings}
          describe={(booking) => `${booking.equipment_name} · ${booking.event_name}`}
          onChangeMonth={(step) => {
            setSelectedBooking(null)
            setMonth((current) => stepMonth(current, step))
          }}
          onSelect={setSelectedBooking}
          selectedId={selectedBooking?.id}
        />

        {selectedBooking ? (
          <article className={styles.card} aria-live="polite">
            <div className={styles.cardHeader}>
              <strong className={styles.cardTitle}>{selectedBooking.event_name}</strong>
              <span className={statusTagClass(selectedBooking.request_status)}>{selectedBooking.request_status}</span>
            </div>
            <dl className={styles.details}>
              <div>
                <dt>Equipment</dt>
                <dd>
                  {selectedBooking.equipment_name}
                  {selectedBooking.equipment_type
                    && selectedBooking.equipment_type !== selectedBooking.equipment_name
                    && ` · ${selectedBooking.equipment_type}`}
                </dd>
              </div>
              {selectedRequest?.session && (
                <div>
                  <dt>Session</dt>
                  <dd>{selectedRequest.session.name}</dd>
                </div>
              )}
              {selectedRequest && (
                <div>
                  <dt>Organiser</dt>
                  <dd>{selectedRequest.event?.organiser_name || 'Unknown'}</dd>
                </div>
              )}
              <div className={styles.fullWidth}>
                <dt>Reserved</dt>
                <dd>{formatDateRange(selectedBooking.start_at, selectedBooking.end_at)}</dd>
              </div>
              <div className={styles.fullWidth}>
                <dt>Equipment ID</dt>
                <dd className={styles.equipmentId}>{selectedBooking.equipment_id}</dd>
              </div>
            </dl>
            <div className="form-actions">
              <Link
                to={`/equipment/${selectedBooking.equipment_id}/bookings`}
                className="button button--secondary button--small"
              >
                View this equipment's bookings
              </Link>
            </div>
          </article>
        ) : (
          !loading && !error && (
            <p className="note">
              {bookings.length === 0
                ? 'No equipment is reserved this month.'
                : 'Select a reservation on the calendar to see its details.'}
            </p>
          )
        )}
      </div>
    </TechSupportShell>
  )
}
