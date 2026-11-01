import { useEffect, useRef, useState } from 'react'

import { getMyRegistration, withdrawRegistration } from '../api/events'
import { useAuth } from '../context/AuthContext'
import { formatDateTime } from '../eventDisplay'

export default function RegistrationWithdrawal({ registration, onUpdate, compact = false }) {
  const { token } = useAuth()
  const [withdrawing, setWithdrawing] = useState(false)
  const [error, setError] = useState('')
  const requestScope = useRef(0)

  useEffect(() => {
    requestScope.current += 1
    setWithdrawing(false)
    setError('')
    return () => { requestScope.current += 1 }
  }, [registration.id, token])

  async function withdraw() {
    if (withdrawing || !window.confirm(
      `Withdraw your registration for "${registration.event_name}"? You will no longer hold a place at this event.`,
    )) return
    const scope = requestScope.current
    setWithdrawing(true)
    setError('')
    try {
      const data = await withdrawRegistration(registration.id, token)
      if (scope === requestScope.current) onUpdate(data.registration)
    } catch (caught) {
      if (scope !== requestScope.current) return
      setError(caught.message)
      // Refresh eligibility if the event started or was cancelled meanwhile.
      if (caught.status === 409) {
        try {
          const data = await getMyRegistration(registration.id, token)
          if (scope === requestScope.current) onUpdate(data.registration)
        } catch { /* Keep the withdrawal error visible if refreshing fails. */ }
      }
    } finally {
      if (scope === requestScope.current) setWithdrawing(false)
    }
  }

  return (
    <>
      {error && <p className="form-error" role="alert">{error}</p>}
      {!compact && registration.status !== 'withdrawn' && !registration.can_withdraw && (
        <p className="note">Withdrawal is no longer available for this registration.</p>
      )}
      {registration.can_withdraw && (
        <div className="stack stack--tight">
          {!compact && <p className="note">{registration.event_start_time
            ? `You can withdraw before ${formatDateTime(registration.event_start_time)}.`
            : "You can withdraw before the event's first session starts."}</p>}
          <div className="form-actions">
            <button
              type="button"
              className="button button--secondary"
              disabled={withdrawing}
              onClick={withdraw}
            >
              {withdrawing ? 'Withdrawing…' : 'Withdraw registration'}
            </button>
          </div>
        </div>
      )}
    </>
  )
}
