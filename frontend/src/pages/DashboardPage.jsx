// Placeholder for Sprint 0. It exists to prove the whole auth loop works:
// the user signed in, the token survived, and the backend told us who they
// are. Real dashboard content arrives in Sprint 1.

import { useNavigate } from 'react-router-dom'

import { useAuth } from '../context/AuthContext'

export default function DashboardPage() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()

  function handleLogout() {
    logout()
    navigate('/')
  }

  return (
    <main>
      <h1>Dashboard</h1>

      <p>Signed in as {user.full_name}</p>
      <p>Role: {user.role}</p>

      <button type="button" onClick={handleLogout}>
        Log out
      </button>
    </main>
  )
}
