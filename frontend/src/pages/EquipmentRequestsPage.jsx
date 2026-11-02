import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import {
  getEquipmentCatalog,
  getEquipmentRequests,
  getEventEquipmentRequests,
  submitEquipmentRequest,
} from '../api/equipmentRequests'
import { getAssignedEventRequests } from '../api/events'
import AppShell from '../components/AppShell'
import EquipmentLinesField from '../components/EquipmentLinesField'
import EquipmentRequestCard from '../components/EquipmentRequestCard'
import { useAuth } from '../context/AuthContext'
import { formatDateRange } from '../eventDisplay'
import {
  emptyLine,
  linesToPayload,
  requestableTypes,
  suggestLines,
  validateLines,
} from '../equipmentCatalogue'
import {
  equipmentRequestEligibleEvents,
  sessionsWithoutEquipmentRequest,
} from '../equipmentRequestEligibility'
import EquipmentReviewPage from './EquipmentReviewPage'

export default function EquipmentRequestsPage() {
  const { user } = useAuth()
  return user.role === 'tech_support' ? <EquipmentReviewPage /> : <CoordinatorEquipmentRequests />
}

function CoordinatorEquipmentRequests() {
  const { token } = useAuth()
  const [searchParams] = useSearchParams()
  const requestedEventId = searchParams.get('eventId') || ''
  const requestedSessionId = searchParams.get('sessionId') || ''
  const [events, setEvents] = useState([])
  const [requests, setRequests] = useState([])
  const [eventId, setEventId] = useState(requestedEventId)
  const [sessionId, setSessionId] = useState('')
  const [lines, setLines] = useState([emptyLine()])
  const [equipmentTypes, setEquipmentTypes] = useState([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [submittedMessage, setSubmittedMessage] = useState('')

  // Opened from one event's page, the Coordinator sees only that event's
  // requests; otherwise every request they can see.
  const loadRequests = useCallback(() => (
    requestedEventId
      ? getEventEquipmentRequests(requestedEventId, token)
      : getEquipmentRequests(token)
  ), [requestedEventId, token])

  useEffect(() => {
    Promise.all([loadRequests(), getAssignedEventRequests(token), getEquipmentCatalog(token)])
      .then(([requestData, eventData, catalogue]) => {
        setRequests(requestData.requests)
        setEvents(equipmentRequestEligibleEvents(eventData.events))
        setEquipmentTypes(requestableTypes(catalogue))
      })
      .catch((caught) => setError(caught.message))
      .finally(() => setLoading(false))
  }, [loadRequests, token])

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
  // the only one left. Its equipment needs suggest the starting rows.
  useEffect(() => {
    if (!selectedEvent || openSessions.some((session) => session.id === sessionId)) return
    const next = openSessions.find((session) => session.id === requestedSessionId)
      || (openSessions.length === 1 ? openSessions[0] : null)
    setSessionId(next?.id || '')
    setLines(suggestLines(next?.equipment_requirements, equipmentTypes))
  }, [equipmentTypes, openSessions, requestedSessionId, selectedEvent, sessionId])

  function chooseSession(nextSessionId) {
    setSessionId(nextSessionId)
    const nextSession = openSessions.find((session) => session.id === nextSessionId)
    setLines(suggestLines(nextSession?.equipment_requirements, equipmentTypes))
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
    const linesError = validateLines(lines)
    if (linesError) {
      setError(linesError)
      return
    }

    setSubmitting(true)
    try {
      await submitEquipmentRequest({
        event_id: eventId,
        session_id: sessionId,
        lines: linesToPayload(lines),
      }, token)
      const refreshed = await loadRequests()
      setRequests(refreshed.requests)
      setSessionId('')
      setLines([emptyLine()])
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
        {requestedEventId ? (
          <Link to={`/event-reviews/${encodeURIComponent(requestedEventId)}`} className="backlink">
            ← Back to event
          </Link>
        ) : (
          <Link to="/dashboard" className="backlink">← Dashboard</Link>
        )}
        <div className="content__header">
          <h1>Equipment requests</h1>
          <p className="lead">
            Request equipment for each session of an event assigned to you, then track its technical approval status.
          </p>
          {requestedEventId && (
            <p className="note">
              Showing requests for {requestedEvent?.name || 'this event'} only.
              {' '}<Link to="/equipment-requests">See all your equipment requests</Link>
            </p>
          )}
        </div>

        {error && <p className="form-error" role="alert">{error}</p>}
        {submittedMessage && <p className="form-success" role="status">{submittedMessage}</p>}

        {(!requestedEventId || selectedEvent) && openEvents.length > 0 && (
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
                      setLines([emptyLine()])
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
              {selectedSession?.equipment_requirements?.trim() && (
                <p className="note">
                  <strong>The Organiser asked for:</strong> {selectedSession.equipment_requirements}
                </p>
              )}
              <EquipmentLinesField lines={lines} types={equipmentTypes} onChange={setLines} />
              <p className="field__hint">
                Rows are suggested from the Organiser's needs, so please check them.
                Technical Support will choose suitable equipment and check its
                availability for the session's start and end time.
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

        {requestedEventId && !selectedEvent && (
          <p className="note">
            {requestedEvent && requestedEvent.sessions?.length > 0
              ? 'Every session of this event has an equipment request. Each session can have one request.'
              : 'This event is not available for a new equipment request.'}
          </p>
        )}

        {openEvents.length === 0 && !requestedEventId && (
          <p className="note">
            There are no eligible assigned events with a session still
            needing an equipment request. Each session can have one request.
          </p>
        )}

        <section className="stack stack--tight">
          <h2 className="section-title">Submitted requests</h2>
          {requests.length === 0 ? (
            <p className="note">You have not submitted any equipment requests.</p>
          ) : (
            <div className="stack stack--tight">
              {requests.map((request) => (
                <EquipmentRequestCard
                  key={request.id}
                  title={request.session?.name || 'Whole event'}
                  eventName={request.event?.name || 'Assigned event'}
                  request={request}
                  timing={request.session || request.event}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </AppShell>
  )
}
