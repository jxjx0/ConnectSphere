import { formatDateRange } from '../eventDisplay'
import { emptySession, sessionLabel } from '../eventSessions'

// The editable list of sessions, shared by the event request form and the
// change request form (T7-274, T7-280). `onChange` receives the whole new
// list. Sessions for which `isLocked` returns true have already started:
// they are shown but cannot be changed or removed (scope doc 9.1).
export default function SessionFields({ sessions, onChange, isLocked = () => false }) {
  function updateSession(index, field) {
    return (event) => onChange(sessions.map((session, position) =>
      position === index ? { ...session, [field]: event.target.value } : session))
  }

  function removeSession(index) {
    onChange(sessions.filter((_, position) => position !== index))
  }

  return (
    <>
      {sessions.map((session, index) => {
        if (isLocked(session)) {
          return (
            <fieldset className="session-card" key={session.formKey}>
              <legend>{sessionLabel(session, index)}</legend>
              <p className="note">
                {formatDateRange(session.startTime, session.endTime)}
                {' · '}{session.expectedAttendance} attendees
              </p>
              <p className="note">This session has already started, so it can't be changed or removed.</p>
            </fieldset>
          )
        }

        // Ids must be unique on the page, so they carry the session's
        // place on the form.
        const id = (field) => `session-${index}-${field}`
        return (
          <fieldset className="session-card" key={session.formKey}>
            <legend>{sessionLabel(session, index)}</legend>

            <div className="field">
              <label htmlFor={id('name')}>Session name</label>
              <input
                id={id('name')}
                maxLength={200}
                placeholder="For example: Main programme, Breakout A"
                value={session.name}
                onChange={updateSession(index, 'name')}
                required
              />
            </div>

            <div className="field">
              <label htmlFor={id('start')}>Starts</label>
              <input
                id={id('start')}
                type="datetime-local"
                value={session.startTime}
                onChange={updateSession(index, 'startTime')}
                required
              />
            </div>

            <div className="field">
              <label htmlFor={id('end')}>Ends</label>
              <input
                id={id('end')}
                type="datetime-local"
                value={session.endTime}
                onChange={updateSession(index, 'endTime')}
                required
              />
            </div>

            <div className="field">
              <label htmlFor={id('attendance')}>Expected attendance</label>
              <input
                id={id('attendance')}
                type="number"
                min={1}
                value={session.expectedAttendance}
                onChange={updateSession(index, 'expectedAttendance')}
                required
              />
            </div>

            <div className="field">
              <label htmlFor={id('location')}>Preferred location</label>
              <input
                id={id('location')}
                aria-describedby={id('location-hint')}
                value={session.locationPreference}
                onChange={updateSession(index, 'locationPreference')}
              />
              <p className="field__hint" id={id('location-hint')}>
                Optional. Your Coordinator selects the actual venue.
              </p>
            </div>

            <div className="field">
              <label htmlFor={id('layout')}>Preferred room layout</label>
              <input
                id={id('layout')}
                aria-describedby={id('layout-hint')}
                value={session.layoutPreference}
                onChange={updateSession(index, 'layoutPreference')}
              />
              <p className="field__hint" id={id('layout-hint')}>
                Optional. For example: theatre, classroom, banquet.
              </p>
            </div>

            <div className="field">
              <label htmlFor={id('equipment')}>Equipment requirements</label>
              <textarea
                id={id('equipment')}
                rows={3}
                aria-describedby={id('equipment-hint')}
                value={session.equipmentRequirements}
                onChange={updateSession(index, 'equipmentRequirements')}
              />
              <p className="field__hint" id={id('equipment-hint')}>
                Optional. Describe what you need &mdash; Technical
                Support will match it to available equipment.
              </p>
            </div>

            {/* An event always keeps at least one session. */}
            {sessions.length > 1 && (
              <button
                type="button"
                className="button button--secondary button--small"
                onClick={() => removeSession(index)}
              >
                Remove {sessionLabel(session, index)}
              </button>
            )}
          </fieldset>
        )
      })}

      <div>
        <button
          type="button"
          className="button button--secondary"
          onClick={() => onChange([...sessions, emptySession()])}
        >
          + Add session
        </button>
      </div>
    </>
  )
}
