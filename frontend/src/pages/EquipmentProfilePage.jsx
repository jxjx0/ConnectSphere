import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { createEquipment, getEquipment } from '../api/equipment'
import TechSupportShell from '../components/TechSupportShell'
import EquipmentForm from '../components/EquipmentForm'

export default function EquipmentProfilePage() {
  const navigate = useNavigate()
  const [catalogue, setCatalogue] = useState([])
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // Only feeds the form's suggestions, so the form still works without it.
  useEffect(() => {
    getEquipment().then(setCatalogue).catch(() => setCatalogue([]))
  }, [])

  async function handleSubmit(equipmentData) {
    setError('')
    setSubmitting(true)
    try {
      await createEquipment(equipmentData)
      navigate('/equipment')
    } catch (caught) {
      setError(
        caught.response?.data?.error
        || caught.response?.data?.errors?.join(' ')
        || 'Could not save this equipment. Try again.',
      )
      setSubmitting(false)
    }
  }

  return (
    <TechSupportShell>
      <div className="content__header">
        <Link to="/equipment" className="backlink">← Back to Equipment Catalogue</Link>
        <h1>Create Equipment Profile</h1>
        <p className="lead">Add new technical hardware to the equipment catalogue.</p>
      </div>

      <section className="stack stack--tight">
        <h2 className="section-title">Equipment details</h2>
        <EquipmentForm
          catalogue={catalogue}
          error={error}
          submitting={submitting}
          onSubmit={handleSubmit}
        />
      </section>
    </TechSupportShell>
  )
}
