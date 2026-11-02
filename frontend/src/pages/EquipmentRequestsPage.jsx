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
import OngoingPastTabs from '../components/OngoingPastTabs'
import { useAuth } from '../context/AuthContext'
import { formatDateRange } from '../eventDisplay'
import { isPastEquipmentRequest } from '../coordinatorEventView'
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
  const [allEvents, setAllEvents] = useState([])
  const [requests, setRequests] = useState([])
  const eventId = requestedEventId
  const [view, setView] = useState('ongoing')
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
        setAllEvents(eventData.events)
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
  const isPast = (request) => isPastEquipmentRequest(
    request,
    allEvents.find((eventItem) => eventItem.id === request.event_id),
  )
  const pastRequests = requests.filter(isPast)
  const shownRequests = requestedEventId
    ? requests
    : requests.filter((request) => isPast(request) === (view === 'past'))

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
        {requestedEventId && (
          <Link to={`/event-reviews/${encodeURIComponent(requestedEventId)}`} className="backlink">
            ← Back
          </Link>
        )}
        <div className="content__header">
          <h1>Equipment requests</h1>
          <p className="lead">
            {requestedEventId
              ? 'Request equipment for each session of this event, then track its technical approval.'
              : 'Track the equipment requested for your events. To request some, open the event.'}
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

        {selectedEvent && (
          <form className="form" onSubmit={handleSubmit}>
            <section className="stack stack--tight">
              <h2 className="section-title">Request equipment</h2>
              <p className="note">Event: {selectedEvent.name}</p>
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

        <section className="stack stack--tight">
          <h2 className="section-title">Submitted requests</h2>
          {!requestedEventId && (
            <OngoingPastTabs
              view={view}
              onChange={setView}
              ongoing={requests.length - pastRequests.length}
              past={pastRequests.length}
            />
          )}
          {shownRequests.length === 0 ? (
            <p className="note">
              {requestedEventId
                ? 'You have not submitted any equipment requests for this event.'
                : view === 'ongoing'
                  ? 'You have no ongoing equipment requests.'
                  : 'You have no past equipment requests.'}
            </p>
          ) : (
            <div className="stack stack--tight">
              {shownRequests.map((request) => (
                <EquipmentRequestCard
                  key={request.id}
                  title={request.session?.name || 'Whole event'}
                  eventName={request.event?.name || 'Assigned event'}
                  request={request}
                  timing={request.session || request.event}
                  actions={!requestedEventId && request.event_id && (
                    <Link
                      to={`/event-reviews/${encodeURIComponent(request.event_id)}`}
                      className="button button--secondary button--small"
                    >
                      Open event
                    </Link>
                  )}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </AppShell>
  )
}
