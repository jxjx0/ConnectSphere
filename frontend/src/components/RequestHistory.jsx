// Every closed clarification, change request and cancellation request on an
// event, newest first. Open ones are shown at the top of the page instead.

import { formatDateTime } from '../eventDisplay'
import { requestHistory } from '../eventStatus'

function Details({ kind, item, role }) {
  const organiser = role === 'organiser' ? 'You' : 'Organiser'
  const coordinator = role === 'coordinator' ? 'You' : 'Coordinator'

  if (kind === 'clarification') {
    return (
      <>
        <p><strong>{coordinator} asked:</strong> {item.coordinator_notes}</p>
        {item.organiser_response
          ? <p><strong>{organiser} replied:</strong> {item.organiser_response}</p>
          : <p className="note">No reply was sent before the event ended.</p>}
      </>
    )
  }
  return (
    <>
      <p>
        <strong>{organiser}{kind === 'change' ? ' asked to change the event' : ' asked to cancel the event'}:</strong>
        {' '}{kind === 'change' ? item.reason_for_change : item.reason}
      </p>
      {item.decision_reason && (
        <p><strong>{coordinator} said:</strong> {item.decision_reason}</p>
      )}
      {item.status === 'expired' && (
        <p className="note">It was not reviewed before the event ended.</p>
      )}
    </>
  )
}

export default function RequestHistory({ clarifications, event, role }) {
  const history = requestHistory(clarifications, event)
  if (history.length === 0) return null

  return (
    <section className="stack stack--tight">
      <h2 className="section-title">History</h2>
      {history.map((entry) => (
        <article className="notice" key={entry.id}>
          <p>
            <strong>{entry.label}</strong>
            {' '}<span className="tag">{entry.outcome}</span>
            {' · '}{formatDateTime(entry.closedAt || entry.openedAt)}
          </p>
          <Details kind={entry.kind} item={entry.item} role={role} />
        </article>
      ))}
    </section>
  )
}
