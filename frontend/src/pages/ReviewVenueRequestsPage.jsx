import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import AppShell from '../components/AppShell'
import VenueBookingCard from '../components/VenueBookingCard'
import VenueScheduleCalendar from '../components/VenueScheduleCalendar'
import { useAuth } from '../context/AuthContext'
import { getPendingVenueBookings, getVenueAvailability, reviewVenueBooking } from '../api/venues'
import styles from '../styles/ReviewVenueRequestsPage.module.css'

/*** Checks whether two time ranges overlap.*/
function isOverlapping(startA, endA, startB, endB) {
    return new Date(startA) < new Date(endB) && new Date(endA) > new Date(startB)
}

/*** Validates layout support and capacity limits against venue profile.*/
function validateBookingRequest(booking) {
    const venue = booking?.venues
    if (!venue) return null

    // venue.layouts is an array of objects: [{ name: "Banquet", capacity: 100 }, ...]
    const supportedLayouts = Array.isArray(venue.layouts) ? venue.layouts : []
    const requestedLayoutName = booking.room_layout
    const attendance = booking.events?.expected_attendance || booking.expected_attendance || 0

    // Find layout match (case-insensitive trim)
    const layoutMatch = supportedLayouts.find(
        (l) => l.name?.trim().toLowerCase() === requestedLayoutName?.trim().toLowerCase()
    )

    if (!layoutMatch) {
        return `The venue does not support the requested layout '${requestedLayoutName}'.`
    }

    if (attendance > layoutMatch.capacity) {
        return `Expected attendance (${attendance}) exceeds maximum capacity (${layoutMatch.capacity}) for layout '${requestedLayoutName}'.`
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

    // Formats start date into YYYY-MM-DD for VenueScheduleCalendar initial focus
    const selectedBookingDate = selectedBooking?.start_at
        ? new Date(selectedBooking.start_at).toISOString().split('T')[0]
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
            const startWindow = booking.effective_start_at || booking.start_at
            const endWindow = booking.effective_end_at || booking.end_at

            const availability = await getVenueAvailability(
                booking.venue_id,
                { start_at: startWindow, end_at: endWindow },
                token
            )
            const existingBlocks = availability?.items || []

            const conflict = existingBlocks.find((block) =>
                isOverlapping(startWindow, endWindow, block.start_at, block.end_at)
            )

            if (conflict) {
                const conflictStart = new Date(conflict.start_at).toLocaleString()
                const conflictEnd = new Date(conflict.end_at).toLocaleString()
                const conflictName = conflict.reason || conflict.block_reason || 'Existing Reservation'

                throw new Error(
                    `Cannot approve: Overlaps with '${conflictName}' from ${conflictStart} to ${conflictEnd}.`
                )
            }

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
                                            role="button"
                                            aria-pressed={isSelected}
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
                                    key={`${selectedBooking.venue_id}-${selectedBookingDate}`}
                                    venueId={selectedBooking.venue_id}
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