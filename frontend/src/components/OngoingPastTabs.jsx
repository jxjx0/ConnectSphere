// Switches a list of requests between what is still going on and what is over.

export default function OngoingPastTabs({ view, onChange, ongoing, past }) {
  const tab = (id, label, count) => (
    <button
      type="button"
      className={view === id ? 'button button--small' : 'button button--small button--secondary'}
      aria-pressed={view === id}
      onClick={() => onChange(id)}
    >
      {label} ({count})
    </button>
  )
  return (
    <div className="form-actions">
      {tab('ongoing', 'Ongoing', ongoing)}
      {tab('past', 'Past', past)}
    </div>
  )
}
