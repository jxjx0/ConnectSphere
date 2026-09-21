import { Link, Route, Routes } from 'react-router-dom'

import AuthGuard from './components/AuthGuard'
import DashboardPage from './pages/DashboardPage'
import LandingPage from './pages/LandingPage'
import LoginPage from './pages/LoginPage'
import SignupAttendeePage from './pages/SignupAttendeePage'
import SignupOrganiserPage from './pages/SignupOrganiserPage'
import EquipmentProfilePage from './pages/EquipmentProfilePage'
import VenuePage from './pages/VenuePage'
import EquipmentPage from './pages/EquipmentPage'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/signup/organiser" element={<SignupOrganiserPage />} />
      <Route path="/signup/attendee" element={<SignupAttendeePage />} />
      <Route path="/login" element={<LoginPage />} />

      <Route
        path="/dashboard"
        element={
          <AuthGuard>
            <DashboardPage />
          </AuthGuard>
        }
      />

      <Route
        path="/equipment/new"
        element={
          <AuthGuard allowedRoles={['tech_support']}>
            <EquipmentProfilePage />
          </AuthGuard>
        }
      />

      <Route 
        path="/equipment" 
        element={
          <AuthGuard allowedRoles={['tech_support']}>
            <EquipmentPage />
          </AuthGuard>
        } 
      />

      <Route
        path="/venues"
        element={
          <AuthGuard allowedRoles={['venue_staff']}>
            <VenuePage />
          </AuthGuard>
        }
      />

      <Route
        path="/venues/create"
        element={
          <AuthGuard allowedRoles={['venue_staff']}>
            <VenuePage createMode />
          </AuthGuard>
        }
      />

      <Route
        path="/venues/:venueId/edit"
        element={
          <AuthGuard allowedRoles={['venue_staff']}>
            <VenuePage />
          </AuthGuard>
        }
      />

      <Route
        path="*"
        element={
          <div className="page-state">
            <p>That page does not exist.</p>
            <Link to="/">Back to ConnectSphere</Link>
          </div>
        }
      />
    </Routes>
  )
}
