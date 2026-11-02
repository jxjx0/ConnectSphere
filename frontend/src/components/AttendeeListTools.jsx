export default function AttendeeListTools({ query, onQueryChange, filter = 'all', onFilterChange, options = [], count }) {
  const hasFilter = options.length > 0
  return (
    <div className={`attendee-list-tools${hasFilter ? '' : ' attendee-list-tools--search-only'}`}>
      <div className="field">
        <label htmlFor="attendee-search">Search events</label>
        <input id="attendee-search" type="search" placeholder="Search by event name"
          value={query} onChange={(event) => onQueryChange(event.target.value)} />
      </div>
      {hasFilter && <div className="field">
        <label htmlFor="attendee-filter">Show</label>
        <select id="attendee-filter" value={filter} onChange={(event) => onFilterChange(event.target.value)}>
          {options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </div>}
      {count != null && <p className="note attendee-result-count" role="status">{count} {count === 1 ? 'event' : 'events'}</p>}
      {(query || (hasFilter && filter !== 'all')) && (
        <button type="button" className="attendee-text-button" onClick={() => {
          onQueryChange('')
          if (hasFilter) onFilterChange('all')
        }}>{hasFilter ? 'Clear filters' : 'Clear search'}</button>
      )}
    </div>
  )
}
