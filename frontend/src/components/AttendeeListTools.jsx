export default function AttendeeListTools({ query, onQueryChange, filter, onFilterChange, options, count }) {
  return (
    <div className="attendee-list-tools">
      <div className="field">
        <label htmlFor="attendee-search">Search events</label>
        <input id="attendee-search" type="search" placeholder="Search by event name"
          value={query} onChange={(event) => onQueryChange(event.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="attendee-filter">Show</label>
        <select id="attendee-filter" value={filter} onChange={(event) => onFilterChange(event.target.value)}>
          {options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </div>
      {count != null && <p className="note attendee-result-count" role="status">{count} {count === 1 ? 'event' : 'events'}</p>}
      {(query || filter !== 'all') && (
        <button type="button" className="attendee-text-button" onClick={() => {
          onQueryChange('')
          onFilterChange('all')
        }}>Clear filters</button>
      )}
    </div>
  )
}
