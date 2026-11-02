// Creates an equipment profile. Choosing the name of something already in
// the catalogue fills in its type, unless Technical Support has picked one. A
// new name is its own type until they say otherwise.

import { useState } from 'react'

import {
  EQUIPMENT_STATUSES,
  equipmentTypes,
  typeForName,
  uniqueEquipmentNames,
} from '../equipmentCatalogue'

function RequiredMark() {
  return <span aria-hidden="true" style={{ color: 'var(--danger)' }}>*</span>
}

export default function EquipmentForm({ catalogue = [], initialType = '', error, submitting, onSubmit }) {
  const [name, setName] = useState(initialType)
  const [type, setType] = useState(initialType)
  const [typeChosen, setTypeChosen] = useState(Boolean(initialType))
  const [status, setStatus] = useState('Functional')
  const [errors, setErrors] = useState({})

  function updateName(value) {
    setName(value)
    if (errors.name) setErrors((current) => ({ ...current, name: '' }))
    if (!typeChosen) setType(typeForName(catalogue, value) || value.trim())
  }

  function handleSubmit(event) {
    event.preventDefault()
    const nextErrors = {}
    if (!name.trim()) nextErrors.name = 'Enter a name for this equipment.'
    if (!type.trim()) nextErrors.type = 'Enter the type of this equipment.'
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) return
    onSubmit({ name: name.trim(), type: type.trim(), maintenance_status: status })
  }

  return (
    <form className="form" onSubmit={handleSubmit} noValidate>
      <p className="field__hint">Fields marked * are required.</p>

      <div className="field">
        <label htmlFor="equipment-name">Name <RequiredMark /></label>
        <input
          id="equipment-name"
          list="equipment-names"
          placeholder="e.g. Audio Mixer"
          autoComplete="off"
          maxLength={200}
          aria-invalid={Boolean(errors.name)}
          aria-describedby="equipment-name-hint"
          value={name}
          onChange={(change) => updateName(change.target.value)}
        />
        <datalist id="equipment-names">
          {uniqueEquipmentNames(catalogue).map((known) => <option key={known} value={known} />)}
        </datalist>
        <p className="field__hint" id="equipment-name-hint">
          Choose an existing name to add another of the same item. Its details fill in for you.
        </p>
        {errors.name && <p className="form-error" role="alert">{errors.name}</p>}
      </div>

      <div className="field">
        <label htmlFor="equipment-type">Type <RequiredMark /></label>
        <input
          id="equipment-type"
          list="equipment-types"
          placeholder="e.g. Projector"
          autoComplete="off"
          maxLength={120}
          aria-invalid={Boolean(errors.type)}
          aria-describedby="equipment-type-hint"
          value={type}
          onChange={(change) => {
            setType(change.target.value)
            setTypeChosen(true)
            if (errors.type) setErrors((current) => ({ ...current, type: '' }))
          }}
        />
        <datalist id="equipment-types">
          {equipmentTypes(catalogue).map((known) => <option key={known} value={known} />)}
        </datalist>
        <p className="field__hint" id="equipment-type-hint">
          What Coordinators ask for. An "Old Projector" and a "Projector" are both the type "Projector".
        </p>
        {errors.type && <p className="form-error" role="alert">{errors.type}</p>}
      </div>

      <div className="field">
        <label htmlFor="equipment-status">Status <RequiredMark /></label>
        <select
          id="equipment-status"
          value={status}
          onChange={(change) => setStatus(change.target.value)}
        >
          {EQUIPMENT_STATUSES.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      </div>

      {error && <p className="form-error" role="alert">{error}</p>}

      <div className="form-actions">
        <button type="submit" className="button" disabled={submitting}>
          {submitting ? 'Saving equipment…' : 'Save equipment'}
        </button>
      </div>
    </form>
  )
}
