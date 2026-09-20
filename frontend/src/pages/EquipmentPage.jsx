import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import AppShell from '../components/AppShell'
import { getEquipment } from '../api/equipment'

export default function EquipmentPage() {
  const [equipment, setEquipment] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

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
              {equipment.map((item) => (
                <tr key={item.id}>
                  <td><code>{item.id}</code></td>
                  <td>
                    <strong>{item.name}</strong>
                  </td>
                  <td>{item.category || item.type || 'N/A'}</td>
                  <td>
                    <span className="tag">
                      {item.status || item.condition || 'Available'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </AppShell>
  )
}