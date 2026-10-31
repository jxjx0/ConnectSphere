// The event's stage on the progress bar, what it means for the reader, and
// any open requests as badges. Used on the Organiser and Coordinator pages.

import {
  openRequestBadges,
  progressFor,
  statusLabel,
  statusNextStep,
} from '../eventStatus'

export default function EventStatusPanel({ event, role }) {
  const progress = progressFor(event.status)
  const badges = openRequestBadges(event, role)

  return (
    <section className="progress" aria-label="Event progress">
      {progress.steps.length > 0 && (
        <ol className="track">
          {progress.steps.map((step) => (
            <li
              key={step.status}
              className={`track__step track__step--${step.state}`}
              aria-current={step.state === 'current' ? 'step' : undefined}
            >
              <span className="track__dot" aria-hidden="true" />
              <span className="track__label">{step.label}</span>
            </li>
          ))}
        </ol>
      )}

      {progress.notice && <p className="notice">{progress.notice}</p>}

      {badges.length > 0 && (
        <div className="form-actions" aria-label="Open requests">
          {badges.map((badge) => (
            <span
              key={badge.kind}
              className={badge.yourTurn ? 'tag tag--your-turn' : 'tag'}
            >
              {badge.yourTurn ? `${badge.label} · your turn` : badge.label}
            </span>
          ))}
        </div>
      )}

      <p className="progress__next">
        <strong>{statusLabel(event.status)}.</strong> {statusNextStep(event.status, role)}
      </p>
    </section>
  )
}
