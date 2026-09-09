import { Link, Route, Routes } from 'react-router-dom'

import AuthGuard from './components/AuthGuard'
import DashboardPage from './pages/DashboardPage'
import LandingPage from './pages/LandingPage'
import LoginPage from './pages/LoginPage'
import SignupAttendeePage from './pages/SignupAttendeePage'
import SignupOrganiserPage from './pages/SignupOrganiserPage'

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
