//Creates a Section for blocking form


export default function BlockForm({ venue, onClose }) {
  return (
    <section className="form">
      <div className="stack stack--tight">
        <h2 className="section-title">Block venue</h2>

        <p className="field__hint">
          Specify when and why this venue should be blocked.
        </p>

        <div className="field">
          <label>Venue ID</label>
          <input value={venue.id} disabled />
        </div>

        <div className="field">
          <label>Venue name</label>
          <input value={venue.name} disabled />
        </div>

        <div className="field">
          <label>Blocked time</label>

          <div className="repeater__row repeater__row--equal">
            <div className="repeater__field">
              <label htmlFor="blockStartTime">Start time</label>
              <input
                id="blockStartTime"
                type="time"
              />
            </div>

            <div className="repeater__field">
              <label htmlFor="blockEndTime">End time</label>
              <input
                id="blockEndTime"
                type="time"
              />
            </div>
          </div>
        </div>

        <div className="field">
          <label htmlFor="blockReason">Reason</label>
          <input
            id="blockReason"
            placeholder="Enter reason for blocking this venue"
          />
        </div>

        <div className="form-actions">
          <button type="button" className="button">
            Submit
          </button>

          <button
            type="button"
            className="button button--secondary"
            onClick={onClose}
          >
            Cancel
          </button>
        </div>
      </div>
    </section>
  )
}
