import { groupRegistrationsByEvent } from '../attendeeRegistration'
import { formatDateTime } from '../eventDisplay'

export default function RegistrationHistory({ registrations, eventId, currentRegistrationId }) {
  const group = groupRegistrationsByEvent(registrations).find(({ latest }) => latest.event_id === eventId)
  if (!group) return null
  const attempts = [group.latest, ...group.history]
  if (currentRegistrationId && attempts.length < 2) return null

  return (
    <details className="attendee-panel registration-history" aria-label="Registration history">
      <summary className="registration-history__summary">
        <h2>Registration history <span className="registration-history__count">({attempts.length})</span></h2>
        <svg className="registration-history__chevron" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </summary>
      <ol className="registration-history__list">
        {attempts.map((attempt) => (
          <li className="registration-history__item" key={attempt.id}>
            <div className="attendee-history-entry">
              <span className={`tag tag--${attempt.status === 'withdrawn' ? 'withdrawn' : 'registered'}`}>
                {attempt.status === 'withdrawn' ? 'Withdrawn' : 'Registered'}
              </span>
              {attempt.id === currentRegistrationId && <span className="note">Viewing this registration</span>}
            </div>
            <div className="attendee-history-dates">
              <p>Registered {formatDateTime(attempt.created_at)}</p>
              {attempt.status === 'withdrawn' && <p>Withdrawn {formatDateTime(attempt.withdrawn_at)}</p>}
            </div>
          </li>
        ))}
      </ol>
    </details>
  )
}
