import { formatDateRange, optional, sessionsOf } from '../eventDisplay'

// The sessions of a submitted event, one card each, in time order. Shared
// by the Organiser's and staff event pages. These are the Organiser's
// requests, not bookings: the booked venue and equipment are shown
// separately where a page has them. A page can pass a title and a note to
// say so.
export default function SessionList({ event, title = 'Sessions', note }) {
  const sessions = sessionsOf(event)
  return (
    <section className="stack stack--tight">
      <h2 className="section-title">{title} ({sessions.length})</h2>
      {note && <p className="note">{note}</p>}
      {sessions.map((session) => (
        <div className="session-card" key={session.id}>
          <h3>{session.name}</h3>
          <dl className="detail-list">
            <div className="detail-list__row">
              <dt>When</dt>
              <dd>{formatDateRange(session.start_time, session.end_time)}</dd>
            </div>
            <div className="detail-list__row">
              <dt>Attendance</dt>
              <dd>{session.expected_attendance}</dd>
            </div>
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
      ))}
    </section>
  )
}
