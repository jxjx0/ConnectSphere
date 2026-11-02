// Technical Support's request review, laid out like the Venue Staff's: pick
// a request on the left, and allocate equipment for it in the panel on the
// right. The Coordinator's own view of requests is in EquipmentRequestsPage.

import { useCallback, useEffect, useState } from 'react'

import {
  deleteEquipmentBooking,
  getEquipmentCatalog,
  getEquipmentRequests,
  reviewEquipmentRequest,
} from '../api/equipmentRequests'
import TechSupportShell from '../components/TechSupportShell'
import EquipmentAllocationPanel from '../components/EquipmentAllocationPanel'
import { useAuth } from '../context/AuthContext'
import { allocationSummary, lineProgress, statusTagClass } from '../equipmentCatalogue'
import { formatDateRange, readableStatus } from '../eventDisplay'
import styles from '../styles/TechSupport.module.css'

const PENDING = 'Pending Technical Approval'
const SCHEDULE_ONLY = ['EVENT_SCHEDULE', 'SESSION_SCHEDULE']

function cardClass(status) {
  if (status === 'Approved') return styles.cardApproved
  if (status === 'Rejected' || status === 'Affected by Session Change') return styles.cardRejected
  return ''
}

function RequestDetails({ request, removingId, onRemove }) {
  const windows = request.bookings || []
  const allocated = request.equipment_bookings || []
  const pending = request.status === PENDING
  const lines = lineProgress(request)
  const lineIds = new Set(lines.map((line) => line.id))

  function renderBooking(booking) {
    return (
      <span className={styles.allocatedRow} key={booking.id}>
        <span className={styles.allocatedItem}>
          <span>{booking.equipment_name}</span>
          <span className={styles.equipmentId}>ID: {booking.equipment_id}</span>
        </span>
        {pending && (
          <button
            type="button"
            className="button button--secondary button--small"
            disabled={removingId === booking.id}
            onClick={(click) => {
              click.stopPropagation()
              onRemove(booking)
            }}
          >
            {removingId === booking.id ? 'Removing…' : 'Remove'}
          </button>
        )}
      </span>
    )
  }

  return (
    <dl className={styles.details}>
      {request.session && (
        <div>
          <dt>Session</dt>
          <dd>{request.session.name}</dd>
        </div>
      )}
      <div>
        <dt>Organiser</dt>
        <dd>{request.event?.organiser_name || 'Unknown'}</dd>
      </div>
      <div className={styles.fullWidth}>
        <dt>{request.session ? 'Session time' : 'Event time'}</dt>
        {windows.length === 0 ? (
          <dd>No valid event or venue booking time yet.</dd>
        ) : windows.map((window, index) => (
          <dd key={window.booking_id || index}>
            {formatDateRange(window.start_at, window.end_at)}
            {window.venue_name && ` · ${window.venue_name}`}
            {window.room_layout && ` · ${window.room_layout}`}
            {window.booking_status && !SCHEDULE_ONLY.includes(window.booking_status)
              && ` · Venue booking: ${readableStatus(window.booking_status.toLowerCase()).toLowerCase()}`}
          </dd>
        ))}
      </div>
      <div className={styles.fullWidth}>
        <dt>Equipment requested</dt>
        {lines.length === 0 ? (
          <dd>{request.request_details || 'No description provided.'}</dd>
        ) : lines.map((line) => (
          <dd key={line.id}>
            {line.item_name} × {line.quantity}
            {line.specifics && <span className={styles.optionMeta}> · {line.specifics}</span>}
          </dd>
        ))}
      </div>
      <div className={styles.fullWidth}>
        <dt>Allocated</dt>
        {lines.map((line) => (
          <dd className={styles.allocatedLine} key={line.id}>
            <span className={styles.progressRow}>
              <strong>{line.item_name}</strong>
              <span className={line.complete ? 'tag tag--good' : 'tag tag--warning'}>
                {line.allocated}/{line.quantity}
              </span>
            </span>
            {allocated.filter((booking) => booking.line_id === line.id).map(renderBooking)}
          </dd>
        ))}
        {lines.length === 0 && allocated.length === 0 && <dd>Nothing allocated yet.</dd>}
        {allocated.filter((booking) => !lineIds.has(booking.line_id)).map((booking) => (
          <dd key={booking.id}>{renderBooking(booking)}</dd>
        ))}
      </div>
    </dl>
  )
}

export default function EquipmentReviewPage() {
  const { token } = useAuth()
  const [requests, setRequests] = useState([])
  const [catalogue, setCatalogue] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [view, setView] = useState('pending')
  const [selectedId, setSelectedId] = useState(null)
  const [processingId, setProcessingId] = useState(null)
  const [rejectingId, setRejectingId] = useState(null)
  const [removingId, setRemovingId] = useState('')
  const [actionErrors, setActionErrors] = useState({})

  const refreshRequests = useCallback(
    () => getEquipmentRequests(token).then((data) => setRequests(data.requests)),
    [token],
  )

  useEffect(() => {
    Promise.all([refreshRequests(), getEquipmentCatalog(token).then(setCatalogue)])
      .catch((caught) => setError(caught.message))
      .finally(() => setLoading(false))
  }, [refreshRequests, token])

  const pending = requests.filter((request) => request.status === PENDING)
  const reviewed = requests.filter((request) => request.status !== PENDING)
  const selected = pending.find((request) => request.id === selectedId) || pending[0] || null

  function setActionError(requestId, message) {
    setActionErrors((current) => ({ ...current, [requestId]: message }))
  }

  async function handleReview(request, decision) {
    if (decision === 'Approved' && !window.confirm(
      `Approve the equipment request for ${request.event?.name || 'this event'}?`,
    )) return

    setProcessingId(request.id)
    setActionError(request.id, '')
    try {
      await reviewEquipmentRequest(request.id, decision, token)
      setRejectingId(null)
      await refreshRequests()
    } catch (caught) {
      setActionError(request.id, caught.message)
      // Someone else reviewed it first: show the request as it now stands.
      if (caught.status === 409) await refreshRequests().catch(() => {})
    } finally {
      setProcessingId(null)
    }
  }

  async function handleRemove(request, booking) {
    if (!window.confirm(`Remove ${booking.equipment_name} from this request?`)) return

    setRemovingId(booking.id)
    setActionError(request.id, '')
    try {
      await deleteEquipmentBooking(booking.id, token)
      await refreshRequests()
    } catch (caught) {
      setActionError(request.id, caught.message)
    } finally {
      setRemovingId('')
    }
  }

  return (
    <TechSupportShell>
      <div className={styles.page}>
        <div className="content__header">
          <h1>Review Equipment Requests</h1>
          <p className="lead">Select a request, allocate the equipment it needs, then approve or reject it.</p>
        </div>

        {loading && <p className="page-state">Loading equipment requests…</p>}
        {error && <p className="form-error" role="alert">{error}</p>}

        {!loading && !error && (
          <div className={styles.viewTabs}>
            <button
              type="button"
              className={`button button--small ${view === 'pending' ? '' : 'button--secondary'}`}
              aria-pressed={view === 'pending'}
              onClick={() => setView('pending')}
            >
              To review ({pending.length})
            </button>
            <button
              type="button"
              className={`button button--small ${view === 'reviewed' ? '' : 'button--secondary'}`}
              aria-pressed={view === 'reviewed'}
              onClick={() => setView('reviewed')}
            >
              Reviewed ({reviewed.length})
            </button>
          </div>
        )}

        {!loading && !error && view === 'pending' && pending.length === 0 && (
          <p className="note">No equipment requests are waiting for review.</p>
        )}

        {!loading && !error && view === 'pending' && selected && (
          <div className={styles.splitLayout}>
            <section className={styles.listSection}>
              <h2 className="section-title">Pending requests ({pending.length})</h2>
              <ul className={styles.requestList}>
                {pending.map((request) => {
                  const isProcessing = processingId === request.id
                  const summary = allocationSummary(request)
                  return (
                    <li
                      key={request.id}
                      tabIndex={0}
                      aria-current={selected.id === request.id ? 'true' : undefined}
                      className={`${styles.selectable} ${selected.id === request.id ? styles.selected : ''}`}
                      onClick={() => setSelectedId(request.id)}
                      onKeyDown={(key) => {
                        if (key.target === key.currentTarget && (key.key === 'Enter' || key.key === ' ')) {
                          key.preventDefault()
                          setSelectedId(request.id)
                        }
                      }}
                    >
                      <article className={styles.card}>
                        <div className={styles.cardHeader}>
                          <strong className={styles.cardTitle}>{request.event?.name || 'Assigned event'}</strong>
                          <span className={statusTagClass(request.status)}>{request.status}</span>
                        </div>
                        <RequestDetails
                          request={request}
                          removingId={removingId}
                          onRemove={(booking) => handleRemove(request, booking)}
                        />
                        {actionErrors[request.id] && (
                          <p className="form-error" role="alert">{actionErrors[request.id]}</p>
                        )}
                        {!summary.complete && (
                          <p className="note">
                            {summary.tracked
                              ? `${summary.remaining} more to allocate before this request can be approved.`
                              : 'Allocate at least one item before approving this request.'}
                          </p>
                        )}
                        {summary.tracked && summary.complete && (
                          <p className="form-success" role="status">Everything is allocated. Ready to approve.</p>
                        )}
                        <div className="form-actions" onClick={(click) => click.stopPropagation()}>
                          {rejectingId === request.id ? (
                            <>
                              <button
                                type="button"
                                className="button"
                                disabled={isProcessing}
                                onClick={() => handleReview(request, 'Rejected')}
                              >
                                {isProcessing ? 'Saving…' : 'Confirm rejection'}
                              </button>
                              <button
                                type="button"
                                className="button button--secondary"
                                disabled={isProcessing}
                                onClick={() => setRejectingId(null)}
                              >
                                Cancel
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                type="button"
                                className="button"
                                disabled={isProcessing || !summary.complete}
                                onClick={() => handleReview(request, 'Approved')}
                              >
                                {isProcessing ? 'Saving…' : 'Approve'}
                              </button>
                              <button
                                type="button"
                                className="button button--secondary"
                                disabled={isProcessing}
                                onClick={() => setRejectingId(request.id)}
                              >
                                Reject
                              </button>
                            </>
                          )}
                        </div>
                      </article>
                    </li>
                  )
                })}
              </ul>
            </section>

            <EquipmentAllocationPanel
              key={selected.id}
              request={selected}
              catalogue={catalogue}
              token={token}
              onChanged={refreshRequests}
            />
          </div>
        )}

        {!loading && !error && view === 'reviewed' && (
          <section className={styles.listSection}>
            <h2 className="section-title">Reviewed requests ({reviewed.length})</h2>
            {reviewed.length === 0 ? (
              <p className="note">No equipment requests have been reviewed yet.</p>
            ) : (
              <ul className={styles.requestList}>
                {reviewed.map((request) => (
                  <li key={request.id}>
                    <article className={`${styles.card} ${cardClass(request.status)}`}>
                      <div className={styles.cardHeader}>
                        <strong className={styles.cardTitle}>{request.event?.name || 'Assigned event'}</strong>
                        <span className={statusTagClass(request.status)}>{request.status}</span>
                      </div>
                      <RequestDetails request={request} />
                    </article>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </TechSupportShell>
  )
}
