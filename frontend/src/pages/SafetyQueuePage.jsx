import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import { getSafetyHistory, getSafetyQueue } from '../api/events'
import AppShell from '../components/AppShell'
import { safetyTabFrom } from '../components/SafetyTabs'
import { useAuth } from '../context/AuthContext'
import { categoryLabel } from '../eventCategories'
import { formatDateRange, formatDateTime, formatSessionSummary } from '../eventDisplay'
import { statusLabel } from '../eventStatus'
import { formatTimeAgo } from '../leadCoordinatorView'

const DECISIONS = {
  APPROVED: { label: 'Approved', className: 'tag tag--good' },
  CHANGES_REQUESTED: { label: 'Changes requested', className: 'tag tag--warning' },
  REJECTED: { label: 'Rejected', className: 'tag tag--danger' },
}

const HEADINGS = {
  'to-review': {
    title: 'Safety Checks to Review',
    lead: 'Events waiting for your safety check, longest wait first.',
    empty: 'All caught up. No events are waiting for a safety check.',
  },
  reviewed: {
    title: 'Reviewed Safety Checks',
    lead: 'The decisions made on safety checks, newest first.',
    empty: 'No safety checks have been reviewed yet.',
  },
  'no-longer-needed': {
    title: 'No Longer Needed',
    lead: 'Events that ended while waiting for a safety check, so no decision is needed.',
    empty: 'No events have ended while waiting for a safety check.',
  },
}

function ViewLink({ eventId, tab, children, primary = false }) {
  return (
    <Link
      to={`/safetyreview/${eventId}${tab === 'to-review' ? '' : `?from=${tab}`}`}
      className={primary ? 'button button--small' : 'button button--secondary button--small'}
    >
      {children}
    </Link>
  )
}

function EventTiming({ event }) {
  return (
    <>
      <div>{formatDateRange(event.start_time, event.end_time)}</div>
      {event.sessions && <div className="field__hint">{formatSessionSummary(event)}</div>}
    </>
  )
}

export default function SafetyQueuePage() {
  const { token } = useAuth()
  const [searchParams] = useSearchParams()
  const tab = safetyTabFrom(searchParams.get('tab'))
  const [queue, setQueue] = useState([])
  const [history, setHistory] = useState({ reviewed: [], expired: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    const load = tab === 'to-review'
      ? getSafetyQueue(token).then((data) => {
        if (active) setQueue(Array.isArray(data) ? data : data?.queue || data?.events || [])
      })
      : getSafetyHistory(token).then((data) => {
        if (active) setHistory({ reviewed: data.reviewed || [], expired: data.expired || [] })
      })
    load
      .catch((caught) => {
        if (active) setError(caught.message || 'Could not load this list.')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [tab, token])

  const heading = HEADINGS[tab]
  const rows = { 'to-review': queue, reviewed: history.reviewed, 'no-longer-needed': history.expired }[tab]

  return (
    <AppShell>
      <div className="content__header">
        <h1>{heading.title}</h1>
        <p className="lead">{heading.lead}</p>
      </div>

      {loading && <p className="note">Loading…</p>}
      {error && <p className="form-error" role="alert">{error}</p>}

      {!loading && !error && rows.length === 0 && <p className="workspace-empty">{heading.empty}</p>}

      {!loading && !error && rows.length > 0 && (
        <div className="table-wrapper">
          {tab === 'to-review' && (
            <table className="venue-table">
              <caption className="visually-hidden">Events waiting for a safety check</caption>
              <thead>
                <tr>
                  <th scope="col">Event</th>
                  <th scope="col">Category</th>
                  <th scope="col">When</th>
                  <th scope="col">Waiting since</th>
                  <th scope="col" className="venue-table__actions">Actions</th>
                </tr>
              </thead>
              <tbody>
                {queue.map((event) => {
                  const since = event.safety_check_requested_at || event.updated_at || event.created_at
                  return (
                    <tr key={event.id}>
                      <th scope="row">{event.name}</th>
                      <td>{categoryLabel(event.category, event.category_other)}</td>
                      <td><EventTiming event={event} /></td>
                      <td>
                        <div>{formatTimeAgo(since) || 'Unknown'}</div>
                        {since && <div className="field__hint">{formatDateTime(since)}</div>}
                      </td>
                      <td className="venue-table__actions">
                        <ViewLink eventId={event.id} tab={tab} primary>Review</ViewLink>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}

          {tab === 'reviewed' && (
            <table className="venue-table">
              <caption className="visually-hidden">Reviewed safety checks</caption>
              <thead>
                <tr>
                  <th scope="col">Event</th>
                  <th scope="col">Decision</th>
                  <th scope="col">Reason</th>
                  <th scope="col">Reviewed</th>
                  <th scope="col" className="venue-table__actions">Actions</th>
                </tr>
              </thead>
              <tbody>
                {history.reviewed.map((review) => {
                  const decision = DECISIONS[review.decision] || { label: review.decision, className: 'tag' }
                  return (
                    <tr key={review.id}>
                      <th scope="row">{review.event?.name || 'Event'}</th>
                      <td><span className={decision.className}>{decision.label}</span></td>
                      <td>{review.reason || 'None given'}</td>
                      <td>
                        <div>{formatDateTime(review.created_at)}</div>
                        {review.officer?.full_name && <div className="field__hint">By {review.officer.full_name}</div>}
                      </td>
                      <td className="venue-table__actions">
                        <ViewLink eventId={review.event_id} tab={tab}>View</ViewLink>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}

          {tab === 'no-longer-needed' && (
            <table className="venue-table">
              <caption className="visually-hidden">Events that ended while waiting for a safety check</caption>
              <thead>
                <tr>
                  <th scope="col">Event</th>
                  <th scope="col">Category</th>
                  <th scope="col">When</th>
                  <th scope="col">Outcome</th>
                  <th scope="col" className="venue-table__actions">Actions</th>
                </tr>
              </thead>
              <tbody>
                {history.expired.map((event) => (
                  <tr key={event.id}>
                    <th scope="row">{event.name}</th>
                    <td>{categoryLabel(event.category, event.category_other)}</td>
                    <td><EventTiming event={event} /></td>
                    <td>
                      <div><span className="tag">{statusLabel(event.status)}</span></div>
                      {event.updated_at && <div className="field__hint">{formatDateTime(event.updated_at)}</div>}
                    </td>
                    <td className="venue-table__actions">
                      <ViewLink eventId={event.id} tab={tab}>View</ViewLink>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </AppShell>
  )
}
