import { formatDateRange, optional, sessionsOf } from '../eventDisplay'

// The sessions of a submitted event, one card each, in time order. Shared
// by the Organiser's and staff event pages. These are the Organiser's
// requests, not bookings: the booked venue and equipment are shown
// separately where a page has them. A page can pass a title and a note to
// say so, and `extra` to add its own part to each session's card (the
// Safety Officer's page adds the venue booked for that session, shown
// beside the request).
export default function SessionList({ event, title = 'Sessions', note, extra }) {
  const sessions = sessionsOf(event)
  return (
    <section className="stack stack--tight">
      <h2 className="section-title">{title} ({sessions.length})</h2>
      {note && <p className="note">{note}</p>}
      {sessions.map((session) => (
        <article className={extra ? 'session-card session-card--split' : 'session-card'} key={session.id}>
          <header className="session-card__head">
            <h3>{session.name}</h3>
            <p className="session-card__meta">
              {formatDateRange(session.start_time, session.end_time)}
              {' · '}
              {session.expected_attendance} attendees
            </p>
          </header>
          <div className={extra ? 'session-card__body session-card__body--split' : 'session-card__body'}>
            <div className="session-card__part">
              {extra && <h4 className="session-card__label">Requested</h4>}
              <dl className="detail-list detail-list--compact">
                <div className="detail-list__row">
                  <dt>Preferred location</dt>
                  <dd>{optional(session.location_preference)}</dd>
                </div>
                <div className="detail-list__row">
                  <dt>Preferred layout</dt>
                  <dd>{optional(session.layout_preference)}</dd>
                </div>
                <div className="detail-list__row">
                  <dt>Equipment needed</dt>
                  <dd>{optional(session.equipment_requirements)}</dd>
                </div>
              </dl>
            </div>
            {extra && <div className="session-card__part">{extra(session)}</div>}
          </div>
        </article>
      ))}
    </section>
  )
}
