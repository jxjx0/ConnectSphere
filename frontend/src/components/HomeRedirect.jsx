// The page shown at /dashboard. Attendees only browse and register for
// events, so the events list is their home page; everyone else gets the
// dashboard.

import { Navigate } from 'react-router-dom'

import { useAuth } from '../context/AuthContext'
import DashboardPage from '../pages/DashboardPage'

export default function HomeRedirect() {
  const { user } = useAuth()
  if (user.role === 'attendee') {
    return <Navigate to="/attendee/events" replace />
  }
  return <DashboardPage />
}
