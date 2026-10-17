import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import {
  getEquipmentCatalog,
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
  const isCoordinator = user.role === 'coordinator'
  const [events, setEvents] = useState([])
  const [equipment, setEquipment] = useState([])
  const [requests, setRequests] = useState([])
  const [eventId, setEventId] = useState('')
  const [quantities, setQuantities] = useState({})
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
      ...(isCoordinator
        ? [getAssignedEventRequests(token), getEquipmentCatalog(token)]
        : []),
    ]

    Promise.all(loads)
      .then(([requestData, eventData, equipmentData]) => {
        setRequests(requestData.requests)
        if (isCoordinator) {
          setEvents(
            equipmentRequestEligibleEvents(eventData.events),
          )
          setEquipment(
            equipmentData.filter((item) => item.maintenance_status === 'Functional'),
          )
        }
      })
      .catch((caught) => setError(caught.message))
      .finally(() => setLoading(false))
  }, [isCoordinator, token])

  const selectedEvent = useMemo(
    () => events.find((event) => event.id === eventId),
    [eventId, events],
  )

  function toggleEquipment(item, checked) {
    setQuantities((current) => {
      const updated = { ...current }
      if (checked) updated[item.id] = '1'
      else delete updated[item.id]
      return updated
    })
  }

  function updateQuantity(itemId, value) {
    setQuantities((current) => ({ ...current, [itemId]: value }))
  }

  async function handleSubmit(event) {
    event.preventDefault()
    setError('')
    setSubmittedMessage('')

    const items = Object.entries(quantities).map(([equipment_id, quantity]) => ({
      equipment_id,
      quantity: Number(quantity),
    }))
    if (!eventId) {
      setError('Select an assigned event.')
      return
    }
    if (
      items.length === 0
      || items.some((item) => !Number.isInteger(item.quantity) || item.quantity < 1)
    ) {
      setError('Select at least one equipment item and enter a quantity of 1 or more.')
      return
    }

    setSubmitting(true)
    try {
      const data = await submitEquipmentRequest({ event_id: eventId, items }, token)
      const submittedRequest = {
        ...data.request,
        event: selectedEvent,
        items: data.request.items.map((item) => ({
          ...item,
          equipment: equipment.find((entry) => entry.id === item.equipment_id),
        })),
      }
      setRequests((current) => [submittedRequest, ...current])
      setQuantities({})
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
    const pending = request.status === 'Pending Technical Approval'
    const hasUnavailableItem = items.some((item) => !item.available)

    return (
      <article className="choice equipment-request-card" key={request.id}>
        <div className="equipment-request-card__body">
          <strong className="choice__title">{request.event?.name || 'Assigned event'}</strong>
          <span className="choice__description">
            Organiser: {request.event?.organiser_name || 'Unknown'}
          </span>
          <span className="choice__description">
            Status: <span className="tag">{request.status}</span>
            {request.technical_requirement_outstanding
              && ' · Outstanding technical requirement'}
          </span>

          <div className="stack stack--tight">
            <strong>Booking time windows</strong>
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

          {pending && hasUnavailableItem && (
            <p className="note" role="status">
              This request cannot be reserved as-is. If approval is attempted,
              it will remain pending and the Coordinator will be notified.
            </p>
          )}

          <div className="stack stack--tight">
            <strong>Requested equipment</strong>
            {items.length === 0 ? (
              <span className="choice__description">No equipment items were included.</span>
            ) : items.map((item) => (
              <span className="choice__description" key={item.id}>
                {item.equipment?.name || 'Equipment'} × {item.quantity}
                {' · '}
                {item.reserved
                  ? 'Reserved for this event'
                  : item.available
                    ? 'Available for all listed time windows'
                    : 'Unavailable for this time window'}
              </span>
            ))}
          </div>

          {reviewErrors[request.id] && (
            <p className="form-error" role="alert">{reviewErrors[request.id]}</p>
          )}

          {pending && (
            <div className="form-actions">
              <button
                className="button"
                type="button"
                disabled={reviewingRequestId === request.id}
                onClick={() => handleReview(request.id, 'Approved')}
              >
                {reviewingRequestId === request.id ? 'Saving…' : 'Approve and reserve'}
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
              : 'Review the equipment requested for events. Requests remain pending until reviewed.'}
          </p>
        </div>

        {error && <p className="form-error" role="alert">{error}</p>}
        {submittedMessage && <p className="form-success" role="status">{submittedMessage}</p>}

        {isCoordinator && (
          <form className="form" onSubmit={handleSubmit}>
            <section className="stack stack--tight">
              <h2 className="section-title">Submit a request</h2>
              <div className="field">
                <label htmlFor="event">Assigned event</label>
                <select
                  id="event"
                  value={eventId}
                  onChange={(change) => setEventId(change.target.value)}
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
              {selectedEvent && (
                <p className="note" role="status">
                  Event schedule: {formatDateRange(selectedEvent.start_time, selectedEvent.end_time)}
                </p>
              )}

              {events.length === 0 && (
                <p className="note">You have no assigned events in Planning or Confirmed status that are eligible for equipment requests.</p>
              )}
            </section>

            <section className="stack stack--tight">
              <h2 className="section-title">Required equipment</h2>
              {equipment.length === 0 ? (
                <p className="note">No functional equipment is currently available in the catalogue.</p>
              ) : (
                <div className="stack stack--tight">
                  {equipment.map((item) => {
                    const selected = Object.hasOwn(quantities, item.id)
                    return (
                      <div className="equipment-request-item" key={item.id}>
                        <label className="equipment-request-item__name">
                          <input
                            type="checkbox"
                            checked={selected}
                            onChange={(change) => toggleEquipment(item, change.target.checked)}
                          />
                          <span>{item.name} <span className="note">({item.type})</span></span>
                        </label>
                        <label className="equipment-request-item__quantity">
                          Quantity
                          <input
                            type="number"
                            min="1"
                            step="1"
                            inputMode="numeric"
                            value={quantities[item.id] ?? ''}
                            disabled={!selected}
                            onChange={(change) => updateQuantity(item.id, change.target.value)}
                            aria-label={`Quantity of ${item.name}`}
                          />
                        </label>
                      </div>
                    )
                  })}
                </div>
              )}
            </section>

            <div className="form-actions">
              <button
                type="submit"
                className="button"
                disabled={submitting || events.length === 0 || equipment.length === 0}
              >
                {submitting ? 'Submitting…' : 'Submit equipment request'}
              </button>
            </div>
          </form>
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
                        {request.status !== 'Approved' && (
                          <span className="choice__description">
                            Outstanding technical requirement
                          </span>
                        )}
                        <span className="choice__description">{equipmentLines(request)}</span>
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
