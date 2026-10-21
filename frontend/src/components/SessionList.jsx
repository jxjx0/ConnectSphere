import { formatDateRange, optional, sessionsOf } from '../eventDisplay'

// The sessions of a submitted event, one card each, in time order (the
// backend sorts them). Shared by the Organiser's and staff event pages.
export default function SessionList({ event }) {
  const sessions = sessionsOf(event)
  return (
    <section className="stack stack--tight">
      <h2 className="section-title">Sessions ({sessions.length})</h2>
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
              <dt>Location</dt>
              <dd>{optional(session.location_preference)}</dd>
            </div>
            <div className="detail-list__row">
              <dt>Layout</dt>
              <dd>{optional(session.layout_preference)}</dd>
            </div>
            <div className="detail-list__row">
              <dt>Equipment</dt>
              <dd>{optional(session.equipment_requirements)}</dd>
            </div>
          </dl>
        </div>
      ))}
    </section>
  )
}
