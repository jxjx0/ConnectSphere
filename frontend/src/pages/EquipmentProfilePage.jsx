import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import AppShell from '../components/AppShell'
import EquipmentForm from '../components/EquipmentForm'
import { createEquipment } from '../api/equipment'

export default function EquipmentProfilePage() {
  const navigate = useNavigate()
  const [error, setError] = useState(null)

  const handleSubmit = async (equipmentData) => {
    setError(null)
    try {
      await createEquipment(equipmentData)
      navigate('/equipment')
    } catch (err) {
      const message =
        err.response?.data?.error ||
        err.response?.data?.errors?.join(', ') ||
        err.message
      setError(message || 'Failed to create equipment profile.')
    }
  }

  return (
    <AppShell>
      <div className="content__header">
        <h1>Create Equipment Profile</h1>
        <p className="lead">
          Add new technical hardware and specs to the equipment catalogue.
        </p>
      </div>

      <section className="stack">
        {error && <p className="error">{error}</p>}
        <EquipmentForm onSubmit={handleSubmit} />
      </section>
    </AppShell>
  )
}