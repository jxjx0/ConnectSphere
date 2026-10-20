import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import AppShell from '../components/AppShell'
import VenueBookingCard from '../components/VenueBookingCard'
import VenueScheduleCalendar from '../components/VenueScheduleCalendar'
import { useAuth } from '../context/AuthContext'
import { getPendingVenueBookings, getVenueAvailability, reviewVenueBooking } from '../api/venues'
import styles from '../styles/ReviewVenueRequestsPage.module.css'

/**
 * Checks whether two time ranges overlap.
 */
export function isOverlapping(startA, endA, startB, endB) {
    return new Date(startA) < new Date(endB) && new Date(endA) > new Date(startB)
}

/**
 * Validates layout support, capacity limits, and operating hours against venue profile.
 */
export function validateBookingRequest(booking) {
    const venue = booking?.venues
    if (!venue) return null

    // Venue hours are Singapore wall-clock times; stored booking timestamps are UTC.
    const operatingHours = venue.operating_hours
    if (operatingHours && typeof operatingHours === 'object') {
        const { open, close } = operatingHours
        const validTime = value => typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)
        // Match the backend: unreadable stored hours do not impose an invented restriction.
        if (validTime(open) && validTime(close) && open < close && booking.start_at && booking.end_at) {
            const setup = Math.max(venue.setup_time_minutes ?? 0, booking.setup_buffer_minutes ?? 0)
            const turnaround = Math.max(venue.turnaround_time_minutes ?? 0, booking.teardown_buffer_minutes ?? 0)
            // Current buffers are a floor; keep any larger stored reservation, as approval does.
            const start = Math.min(Date.parse(booking.start_at) - setup * 60000,
                booking.effective_start_at ? Date.parse(booking.effective_start_at) : Infinity)
            const end = Math.max(Date.parse(booking.end_at) + turnaround * 60000,
                booking.effective_end_at ? Date.parse(booking.effective_end_at) : -Infinity)
            if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
                return 'Unable to verify the occupied booking period. Please refresh and check the booking.'
            }
            const singaporeStart = new Date(start + 8 * 3600000).toISOString()
            const singaporeEnd = new Date(end + 8 * 3600000).toISOString()
            const date = singaporeStart.slice(0, 10)
            const opensAt = Date.parse(`${date}T${open}:00+08:00`)
            const closesAt = Date.parse(`${date}T${close}:00+08:00`)
            if (start < opensAt || end > closesAt) {
                return `Occupied period (${singaporeStart.slice(11, 16)} – ${singaporeEnd.slice(11, 16)} Singapore time), including setup and turnaround, falls outside venue operating hours (${open} – ${close}).`
            }
        }
    }

    // 2. Standardize layouts array regardless of whether DB returns Array or Object dictionary
    let supportedLayouts = []
    if (Array.isArray(venue.layouts)) {
        supportedLayouts = venue.layouts
    } else if (venue.layouts && typeof venue.layouts === 'object') {
        supportedLayouts = Object.entries(venue.layouts).map(([name, capacity]) => ({
            name,
            capacity,
        }))
    }

    const requestedLayoutName = booking.room_layout
    const attendance = booking.events?.expected_attendance || booking.expected_attendance || 0

    // Case-insensitive match on layout name
    const layoutMatch = supportedLayouts.find(
        (l) => l.name?.trim().toLowerCase() === requestedLayoutName?.trim().toLowerCase()
    )

    if (!layoutMatch) {
        return `The venue does not support the requested layout '${requestedLayoutName}'.`
    }

    const maxCapacity = layoutMatch.capacity || 0
    if (attendance > maxCapacity) {
        return `Expected attendance (${attendance}) exceeds maximum capacity (${maxCapacity}) for layout '${requestedLayoutName}'.`
    }

    return null
}

export default function ReviewVenueRequests() {
    const { token } = useAuth()
    const [bookings, setBookings] = useState([])
    const [selectedBookingId, setSelectedBookingId] = useState(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState('')
    const [actionError, setActionError] = useState({})
    const [processingId, setProcessingId] = useState(null)
    const [rejectionReasons, setRejectionReasons] = useState({})
    const [rejectingId, setRejectingId] = useState(null)

    useEffect(() => {
        let active = true
        getPendingVenueBookings(token)
            .then((data) => {
                if (!active) return
                const list = data.bookings || []
                setBookings(list)
                if (list.length > 0) {
                    setSelectedBookingId(list[0].booking_id)
                }
            })
            .catch((caught) => {
                if (active) setError(caught.message)
            })
            .finally(() => {
                if (active) setLoading(false)
            })
        return () => {
            active = false
        }
    }, [token])

    const selectedBooking = bookings.find((b) => b.booking_id === selectedBookingId)

    // Formats start date into YYYY-MM-DD in local timezone for VenueScheduleCalendar focus
    const selectedBookingDate = selectedBooking?.start_at
        ? new Date(selectedBooking.start_at).toLocaleDateString('sv-SE')
        : null

    async function handleApprove(booking) {
        const bookingId = booking.booking_id
        setActionError((prev) => ({ ...prev, [bookingId]: '' }))

        const confirmApprove = window.confirm(
            `Are you sure you want to approve this venue booking request for ${booking.venues?.name || 'this venue'}?`
        )
        if (!confirmApprove) return

        setProcessingId(bookingId)

        try {
            await reviewVenueBooking(bookingId, { status: 'APPROVED' }, token)

            setBookings((prev) => {
                const next = prev.filter((b) => b.booking_id !== bookingId)
                if (selectedBookingId === bookingId) {
                    setSelectedBookingId(next[0]?.booking_id || null)
                }
                return next
            })
        } catch (caught) {
            setActionError((prev) => ({ ...prev, [bookingId]: caught.message }))
        } finally {
            setProcessingId(null)
        }
    }

    async function handleRejectSubmit(e, bookingId) {
        e.preventDefault()
        const reason = rejectionReasons[bookingId]?.trim()

        if (!reason) {
            setActionError((prev) => ({
                ...prev,
                [bookingId]: 'Please provide a reason for rejection.',
            }))
            return
        }

        setProcessingId(bookingId)
        setActionError((prev) => ({ ...prev, [bookingId]: '' }))

        try {
            await reviewVenueBooking(
                bookingId,
                { status: 'REJECTED', rejection_reason: reason },
                token
            )

            setBookings((prev) => {
                const next = prev.filter((b) => b.booking_id !== bookingId)
                if (selectedBookingId === bookingId) {
                    setSelectedBookingId(next[0]?.booking_id || null)
                }
                return next
            })
            setRejectingId(null)
        } catch (caught) {
            setActionError((prev) => ({ ...prev, [bookingId]: caught.message }))
        } finally {
            setProcessingId(null)
        }
    }

    return (
        <AppShell>
            <div className={styles.container}>
                <div className="content__header venue-search__header">
                    <Link to="/dashboard" className="venue-search__back">
                        ← Back to Dashboard
                    </Link>
                    <h1>Review Venue Requests</h1>
                    <p className="lead">Select a venue booking request to review its full schedule and availability grid.</p>
                </div>

                <section className="stack stack--tight">
                    <h2 className="section-title">Venue Requests</h2>
                </section>

                {loading && <p className="page-state">Loading pending requests…</p>}
                {error && <p className="form-error">{error}</p>}

                {!loading && !error && bookings.length === 0 && (
                    <p className="note">No pending venue booking requests to review.</p>
                )}

                {!loading && !error && bookings.length > 0 && (
                    <div className={styles.splitLayout}>
                        {/* Selectable Requests List */}
                        <section className={styles.cardsSection}>
                            <h2 className="section-title">Pending Requests ({bookings.length})</h2>
                            <ul className={styles.cardsList}>
                                {bookings.map((booking) => {
                                    const id = booking.booking_id
                                    const isSelected = selectedBookingId === id
                                    const isProcessing = processingId === id
                                    const isRejecting = rejectingId === id
                                    const validationError = validateBookingRequest(booking)

                                    return (
                                        <li
                                            key={id}
                                            tabIndex={0}
                                            onClick={() => setSelectedBookingId(id)}
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter' || e.key === ' ') {
                                                    e.preventDefault()
                                                    setSelectedBookingId(id)
                                                }
                                            }}
                                            className={`${styles.selectableCard} ${isSelected ? styles.selectedCard : ''}`}
                                        >
                                            <VenueBookingCard
                                                booking={booking}
                                                validationError={validationError}
                                                actions={
                                                    <div style={{ width: '100%' }} onClick={(e) => e.stopPropagation()}>
                                                        {actionError[id] && (
                                                            <p className="form-error" style={{ marginBottom: 'var(--space-2)' }}>
                                                                {actionError[id]}
                                                            </p>
                                                        )}

                                                        {!isRejecting ? (
                                                            <div className="form-actions">
                                                                <button
                                                                    type="button"
                                                                    className="button"
                                                                    onClick={() => handleApprove(booking)}
                                                                    disabled={isProcessing || Boolean(validationError)}
                                                                    title={validationError || undefined}
                                                                >
                                                                    {isProcessing ? 'Saving…' : 'Approve'}
                                                                </button>
                                                                <button
                                                                    type="button"
                                                                    className="button button--secondary"
                                                                    onClick={() => {
                                                                        setRejectingId(id)
                                                                        setActionError((prev) => ({ ...prev, [id]: '' }))
                                                                    }}
                                                                    disabled={isProcessing}
                                                                >
                                                                    Reject
                                                                </button>
                                                            </div>
                                                        ) : (
                                                            <form onSubmit={(e) => handleRejectSubmit(e, id)} className="stack stack--tight">
                                                                <label className="field">
                                                                    <span className="field__label">Reason for Rejection</span>
                                                                    <textarea
                                                                        value={rejectionReasons[id] || ''}
                                                                        onChange={(e) =>
                                                                            setRejectionReasons((prev) => ({
                                                                                ...prev,
                                                                                [id]: e.target.value,
                                                                            }))
                                                                        }
                                                                        placeholder="Enter rejection reason..."
                                                                        rows={2}
                                                                        required
                                                                        autoFocus
                                                                    />
                                                                </label>
                                                                <div className="form-actions">
                                                                    <button className="button" disabled={isProcessing}>
                                                                        {isProcessing ? 'Submitting…' : 'Confirm Rejection'}
                                                                    </button>
                                                                    <button
                                                                        type="button"
                                                                        className="button button--secondary"
                                                                        disabled={isProcessing}
                                                                        onClick={() => setRejectingId(null)}
                                                                    >
                                                                        Cancel
                                                                    </button>
                                                                </div>
                                                            </form>
                                                        )}
                                                    </div>
                                                }
                                            />
                                        </li>
                                    )
                                })}
                            </ul>
                        </section>

                        {/* Sticky Venue Calendar Column */}
                        <aside className={styles.calendarPanel}>
                            <div className={styles.calendarHeader}>
                                <div>
                                    <h2 className="section-title" style={{ border: 0, padding: 0 }}>
                                        Venue Calendar
                                    </h2>
                                    <strong style={{ fontSize: '1.0625rem', color: 'var(--ink)' }}>
                                        {selectedBooking?.venues?.name || `Venue ID: ${selectedBooking?.venue_id}`}
                                    </strong>
                                </div>
                            </div>
                            {selectedBooking ? (
                                <VenueScheduleCalendar
                                    venueId={selectedBooking.venue_id}
                                    operatingHours={selectedBooking.venues?.operating_hours}
                                    initialDate={selectedBookingDate}
                                    token={token}
                                />
                            ) : (
                                <p className="note">Select a request card to load its schedule calendar.</p>
                            )}
                        </aside>
                    </div>
                )}
            </div>
        </AppShell>
    )
}
