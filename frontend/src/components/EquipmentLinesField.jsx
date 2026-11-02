// The rows of a Coordinator's equipment request: what they need, how many,
// and anything specific about it. "Other" covers what the catalogue lacks.

import { emptyLine, lineName, OTHER_EQUIPMENT } from '../equipmentCatalogue'

export default function EquipmentLinesField({ lines, types, onChange }) {
  function update(index, changes) {
    onChange(lines.map((line, lineIndex) => (lineIndex === index ? { ...line, ...changes } : line)))
  }

  return (
    <div className="stack stack--tight">
      {lines.map((line, index) => {
        const row = index + 1
        const type = types.find((option) => option.name === line.choice)
        const chosenElsewhere = lines
          .filter((_, lineIndex) => lineIndex !== index)
          .map(lineName)
        return (
          <fieldset className="session-card" key={index}>
            <legend className="visually-hidden">Equipment {row}</legend>

            <div className="field">
              <label htmlFor={`line-${row}-item`}>Equipment</label>
              <select
                id={`line-${row}-item`}
                value={line.choice}
                onChange={(change) => update(index, { choice: change.target.value, otherName: '' })}
              >
                <option value="">Choose equipment…</option>
                {types.map((option) => (
                  <option
                    key={option.name}
                    value={option.name}
                    disabled={chosenElsewhere.includes(option.name)}
                  >
                    {option.name}
                  </option>
                ))}
                <option value={OTHER_EQUIPMENT}>Other (not listed)…</option>
              </select>
            </div>

            {line.choice === OTHER_EQUIPMENT && (
              <div className="field">
                <label htmlFor={`line-${row}-other`}>What do you need?</label>
                <input
                  id={`line-${row}-other`}
                  maxLength={120}
                  placeholder="e.g. Fog machine"
                  value={line.otherName}
                  onChange={(change) => update(index, { otherName: change.target.value })}
                />
                <p className="field__hint">
                  This isn't in the catalogue yet, so Technical Support will need to source it.
                </p>
              </div>
            )}

            <div className="field">
              <label htmlFor={`line-${row}-quantity`}>Quantity</label>
              <input
                id={`line-${row}-quantity`}
                type="number"
                min="1"
                max="100"
                step="1"
                value={line.quantity}
                onChange={(change) => update(index, { quantity: change.target.value })}
              />
              {type && Number(line.quantity) > type.functional && (
                <p className="field__hint" role="status">
                  The catalogue only has {type.functional} usable. Technical Support may need to source more.
                </p>
              )}
            </div>

            <div className="field">
              <label htmlFor={`line-${row}-specifics`}>Specifics (optional)</label>
              <input
                id={`line-${row}-specifics`}
                maxLength={500}
                placeholder="e.g. Must have an HDMI input"
                value={line.specifics}
                onChange={(change) => update(index, { specifics: change.target.value })}
              />
            </div>

            {lines.length > 1 && (
              <button
                type="button"
                className="button button--secondary button--small"
                onClick={() => onChange(lines.filter((_, lineIndex) => lineIndex !== index))}
              >
                Remove
              </button>
            )}
          </fieldset>
        )
      })}

      <div>
        <button
          type="button"
          className="button button--secondary button--small"
          onClick={() => onChange([...lines, emptyLine()])}
        >
          Add another item
        </button>
      </div>
    </div>
  )
}
