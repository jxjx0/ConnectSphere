import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import AppShell from '../components/AppShell'
import { getEquipment, updateEquipment } from '../api/equipment'

export default function EquipmentPage() {
  const [equipment, setEquipment] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [nameFilter, setNameFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const [editingItem, setEditingItem] = useState(null)
  const [editForm, setEditForm] = useState({ name: '', type: '', maintenance_status: 'Functional' })
  const [editErrors, setEditErrors] = useState({})
  const [saveLoading, setSaveLoading] = useState(false)

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

  // Open edit modal/form pre-filled with current details
  const handleEditClick = (item) => {
    setEditingItem(item)
    setEditForm({
      name: item.name || '',
      type: item.category || item.type || '',
      maintenance_status: item.maintenance_status || item.status || 'Functional'
    })
    setEditErrors({})
  }

  // Validate edit payload
  const validateEdit = () => {
    const errors = {}
    if (!editForm.name.trim()) errors.name = 'Name cannot be empty.'
    if (!editForm.type.trim()) errors.type = 'Type/Category cannot be empty.'
    setEditErrors(errors)
    return Object.keys(errors).length === 0
  }

  // Submit edits
  const handleEditSubmit = async (e) => {
    e.preventDefault()
    if (!validateEdit()) return

    try {
      setSaveLoading(true)
      await updateEquipment(editingItem.id, editForm)
    //   setEditingItem(null)
    //   await fetchEquipmentCatalogue() // Refresh list to show updated details

    // 1. Instantly update main table state in UI
    setEquipment((prevList) =>
        prevList.map((item) =>
          item.id === editingItem.id ? { ...item, ...editForm } : item
        )
      )

      // 2. Close modal & run existing refresh
      setEditingItem(null)
      if (typeof fetchEquipmentCatalogue === 'function') {
        await fetchEquipmentCatalogue()
      }

    } catch (err) {
      setEditErrors({ submit: err.message || 'Failed to save changes.' })
    } finally {
      setSaveLoading(false)
    }
  }

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
          <Link to="/equipment/bookings" className="button button--secondary">
            Shared bookings calendar
          </Link>
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
                        {item.maintenance_status || item.status || item.condition || 'Unknown'}
                      </span>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="button button--secondary button--small"
                        onClick={() => handleEditClick(item)}
                      >
                        Edit
                      </button>
                      {' '}
                      <Link
                        to={`/equipment/${item.id}/bookings`}
                        className="button button--secondary button--small"
                      >
                        Bookings
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {/* Edit Equipment Modal/Card */}
      {editingItem && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0,0,0,0.5)',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          zIndex: 1000
        }}>
          <div className="form-card" style={{ width: '100%', maxWidth: '500px', margin: 0 }}>
            <h2>Edit Equipment Profile</h2>
            {editErrors.submit && <p className="error">{editErrors.submit}</p>}

            <form onSubmit={handleEditSubmit}>
              {/* ID Read-Only */}
              <div className="form-group">
                <label className="form-label">Equipment ID (Read-Only)</label>
                <input type="text" className="form-input" value={editingItem.id} disabled readOnly style={{ background: '#f5f5f5' }} />
              </div>

              {/* Name Edit */}
              <div className="form-group">
                <label className="form-label">Name</label>
                <input
                  type="text"
                  className="form-input"
                  value={editForm.name}
                  onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                />
                {editErrors.name && <p className="error">{editErrors.name}</p>}
              </div>

              {/* Type Edit */}
              <div className="form-group">
                <label className="form-label">Type / Category</label>
                <select
                  className="form-input"
                  value={editForm.type}
                  onChange={(e) => setEditForm({ ...editForm, type: e.target.value })}
                >
                  <option value="" disabled>Select Type</option>
                  <option value="Audio">Audio</option>
                  <option value="Visual">Visual</option>
                  <option value="Staging">Staging</option>
                </select>
                {editErrors.type && <p className="error">{editErrors.type}</p>}
              </div>

              {/* Status Edit */}
              <div className="form-group">
                <label className="form-label">Status</label>
                <select
                  className="form-input"
                  value={editForm.maintenance_status}
                  onChange={(e) => setEditForm({ ...editForm, maintenance_status: e.target.value })}
                >
                  <option value="Functional">Functional</option>
                  <option value="Under Repair">Under Repair</option>
                  <option value="Decommissioned">Decommissioned</option>
                </select>
              </div>

              <div style={{ display: 'flex', gap: '1rem', marginTop: '1.5rem' }}>
                <button type="submit" className="button button--primary" disabled={saveLoading}>
                  {saveLoading ? 'Saving...' : 'Save Changes'}
                </button>
                <button
                  type="button"
                  className="button button--secondary"
                  onClick={() => setEditingItem(null)}
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </AppShell>
  )
}