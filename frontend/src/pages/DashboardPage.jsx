// Placeholder for Sprint 0. It exists to prove the whole auth loop works:
// the user signed in, the token survived, and the backend told us who they
// are. Real dashboard content arrives in Sprint 1.

import AppShell from '../components/AppShell'
import { useAuth } from '../context/AuthContext'

// Roles arrive as 'venue_staff'; people read "Venue staff".
function readableRole(role) {
  const words = role.replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export default function DashboardPage() {
  const { user } = useAuth()

  return (
    <AppShell>
      <div className="content__header">
        <h1>Dashboard</h1>
        <p className="lead">
          You are signed in. Events, venues and bookings arrive in the next
          release.
        </p>
      </div>

      <section className="stack stack--tight">
        <h2 className="section-title">Your account</h2>

        <dl className="detail-list">
          <div className="detail-list__row">
            <dt>Name</dt>
            <dd>{user.full_name}</dd>
          </div>
          <div className="detail-list__row">
            <dt>Role</dt>
            <dd>
              <span className="tag">{readableRole(user.role)}</span>
            </dd>
          </div>
        </dl>
      </section>
    </AppShell>
  )
}
