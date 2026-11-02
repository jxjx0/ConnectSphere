import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import AppShell from '../components/AppShell'
import VenueBookingCard from '../components/VenueBookingCard'
import VenueScheduleCalendar from '../components/VenueScheduleCalendar'
import { useAuth } from '../context/AuthContext'
import { getPendingVenueBookings, reviewVenueBooking } from '../api/venues'
import styles from '../styles/ReviewVenueRequestsPage.module.css'

const REQUESTS_PER_PAGE = 8

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
    // Checked against the booking's own session (T7-278); bookings from
    // before sessions fall back to the event's attendance.
    const attendance = booking.session?.expected_attendance
        || booking.events?.expected_attendance || booking.expected_attendance || 0

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
    const [reviewMessage, setReviewMessage] = useState('')
    const [query = '', setQuery] = useState('')
    const [page = 1, setPage] = useState(1)

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

    const filteredBookings = bookings.filter(booking => [booking.events?.name, booking.session?.name, booking.venues?.name, booking.room_layout]
        .filter(Boolean).join(' ').toLowerCase().includes(query.trim().toLowerCase()))
    const pageCount = Math.max(1, Math.ceil(filteredBookings.length / REQUESTS_PER_PAGE))
    const currentPage = Math.min(page, pageCount)
    const pageStart = (currentPage - 1) * REQUESTS_PER_PAGE
    const pagedBookings = filteredBookings.slice(pageStart, pageStart + REQUESTS_PER_PAGE)
    const selectedBooking = pagedBookings.find((b) => b.booking_id === selectedBookingId) || pagedBookings[0]
    const id = selectedBooking?.booking_id
    const isProcessing = processingId === id
    const isRejecting = rejectingId === id
    const validationError = selectedBooking ? validateBookingRequest(selectedBooking) : null

    // Formats start date into YYYY-MM-DD in local timezone for VenueScheduleCalendar focus
    const selectedBookingDate = selectedBooking?.start_at
        ? new Date(selectedBooking.start_at).toLocaleDateString('sv-SE')
        : null

    function clearSearch() {
        setQuery('')
        setPage(1)
        setSelectedBookingId(null)
    }

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
            setReviewMessage(`Booking request for ${booking.venues?.name || 'this venue'} approved.`)

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
            setReviewMessage('Booking request rejected. Your reason has been saved.')

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
                    <Link to="/dashboard" className="venue-search__back" aria-label="Back to Dashboard">
                        ← Back
                    </Link>
                    <h1>Review Venue Requests</h1>
                </div>

                {reviewMessage && <p className="form-success" role="status">{reviewMessage}</p>}
                {loading && <p className="venue-workspace__state" role="status">Loading pending requests…</p>}
                {error && <p className="form-error" role="alert">{error}</p>}

                {!loading && !error && bookings.length === 0 && (
                    <div className="venue-workspace__state" role="status">
                        <h2>No pending requests</h2>
                        <p>There are no venue booking requests waiting for your review.</p>
                        <Link to="/venues/availability">View venue availability</Link>
                    </div>
                )}

                {!loading && !error && bookings.length > 0 && (
                    <>
                    <div className="attendee-list-tools attendee-list-tools--search-only">
                        <div className="field">
                            <label htmlFor="request-search">Search booking requests</label>
                            <input id="request-search" type="search" placeholder="Search by event, session, venue or layout"
                                value={query} onChange={event => { setQuery(event.target.value); setPage(1); setSelectedBookingId(null) }} />
                        </div>
                        <p className="note attendee-result-count" role="status">
                            {query.trim() ? `${filteredBookings.length} of ${bookings.length}` : bookings.length} {bookings.length === 1 ? 'request' : 'requests'}
                        </p>
                        {query && <button type="button" className="attendee-text-button" onClick={clearSearch}>Clear search</button>}
                    </div>
                    <div className={styles.splitLayout}>
                        <section className={styles.queue} aria-labelledby="pending-requests-title">
                            <div className={styles.queueHeading}>
                                <h2 id="pending-requests-title">Pending requests</h2>
                                <span className="tag">{filteredBookings.length}</span>
                            </div>
                            <ul className={styles.cardsList}>
                                {pagedBookings.map((booking) => (
                                    <li key={booking.booking_id}>
                                        <a href="#venue-request-detail"
                                            className={`${styles.queueItem} ${selectedBooking?.booking_id === booking.booking_id ? styles.selectedCard : ''}`}
                                            aria-current={selectedBooking?.booking_id === booking.booking_id ? 'true' : undefined}
                                            onClick={() => setSelectedBookingId(booking.booking_id)}>
                                            <strong>{booking.events?.name || 'Venue booking request'}</strong>
                                            <span>{booking.venues?.name || `Venue ID: ${booking.venue_id}`}</span>
                                            {booking.session?.name && <span className="note">{booking.session.name}</span>}
                                            <span className="note">{new Date(booking.start_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} · {booking.room_layout}</span>
                                            <span className={styles.queueHint}>{selectedBooking?.booking_id === booking.booking_id ? 'Currently reviewing' : 'Review request →'}</span>
                                        </a>
                                    </li>
                                ))}
                            </ul>
                            {filteredBookings.length > 0 && <nav className="venue-list-pagination venue-list-pagination--queue" aria-label="Booking request pages">
                                <p className="note" role="status">Showing {pageStart + 1}–{Math.min(pageStart + REQUESTS_PER_PAGE, filteredBookings.length)} of {filteredBookings.length} requests</p>
                                {pageCount > 1 && <div className="venue-list-pagination__controls">
                                    <button type="button" className="button button--secondary button--small" disabled={currentPage === 1}
                                        onClick={() => { setPage(currentPage - 1); setSelectedBookingId(null) }}>Previous</button>
                                    <span className="note">Page {currentPage} of {pageCount}</span>
                                    <button type="button" className="button button--secondary button--small" disabled={currentPage === pageCount}
                                        onClick={() => { setPage(currentPage + 1); setSelectedBookingId(null) }}>Next</button>
                                </div>}
                            </nav>}
                        </section>
                        {!selectedBooking && <section className={styles.calendarPanel}>
                            <h2>No matching requests</h2>
                            <p className="note">Try another event, session, venue or layout name.</p>
                        </section>}
                        {selectedBooking && <div className={styles.reviewDetail}>
                            <section id="venue-request-detail" className={styles.requestPanel} aria-labelledby="selected-request-title">
                                <header className={styles.requestHeading}>
                                    <span className="attendee-category">Booking review</span>
                                    <h2 id="selected-request-title">{selectedBooking.events?.name || 'Venue booking request'}</h2>
                                </header>
                                <VenueBookingCard booking={selectedBooking} validationError={validationError} />
                            </section>
                            <section id="request-venue-calendar" className={styles.calendarPanel} aria-labelledby="request-calendar-title">
                                <div className={styles.calendarHeader}>
                                    <div>
                                        <h2 id="request-calendar-title">Venue schedule</h2>
                                        <p className="note">{selectedBooking.venues?.name || `Venue ID: ${selectedBooking.venue_id}`}</p>
                                    </div>
                                </div>
                                <VenueScheduleCalendar key={selectedBooking.booking_id} venueId={selectedBooking.venue_id}
                                    operatingHours={selectedBooking.venues?.operating_hours}
                                    initialDate={selectedBookingDate} token={token} request={selectedBooking} />
                            </section>
                            <section className={styles.decisionPanel} aria-label="Booking decision">
                                <h2>Your decision</h2>
                                {actionError[id] && (
                                    <p className="form-error" role="alert" style={{ marginBottom: 'var(--space-2)' }}>
                                        {actionError[id]}
                                    </p>
                                )}

                                {!isRejecting ? (
                                    <div className="form-actions">
                                        <button
                                            type="button"
                                            className="button"
                                            onClick={() => handleApprove(selectedBooking)}
                                            disabled={isProcessing || Boolean(validationError)}
                                            title={validationError || undefined}
                                        >
                                            {isProcessing ? 'Saving…' : 'Approve'}
                                        </button>
                                        <button
                                            type="button"
                                            className="button button--danger"
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
                                            <button className="button button--danger" disabled={isProcessing}>
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
                            </section>
                        </div>}
                    </div>
                    </>
                )}
            </div>
        </AppShell>
    )
}
