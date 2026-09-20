import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import AppShell from '../components/AppShell'
import { getEquipment } from '../api/equipment'

export default function EquipmentPage() {
  const [equipment, setEquipment] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [nameFilter, setNameFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  useEffect(() => {
    const fetchEquipment = async () => {
      try {
        setLoading(true)
        const data = await getEquipment()
        setEquipment(data)
      } catch (err) {
        const message =
          err.response?.data?.error || 'Failed to load equipment catalogue.'
        setError(message)
      } finally {
        setLoading(false)
      }
    }

    fetchEquipment()
  }, [])

  const filteredEquipment = equipment.filter((item) => {
    const nameMatch = item.name
      ?.toLowerCase()
      .includes(nameFilter.toLowerCase());

    const itemType = item.category || item.type || '';
    const typeMatch = typeFilter === '' || itemType === typeFilter;

    const itemStatus = item.status || item.maintenance_status || item.condition || '';
    const statusMatch = statusFilter === '' || itemStatus === statusFilter;

    return nameMatch && typeMatch && statusMatch;
  });

  return (
    <AppShell>
      <div className="content__header">
        <div>
          <h1>Equipment Catalogue</h1>
          <p className="lead">
            Manage technical equipment and inventory available across venues.
          </p>
        </div>
        <div className="form-actions">
          <Link to="/equipment/new" className="button button--secondary">
            Create Equipment Profile
          </Link>
        </div>
      </div>

      {loading && <p>Loading equipment catalogue...</p>}

      {error && <p className="error">{error}</p>}

      {!loading && !error && equipment.length === 0 && (
        <section className="stack stack--tight">
          <p>No equipment profiles registered yet.</p>
          <div>
            <Link to="/equipment/new" className="button">
              Create First Equipment Profile
            </Link>
          </div>
        </section>
      )}

      {!loading && !error && equipment.length > 0 && (
        <section className="stack">
          {/* Filter Bar */}
          <div className="filter-card">
            <div className="filter-grid">
              <div className="form-group">
                <label className="form-label" htmlFor="name-filter">
                  Filter by Name
                </label>
                <input
                  id="name-filter"
                  type="text"
                  className="form-input"
                  placeholder="Search by name..."
                  value={nameFilter}
                  onChange={(e) => setNameFilter(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="type-filter">
                  Filter by Type
                </label>
                <select
                  id="type-filter"
                  className="form-input"
                  value={typeFilter}
                  onChange={(e) => setTypeFilter(e.target.value)}
                >
                  <option value="">All Types</option>
                  <option value="Audio">Audio</option>
                  <option value="Visual">Visual</option>
                  <option value="Staging">Staging</option>
                </select>
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="status-filter">
                  Filter by Status
                </label>
                <select
                  id="status-filter"
                  className="form-input"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                >
                  <option value="">All Statuses</option>
                  <option value="Functional">Functional</option>
                  <option value="Under Repair">Under Repair</option>
                  <option value="Decommissioned">Decommissioned</option>
                </select>
              </div>
            </div>
          </div>

          {/* Results Summary Counter */}
          <div
            style={{
              display: 'flex',
              justify: 'space-between',
              alignItems: 'center'
            }}
          >
            <p>
              Showing <strong>{filteredEquipment.length}</strong> of{' '}
              <strong>{equipment.length}</strong> equipment items
            </p>
            {(nameFilter || typeFilter || statusFilter) && (
              <button
                type="button"
                className="button button--secondary"
                onClick={() => {
                  setNameFilter('')
                  setTypeFilter('')
                  setStatusFilter('')
                }}
              >
                Clear Filters
              </button>
            )}
          </div>

          {/* Table / Search Results */}
          {filteredEquipment.length === 0 ? (
            <p>No equipment profiles match your filter criteria.</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Name</th>
                  <th>Category / Type</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {filteredEquipment.map((item) => (
                  <tr key={item.id}>
                    <td><code>{item.id}</code></td>
                    <td>
                      <strong>{item.name}</strong>
                    </td>
                    <td>{item.category || item.type || 'N/A'}</td>
                    <td>
                      <span className="tag">
                        {item.maintenance_status || item.status || item.condition || 'Available'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </AppShell>
  )
}