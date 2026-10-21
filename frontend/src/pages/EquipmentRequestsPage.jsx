import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import {
  getEquipmentRequests,
  getEventEquipmentRequests,
  reviewEquipmentRequest,
  submitEquipmentRequest,
} from '../api/equipmentRequests'
import { getAssignedEventRequests } from '../api/events'
import AppShell from '../components/AppShell'
import EquipmentRequestCard from '../components/EquipmentRequestCard'
import { useAuth } from '../context/AuthContext'
import { formatDateRange } from '../eventDisplay'
import {
  equipmentRequestEligibleEvents,
  sessionsWithoutEquipmentRequest,
} from '../equipmentRequestEligibility'

export default function EquipmentRequestsPage() {
  const { token, user } = useAuth()
  const [searchParams] = useSearchParams()
  const requestedEventId = searchParams.get('eventId') || ''
  const requestedSessionId = searchParams.get('sessionId') || ''
  const isCoordinator = user.role === 'coordinator'
  const [events, setEvents] = useState([])
  const [requests, setRequests] = useState([])
  const [eventId, setEventId] = useState(requestedEventId)
  const [sessionId, setSessionId] = useState('')
  const [requestDetails, setRequestDetails] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [submittedMessage, setSubmittedMessage] = useState('')
  const [reviewingRequestId, setReviewingRequestId] = useState('')
  const [reviewErrors, setReviewErrors] = useState({})
  const isTechSupport = user.role === 'tech_support'

  // Opened from one event's page, the Coordinator sees only that event's
  // requests; otherwise every request they can see.
  const loadRequests = useCallback(() => (
    isCoordinator && requestedEventId
      ? getEventEquipmentRequests(requestedEventId, token)
      : getEquipmentRequests(token)
  ), [isCoordinator, requestedEventId, token])

  useEffect(() => {
    const loads = [
      loadRequests(),
      ...(isCoordinator ? [getAssignedEventRequests(token)] : []),
    ]

    Promise.all(loads)
      .then(([requestData, eventData]) => {
        setRequests(requestData.requests)
        if (isCoordinator) {
          setEvents(equipmentRequestEligibleEvents(eventData.events))
        }
      })
      .catch((caught) => setError(caught.message))
      .finally(() => setLoading(false))
  }, [isCoordinator, loadRequests, token])

  // Events with at least one session still without a request. Requests only
  // holds one event's requests when the page is opened for that event, which
  // is then the only event that matters.
  const openEvents = useMemo(
    () => events.filter((eventItem) => (
      sessionsWithoutEquipmentRequest(eventItem, requests).length > 0
    )),
    [events, requests],
  )
  const selectedEvent = useMemo(
    () => openEvents.find((eventItem) => eventItem.id === eventId),
    [eventId, openEvents],
  )
  const openSessions = useMemo(
    () => (selectedEvent ? sessionsWithoutEquipmentRequest(selectedEvent, requests) : []),
    [requests, selectedEvent],
  )
  const selectedSession = openSessions.find((session) => session.id === sessionId)
  const requestedEvent = events.find((eventItem) => eventItem.id === requestedEventId)

  // Pick a session for the chosen event: the one asked for in the link, or
  // the only one left. Its equipment needs fill in the description.
  useEffect(() => {
    if (!selectedEvent || openSessions.some((session) => session.id === sessionId)) return
    const next = openSessions.find((session) => session.id === requestedSessionId)
      || (openSessions.length === 1 ? openSessions[0] : null)
    setSessionId(next?.id || '')
    setRequestDetails(next?.equipment_requirements || '')
  }, [openSessions, requestedSessionId, selectedEvent, sessionId])

  function chooseSession(nextSessionId) {
    setSessionId(nextSessionId)
    const nextSession = openSessions.find((session) => session.id === nextSessionId)
    setRequestDetails(nextSession?.equipment_requirements || '')
  }

  async function handleSubmit(event) {
    event.preventDefault()
    setError('')
    setSubmittedMessage('')

    if (!eventId) {
      setError('Select an assigned event.')
      return
    }
    if (!sessionId) {
      setError('Select the session this equipment is for.')
      return
    }
    if (!requestDetails.trim()) {
      setError('Describe the equipment needed for this session.')
      return
    }

    setSubmitting(true)
    try {
      const data = await submitEquipmentRequest({
        event_id: eventId,
        session_id: sessionId,
        request_details: requestDetails.trim(),
        items: [],
      }, token)
      const submittedRequest = {
        ...data.request,
        event: selectedEvent,
        session: selectedSession,
        items: [],
      }
      setRequests((current) => [submittedRequest, ...current])
      setSessionId('')
      setRequestDetails('')
      if (!requestedEventId) setEventId('')
      setSubmittedMessage(
        `Equipment request for ${selectedSession?.name || 'the session'} submitted for technical approval.`,
      )
    } catch (caught) {
      setError(caught.message)
    } finally {
      setSubmitting(false)
    }
  }

  async function handleReview(requestId, decision) {
    setReviewingRequestId(requestId)
    setReviewErrors((current) => ({ ...current, [requestId]: '' }))
    try {
      const result = await reviewEquipmentRequest(requestId, decision, token)
      setRequests((current) => current.map((request) => (
        request.id === requestId
          ? { ...request, ...result.request }
          : request
      )))
      try {
        const refreshed = await getEquipmentRequests(token)
        setRequests(refreshed.requests)
      } catch (refreshError) {
        setReviewErrors((current) => ({
          ...current,
          [requestId]: `${decision} was saved, but the queue could not refresh: ${refreshError.message}`,
        }))
      }
    } catch (caught) {
      setReviewErrors((current) => ({ ...current, [requestId]: caught.message }))
      if (caught.status === 409) {
        try {
          const refreshed = await getEquipmentRequests(token)
          setRequests(refreshed.requests)
        } catch (refreshError) {
          setReviewErrors((current) => ({
            ...current,
            [requestId]: `${caught.message} ${refreshError.message}`,
          }))
        }
      }
    } finally {
      setReviewingRequestId('')
    }
  }

  function renderTechSupportRequest(request) {
    const windows = request.bookings || []
    const items = request.items || []
    const bookedEquipment = request.equipment_bookings || []
    const pending = request.status === 'Pending Technical Approval'

    return (
      <article className="choice equipment-request-card" key={request.id}>
        <div className="equipment-request-card__body">
          <strong className="choice__title">{request.event?.name || 'Assigned event'}</strong>
          {request.session && (
            <span className="choice__description">Session: {request.session.name}</span>
          )}
          <span className="choice__description">
            Organiser: {request.event?.organiser_name || 'Unknown'}
          </span>
          <span className="choice__description">
            Status: <span className="tag">{request.status}</span>
          </span>

          <div className="stack stack--tight">
            <strong>{request.session ? 'Session time' : 'Event time windows'}</strong>
            {windows.length === 0 ? (
              <span className="choice__description">
                No valid event or venue booking time is available for allocation.
              </span>
            ) : windows.map((booking, index) => (
              <span
                className="choice__description"
                key={booking.booking_id || `event-${index}`}
              >
                {booking.venue_name || (request.session ? 'No venue booked yet' : 'Event schedule')}
                {booking.room_layout ? ` · ${booking.room_layout}` : ''}
                {' · '}
                {formatDateRange(booking.start_at, booking.end_at)}
                {booking.booking_status
                  && !['EVENT_SCHEDULE', 'SESSION_SCHEDULE'].includes(booking.booking_status)
                  ? ` · ${booking.booking_status}`
                  : ''}
              </span>
            ))}
          </div>

          <div className="stack stack--tight">
            <strong>Equipment requested</strong>
            <span className="choice__description">
              {request.request_details || 'No request description provided.'}
            </span>
            {items.length === 0 ? (
              <span className="choice__description">
                Specific equipment will be selected by Technical Support.
              </span>
            ) : items.map((item) => (
              <span className="choice__description" key={item.id}>
                {item.equipment?.name || 'Equipment'} × {item.quantity}
                {' · '}
                {bookedEquipment.some(
                  (booking) => booking.equipment_id === item.equipment_id,
                )
                  ? 'Allocated'
                  : 'Not allocated'}
                {pending && (
                  <>
                    {' · '}
                    <Link to={`/equipment/${item.equipment_id}/bookings?request=${request.id}`}>
                      {bookedEquipment.some(
                        (booking) => booking.equipment_id === item.equipment_id,
                      )
                        ? 'View booking'
                        : 'Check calendar and allocate'}
                    </Link>
                  </>
                )}
              </span>
            ))}
          </div>

          <div className="stack stack--tight">
            <strong>Booked equipment</strong>
            {bookedEquipment.length === 0 ? (
              <span className="choice__description">No equipment booked yet.</span>
            ) : bookedEquipment.map((booking) => (
              <span className="choice__description" key={booking.id}>
                {booking.equipment_name}
                {' · '}
                {formatDateRange(booking.start_at, booking.end_at)}
                {' · '}
                <Link to={`/equipment/${booking.equipment_id}/bookings`}>Calendar</Link>
              </span>
            ))}
          </div>

          {reviewErrors[request.id] && (
            <p className="form-error" role="alert">{reviewErrors[request.id]}</p>
          )}

          {pending && (
            <div className="form-actions">
              <Link
                to={`/equipment?request=${encodeURIComponent(request.id)}`}
                className="button button--secondary"
              >
                Choose equipment to allocate
              </Link>
              <button
                className="button"
                type="button"
                disabled={reviewingRequestId === request.id}
                onClick={() => handleReview(request.id, 'Approved')}
              >
                {reviewingRequestId === request.id ? 'Saving…' : 'Approve request'}
              </button>
              <button
                className="button button--secondary"
                type="button"
                disabled={reviewingRequestId === request.id}
                onClick={() => handleReview(request.id, 'Rejected')}
              >
                Reject request
              </button>
            </div>
          )}
        </div>
      </article>
    )
  }

  if (loading) {
    return (
      <AppShell>
        <p className="page-state">Loading equipment requests…</p>
      </AppShell>
    )
  }

  return (
    <AppShell>
      <div className="content">
        {isCoordinator && requestedEventId ? (
          <Link to={`/event-reviews/${encodeURIComponent(requestedEventId)}`} className="backlink">
            ← Back to event
          </Link>
        ) : (
          <Link to="/dashboard" className="backlink">← Dashboard</Link>
        )}
        <div className="content__header">
          <h1>{isCoordinator ? 'Equipment requests' : 'Equipment requests to review'}</h1>
          <p className="lead">
            {isCoordinator
              ? 'Request equipment for each session of an event assigned to you, then track its technical approval status.'
              : 'Review each request, book the equipment it needs, then approve or reject it.'}
          </p>
          {isCoordinator && requestedEventId && (
            <p className="note">
              Showing requests for {requestedEvent?.name || 'this event'} only.
              {' '}<Link to="/equipment-requests">See all your equipment requests</Link>
            </p>
          )}
        </div>

        {error && <p className="form-error" role="alert">{error}</p>}
        {submittedMessage && <p className="form-success" role="status">{submittedMessage}</p>}

        {isCoordinator && (!requestedEventId || selectedEvent) && openEvents.length > 0 && (
          <form className="form" onSubmit={handleSubmit}>
            <section className="stack stack--tight">
              <h2 className="section-title">Request equipment</h2>
              {requestedEventId ? (
                <p className="note">Event: {selectedEvent.name}</p>
              ) : (
                <div className="field">
                  <label htmlFor="event">Assigned event</label>
                  <select
                    id="event"
                    value={eventId}
                    onChange={(change) => {
                      setEventId(change.target.value)
                      setSessionId('')
                      setRequestDetails('')
                    }}
                    required
                  >
                    <option value="">Choose an event…</option>
                    {openEvents.map((eventItem) => (
                      <option key={eventItem.id} value={eventItem.id}>
                        {eventItem.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {selectedEvent && (
                <div className="field">
                  <label htmlFor="session">Session</label>
                  <select
                    id="session"
                    value={sessionId}
                    onChange={(change) => chooseSession(change.target.value)}
                    required
                  >
                    <option value="">Choose a session…</option>
                    {openSessions.map((session) => (
                      <option key={session.id} value={session.id}>
                        {session.name} · {formatDateRange(session.start_time, session.end_time)}
                      </option>
                    ))}
                  </select>
                  <p className="field__hint">
                    Each session gets its own request. Sessions that already
                    have one are not listed.
                  </p>
                </div>
              )}
              {selectedSession && (
                <p className="note" role="status">
                  Needed for: {formatDateRange(selectedSession.start_time, selectedSession.end_time)}
                </p>
              )}
            </section>

            <section className="stack stack--tight">
              <h2 className="section-title">Required equipment</h2>
              <label className="field" htmlFor="request-details">
                Describe the equipment needed
              </label>
              <textarea
                id="request-details"
                rows={4}
                maxLength={2000}
                value={requestDetails}
                onChange={(change) => setRequestDetails(change.target.value)}
                placeholder="Describe the equipment and quantities needed."
                required
              />
              <p className="field__hint">
                Filled in from the Organiser's equipment needs for this session.
                Technical Support will choose suitable catalogue equipment and
                check its availability for the session's start and end time.
              </p>
            </section>

            <div className="form-actions">
              <button
                type="submit"
                className="button"
                disabled={submitting || !selectedEvent || !selectedSession}
              >
                {submitting ? 'Submitting…' : 'Request equipment'}
              </button>
            </div>
          </form>
        )}

        {isCoordinator && requestedEventId && !selectedEvent && (
          <p className="note">
            {requestedEvent && requestedEvent.sessions?.length > 0
              ? 'Every session of this event has an equipment request. Each session can have one request.'
              : 'This event is not available for a new equipment request.'}
          </p>
        )}

        {isCoordinator && openEvents.length === 0 && !requestedEventId && (
          <p className="note">
            There are no eligible assigned events with a session still
            needing an equipment request. Each session can have one request.
          </p>
        )}

        <section className="stack stack--tight">
          <h2 className="section-title">
            {isCoordinator ? 'Submitted requests' : 'Equipment requests to review'}
          </h2>
          {requests.length === 0 ? (
            <p className="note">
              {isCoordinator
                ? 'You have not submitted any equipment requests.'
                : 'There are no equipment requests to review.'}
            </p>
          ) : (
            <div className={isTechSupport ? 'choices' : 'stack stack--tight'}>
              {requests.map((request) => (
                isTechSupport
                  ? renderTechSupportRequest(request)
                  : (
                    <EquipmentRequestCard
                      key={request.id}
                      title={request.session?.name || 'Whole event'}
                      eventName={request.event?.name || 'Assigned event'}
                      request={request}
                      timing={request.session || request.event}
                    />
                  )
              ))}
            </div>
          )}
        </section>
      </div>
    </AppShell>
  )
}
