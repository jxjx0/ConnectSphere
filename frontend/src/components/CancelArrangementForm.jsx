import { useState } from 'react'

// A "Cancel …" button that opens a reason box (T7-282). The Coordinator
// must give a reason and confirm, because a cancellation cannot be undone.
// `onCancel(reason)` does the cancelling and throws to show an error.
export default function CancelArrangementForm({ label, confirmMessage, onCancel }) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  if (!open) {
    return (
      <button type="button" className="button button--secondary" onClick={() => setOpen(true)}>
        {label}
      </button>
    )
  }

  async function submit(formEvent) {
    formEvent.preventDefault()
    if (!reason.trim()) {
      setError('Give a reason for cancelling.')
      return
    }
    if (!window.confirm(confirmMessage)) return

    setError('')
    setSaving(true)
    try {
      await onCancel(reason.trim())
    } catch (caught) {
      setError(caught.message)
      setSaving(false)
    }
  }

  return (
    <form className="stack stack--tight" onSubmit={submit} style={{ width: '100%' }}>
      <label className="field">
        <span className="field__label">Reason for cancelling</span>
        <textarea
          value={reason}
          onChange={(change) => {
            setReason(change.target.value)
            setError('')
          }}
          rows={2}
          maxLength={500}
          autoFocus
        />
      </label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="form-actions">
        <button className="button" disabled={saving}>
          {saving ? 'Cancelling…' : label}
        </button>
        <button
          type="button"
          className="button button--secondary"
          disabled={saving}
          onClick={() => {
            setOpen(false)
            setReason('')
            setError('')
          }}
        >
          Keep it
        </button>
      </div>
    </form>
  )
}
