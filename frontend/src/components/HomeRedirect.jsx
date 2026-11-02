// The page shown at /dashboard. Attendees, Technical Support and Lead
// Coordinators each work from their own tabs, so they start on the first one;
// everyone else gets the dashboard.

import { Navigate } from 'react-router-dom'

import { useAuth } from '../context/AuthContext'
import DashboardPage from '../pages/DashboardPage'

export default function HomeRedirect() {
  const { user } = useAuth()
  if (user.role === 'attendee') {
    return <Navigate to="/attendee/events" replace />
  }
  if (user.role === 'tech_support') {
    return <Navigate to="/equipment-requests" replace />
  }
  if (user.role === 'event_coordinator_lead') {
    return <Navigate to="/events/unassigned-queue" replace />
  }
  return <DashboardPage />
}
