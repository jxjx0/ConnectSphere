import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { getSafetyQueue } from '../api/events'
import AppShell from '../components/AppShell'
import { useAuth } from '../context/AuthContext'

export default function SafetyQueuePage() {
  const { token } = useAuth()
  const [queue, setQueue] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    getSafetyQueue(token)
      .then((res) => setQueue(res.queue || res.events || []))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [token])

  return (
    <AppShell>
      <div className="content__header">
        <h1>Safety Check Queue</h1>
        <p className="lead">
          Events requiring safety review and compliance approval.
        </p>
      </div>

      <section className="stack stack--tight">
        {loading && <p className="note">Loading safety queue...</p>}
        {error && <p className="form-error" role="alert">{error}</p>}

        {!loading && !error && queue.length === 0 && (
          <p className="note">No events are currently waiting for safety review.</p>
        )}

        {!loading && !error && queue.length > 0 && (
          <div className="choices">
            {queue.map((event) => (
              <Link
                key={event.id}
                to={`/safetyreview/${event.id}`}
                className="choice"
              >
                <span className="choice__text">
                  <span className="choice__title">{event.name}</span>
                  <span
                    className="choice__description"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 'var(--space-2)',
                      marginTop: 'var(--space-1)',
                    }}
                  >
                    <span className="tag">Safety check not done</span>
                    <span>Category: {event.category || 'General'}</span>
                  </span>
                </span>
                <span className="choice__arrow" aria-hidden="true">→</span>
              </Link>
            ))}
          </div>
        )}
      </section>
    </AppShell>
  )
}