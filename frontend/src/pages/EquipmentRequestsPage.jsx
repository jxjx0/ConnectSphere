import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import {
  getEquipmentRequests,
  reviewEquipmentRequest,
  submitEquipmentRequest,
} from '../api/equipmentRequests'
import { getAssignedEventRequests } from '../api/events'
import AppShell from '../components/AppShell'
import { useAuth } from '../context/AuthContext'
import { formatDateRange } from '../eventDisplay'
import { equipmentRequestEligibleEvents } from '../equipmentRequestEligibility'

function equipmentLines(request) {
  return request.items.map((item) => (
    `${item.equipment?.name || 'Equipment'} × ${item.quantity}`
  )).join(', ')
}

export default function EquipmentRequestsPage() {
  const { token, user } = useAuth()
  const [searchParams] = useSearchParams()
  const requestedEventId = searchParams.get('eventId') || ''
  const isCoordinator = user.role === 'coordinator'
  const [events, setEvents] = useState([])
  const [requests, setRequests] = useState([])
  const [eventId, setEventId] = useState(requestedEventId)
  const [requestDetails, setRequestDetails] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [submittedMessage, setSubmittedMessage] = useState('')
  const [reviewingRequestId, setReviewingRequestId] = useState('')
  const [reviewErrors, setReviewErrors] = useState({})
  const isTechSupport = user.role === 'tech_support'

  useEffect(() => {
    const loads = [
      getEquipmentRequests(token),
      ...(isCoordinator ? [getAssignedEventRequests(token)] : []),
    ]

    Promise.all(loads)
      .then(([requestData, eventData]) => {
        setRequests(requestData.requests)
        if (isCoordinator) {
          const eventsWithRequests = new Set(
            requestData.requests.map((request) => request.event_id),
          )
          setEvents(
            equipmentRequestEligibleEvents(eventData.events)
              .filter((eventItem) => !eventsWithRequests.has(eventItem.id)),
          )
          const requestedEvent = eventData.events.find(
            (eventItem) => eventItem.id === requestedEventId,
          )
          if (requestedEvent) {
            setRequestDetails(requestedEvent.equipment_requirements || '')
          }
        }
      })
      .catch((caught) => setError(caught.message))
      .finally(() => setLoading(false))
  }, [isCoordinator, requestedEventId, token])

  const selectedEvent = useMemo(
    () => events.find((event) => event.id === eventId),
    [eventId, events],
  )
  const existingEventRequest = requestedEventId
    ? requests.find((request) => request.event_id === requestedEventId)
    : null

  async function handleSubmit(event) {
    event.preventDefault()
    setError('')
    setSubmittedMessage('')

    if (!eventId) {
      setError('Select an assigned event.')
      return
    }
    if (!requestDetails.trim()) {
      setError('Describe the equipment needed for this event.')
      return
    }

    setSubmitting(true)
    try {
      const data = await submitEquipmentRequest({
        event_id: eventId,
        request_details: requestDetails.trim(),
        items: [],
      }, token)
      const submittedRequest = {
        ...data.request,
        event: selectedEvent,
        items: [],
      }
      setRequests((current) => [submittedRequest, ...current])
      setEvents((current) => current.filter((eventItem) => eventItem.id !== eventId))
      if (!requestedEventId) {
        setEventId('')
        setRequestDetails('')
      }
      setSubmittedMessage('Equipment request submitted for technical approval.')
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
          <span className="choice__description">
            Organiser: {request.event?.organiser_name || 'Unknown'}
          </span>
          <span className="choice__description">
            Status: <span className="tag">{request.status}</span>
          </span>

          <div className="stack stack--tight">
            <strong>Event time windows</strong>
            {windows.length === 0 ? (
              <span className="choice__description">
                No valid event or venue booking time is available for allocation.
              </span>
            ) : windows.map((booking, index) => (
              <span
                className="choice__description"
                key={booking.booking_id || `event-${index}`}
              >
                {booking.venue_name || 'Event schedule'}
                {booking.room_layout ? ` · ${booking.room_layout}` : ''}
                {' · '}
                {formatDateRange(booking.start_at, booking.end_at)}
                {booking.booking_status && booking.booking_status !== 'EVENT_SCHEDULE'
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
        <Link to="/dashboard" className="backlink">← Dashboard</Link>
        <div className="content__header">
          <h1>{isCoordinator ? 'Equipment requests' : 'Equipment requests to review'}</h1>
          <p className="lead">
            {isCoordinator
              ? 'Request equipment for an event assigned to you, then track its technical approval status.'
              : 'Review each request, book the equipment it needs, then approve or reject it.'}
          </p>
        </div>

        {error && <p className="form-error" role="alert">{error}</p>}
        {submittedMessage && <p className="form-success" role="status">{submittedMessage}</p>}

        {isCoordinator && (!requestedEventId || (selectedEvent && !existingEventRequest)) && (
          <form className="form" onSubmit={handleSubmit}>
            <section className="stack stack--tight">
              <h2 className="section-title">Request equipment</h2>
              {requestedEventId && selectedEvent ? (
                <p className="note">
                  Event: {selectedEvent.name}
                </p>
              ) : !requestedEventId && (
                <div className="field">
                  <label htmlFor="event">Assigned event</label>
                  <select
                    id="event"
                    value={eventId}
                    onChange={(change) => {
                      const nextEventId = change.target.value
                      setEventId(nextEventId)
                      const nextEvent = events.find(
                        (eventItem) => eventItem.id === nextEventId,
                      )
                      setRequestDetails(nextEvent?.equipment_requirements || '')
                    }}
                    required
                  >
                    <option value="">Choose an event…</option>
                    {events.map((eventItem) => (
                      <option key={eventItem.id} value={eventItem.id}>
                        {eventItem.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {selectedEvent && (
                <p className="note" role="status">
                  Event schedule: {formatDateRange(selectedEvent.start_time, selectedEvent.end_time)}
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
                Technical Support will choose suitable catalogue equipment and
                check its availability for the event time, including venue
                setup and teardown.
              </p>
            </section>

            <div className="form-actions">
              <button
                type="submit"
                className="button"
                disabled={
                  submitting
                  || !selectedEvent
                  || (Boolean(requestedEventId) && selectedEvent.id !== requestedEventId)
                }
              >
                {submitting ? 'Submitting…' : 'Request equipment'}
              </button>
            </div>
          </form>
        )}

        {isCoordinator && requestedEventId && existingEventRequest && (
          <p className="note">
            This event already has an equipment request. Each event can have
            one request.
          </p>
        )}

        {isCoordinator && requestedEventId && !selectedEvent && !existingEventRequest && !loading && (
          <p className="note">
            This event is not available for a new equipment request.
          </p>
        )}

        {isCoordinator && events.length === 0 && !requestedEventId && (
          <p className="note">
            There are no eligible assigned events without an equipment request.
            Each event can have one equipment request.
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
            <div className="choices">
              {requests.map((request) => (
                isTechSupport
                  ? renderTechSupportRequest(request)
                  : (
                    <article className="choice equipment-request-card" key={request.id}>
                      <span className="choice__text">
                        <span className="choice__title">
                          {request.event?.name || 'Assigned event'}
                        </span>
                        <span className="choice__description">
                          {formatDateRange(request.event?.start_time, request.event?.end_time)}
                          {' · '}
                          <span className="tag">{request.status}</span>
                        </span>
                        <span className="choice__description">
                          {request.request_details || equipmentLines(request)}
                        </span>
                        <span className="choice__description">
                          {request.equipment_bookings?.length
                            ? `Booked equipment: ${request.equipment_bookings.map(
                              (booking) => booking.equipment?.name || 'Equipment',
                            ).join(', ')}`
                            : 'No equipment has been allocated yet.'}
                        </span>
                      </span>
                    </article>
                  )
              ))}
            </div>
          )}
        </section>
      </div>
    </AppShell>
  )
}
