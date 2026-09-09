// Wraps a route so only signed-in users reach it.
//
// This decides what to RENDER. It is not the security boundary -- the
// backend verifies the token on every protected request, so hiding a page
// here is convenience, not protection.

import { Navigate } from 'react-router-dom'

import { useAuth } from '../context/AuthContext'

export default function AuthGuard({ children, allowedRoles }) {
  const { user, loading } = useAuth()

  if (loading) {
    return <p className="page-state">Checking your session…</p>
  }

  if (!user) {
    return <Navigate to="/login" replace />
  }

  if (allowedRoles && !allowedRoles.includes(user.role)) {
    return (
      <p className="page-state">
        You do not have access to this page.
      </p>
    )
  }

  return children
}
