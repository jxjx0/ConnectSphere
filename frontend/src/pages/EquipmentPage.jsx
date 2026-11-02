import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'

import { getEquipment, updateEquipment } from '../api/equipment'
import TechSupportShell from '../components/TechSupportShell'
import {
  EQUIPMENT_STATUSES,
  EQUIPMENT_TYPES,
  filterEquipment,
  isBookable,
  statusTagClass,
} from '../equipmentCatalogue'
import styles from '../styles/TechSupport.module.css'

function EditEquipmentDialog({ item, onClose, onSaved }) {
  const dialogRef = useRef(null)
  const [form, setForm] = useState({
    name: item.name,
    type: item.type,
    maintenance_status: item.maintenance_status,
  })
  const [nameError, setNameError] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    dialogRef.current?.showModal()
  }, [])

  function updateField(field, value) {
    setForm((current) => ({ ...current, [field]: value }))
  }

  async function handleSubmit(event) {
    event.preventDefault()
    setError('')
    const name = form.name.trim()
    setNameError(name ? '' : 'Enter a name for this equipment.')
    if (!name) return

    setSaving(true)
    try {
      await updateEquipment(item.id, { ...form, name })
      onSaved({ ...item, ...form, name })
    } catch (caught) {
      setError(caught.response?.data?.error || 'Could not save these changes. Try again.')
      setSaving(false)
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-labelledby="edit-equipment-title"
      onCancel={onClose}
    >
      <h2 className={styles.dialogTitle} id="edit-equipment-title">Edit Equipment Profile</h2>
      <form className="form" onSubmit={handleSubmit} noValidate>
        <div className="field">
          <label htmlFor="edit-id">Equipment ID</label>
          <input id="edit-id" value={item.id} readOnly disabled />
        </div>
        <div className="field">
          <label htmlFor="edit-name">Name</label>
          <input
            id="edit-name"
            maxLength={200}
            aria-invalid={Boolean(nameError)}
            value={form.name}
            onChange={(change) => updateField('name', change.target.value)}
          />
          {nameError && <p className="form-error" role="alert">{nameError}</p>}
        </div>
        <div className="field">
          <label htmlFor="edit-type">Type</label>
          <select
            id="edit-type"
            value={form.type}
            onChange={(change) => updateField('type', change.target.value)}
          >
            {EQUIPMENT_TYPES.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="edit-status">Status</label>
          <select
            id="edit-status"
            value={form.maintenance_status}
            onChange={(change) => updateField('maintenance_status', change.target.value)}
          >
            {EQUIPMENT_STATUSES.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="form-actions">
          <button type="submit" className="button" disabled={saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
          <button type="button" className="button button--secondary" disabled={saving} onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </dialog>
  )
}

export default function EquipmentPage() {
  const [equipment, setEquipment] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [nameFilter, setNameFilter] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [editingItem, setEditingItem] = useState(null)

  useEffect(() => {
    getEquipment()
      .then(setEquipment)
      .catch((caught) => {
        setError(caught.response?.data?.error || 'Could not load the equipment catalogue.')
      })
      .finally(() => setLoading(false))
  }, [])

  const filtered = filterEquipment(equipment, {
    name: nameFilter,
    type: typeFilter,
    status: statusFilter,
  })
  const hasFilters = Boolean(nameFilter || typeFilter || statusFilter)

  return (
    <TechSupportShell>
      <div className="content__header">
        <h1>Equipment Catalogue</h1>
        <p className="lead">Review equipment details, condition and bookings.</p>
      </div>

      <section className="stack stack--tight">
        <h2 className="section-title">Equipment catalogue</h2>
        <div className="form-actions">
          <Link to="/equipment/new" className="button">Create Equipment Profile</Link>
        </div>

        {loading && <p className="note">Loading equipment…</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        {!loading && !error && equipment.length === 0 && (
          <p className="note">No equipment has been added yet.</p>
        )}

        {!loading && !error && equipment.length > 0 && (
          <div className={styles.page}>
            <div className={styles.filters}>
              <div className="field">
                <label htmlFor="name-filter">Name</label>
                <input
                  id="name-filter"
                  type="search"
                  placeholder="Search by name…"
                  value={nameFilter}
                  onChange={(change) => setNameFilter(change.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="type-filter">Type</label>
                <select id="type-filter" value={typeFilter} onChange={(change) => setTypeFilter(change.target.value)}>
                  <option value="">All types</option>
                  {EQUIPMENT_TYPES.map((option) => <option key={option} value={option}>{option}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="status-filter">Status</label>
                <select id="status-filter" value={statusFilter} onChange={(change) => setStatusFilter(change.target.value)}>
                  <option value="">All statuses</option>
                  {EQUIPMENT_STATUSES.map((option) => <option key={option} value={option}>{option}</option>)}
                </select>
              </div>
            </div>

            <div className={styles.resultBar}>
              <p className="note" role="status">
                Showing <strong>{filtered.length}</strong> of <strong>{equipment.length}</strong> items
              </p>
              {hasFilters && (
                <button
                  type="button"
                  className="button button--secondary button--small"
                  onClick={() => {
                    setNameFilter('')
                    setTypeFilter('')
                    setStatusFilter('')
                  }}
                >
                  Clear filters
                </button>
              )}
            </div>

            {filtered.length === 0 ? (
              <p className="note">No equipment matches these filters.</p>
            ) : (
              <div className="table-wrapper">
                <table className="venue-table">
                  <caption className="visually-hidden">Equipment catalogue</caption>
                  <thead>
                    <tr>
                      <th scope="col">Equipment</th>
                      <th scope="col">Type</th>
                      <th scope="col">Status</th>
                      <th scope="col">Equipment ID</th>
                      <th scope="col" className="venue-table__actions">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((item) => (
                      <tr key={item.id}>
                        <th scope="row">{item.name}</th>
                        <td>{item.type}</td>
                        <td><span className={statusTagClass(item.maintenance_status)}>{item.maintenance_status}</span></td>
                        <td className={styles.equipmentId}>{item.id}</td>
                        <td className="venue-table__actions">
                          <div className={styles.actions}>
                            <button
                              type="button"
                              className="button button--secondary button--small"
                              onClick={() => setEditingItem(item)}
                            >
                              Edit
                            </button>
                            {isBookable(item) ? (
                              <Link
                                to={`/equipment/${item.id}/bookings`}
                                className="button button--secondary button--small"
                              >
                                Bookings
                              </Link>
                            ) : (
                              <button
                                type="button"
                                className="button button--secondary button--small"
                                disabled
                                title={`${item.maintenance_status} equipment cannot be booked.`}
                              >
                                Bookings
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="field__hint">
              Bookings are unavailable for equipment that is under repair or decommissioned.
            </p>
          </div>
        )}
      </section>

      {editingItem && (
        <EditEquipmentDialog
          item={editingItem}
          onClose={() => setEditingItem(null)}
          onSaved={(saved) => {
            setEquipment((current) => current.map((item) => (item.id === saved.id ? saved : item)))
            setEditingItem(null)
          }}
        />
      )}
    </TechSupportShell>
  )
}
