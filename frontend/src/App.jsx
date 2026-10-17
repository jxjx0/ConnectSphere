import { Link, Route, Routes } from 'react-router-dom'

import AuthGuard from './components/AuthGuard'
import DashboardPage from './pages/DashboardPage'
import LandingPage from './pages/LandingPage'
import LoginPage from './pages/LoginPage'
import SignupAttendeePage from './pages/SignupAttendeePage'
import SignupOrganiserPage from './pages/SignupOrganiserPage'
import EquipmentProfilePage from './pages/EquipmentProfilePage'
import EventRequestPage from './pages/EventRequestPage'
import EventChangeRequestPage from './pages/EventChangeRequestPage'
import MyEventDetailPage from './pages/MyEventDetailPage'
import MyEventsPage from './pages/MyEventsPage'
import VenuePage from './pages/VenuePage'
import VenueSearchPage from './pages/VenueSearchPage'
import VenueAvailabilityPage from './pages/VenueAvailabilityPage'
import EquipmentPage from './pages/EquipmentPage'
import EquipmentBookingsPage from './pages/EquipmentBookingsPage'
import EventReviewDetailPage from './pages/EventReviewDetailPage'
import EquipmentRequestsPage from './pages/EquipmentRequestsPage'

export default function App() {
  return (
    <Routes>
      <Route path="/venues/availability" element={
        <AuthGuard allowedRoles={['venue_staff', 'coordinator']}>
          <VenueAvailabilityPage />
        </AuthGuard>
      } />
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
        path="/my-events"
        element={
          <AuthGuard allowedRoles={['organiser']}>
            <MyEventsPage />
          </AuthGuard>
        }
      />

      <Route
        path="/my-events/new"
        element={
          <AuthGuard allowedRoles={['organiser']}>
            <EventRequestPage />
          </AuthGuard>
        }
      />

      <Route
        path="/my-events/drafts/:draftId"
        element={
          <AuthGuard allowedRoles={['organiser']}>
            <EventRequestPage />
          </AuthGuard>
        }
      />

      <Route
        path="/my-events/:eventId"
        element={
          <AuthGuard allowedRoles={['organiser']}>
            <MyEventDetailPage />
          </AuthGuard>
        }
      />

      <Route
        path="/event-reviews/:eventId"
        element={
          <AuthGuard allowedRoles={['coordinator']}>
            <EventReviewDetailPage />
          </AuthGuard>
        }
      />

      <Route
        path="/my-events/:eventId/change-request"
        element={
          <AuthGuard allowedRoles={['organiser']}>
            <EventChangeRequestPage />
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
        path="/equipment/:equipmentId/bookings"
        element={
          <AuthGuard allowedRoles={['tech_support']}>
            <EquipmentBookingsPage />
          </AuthGuard>
        }
      />

      <Route
        path="/equipment-requests"
        element={
          <AuthGuard allowedRoles={['coordinator', 'tech_support']}>
            <EquipmentRequestsPage />
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
        path="/venues/search"
        element={
          <AuthGuard allowedRoles={['coordinator']}>
            <VenueSearchPage />
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
