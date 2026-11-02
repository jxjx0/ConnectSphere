// Every venue request across a Coordinator's events, grouped by event. New
// requests start from the event, so this page only keeps track of them.

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

import { getAssignedEventRequests } from '../api/events'
import { getVenueBookingsForEvent } from '../api/venues'
import AppShell from '../components/AppShell'
import OngoingPastTabs from '../components/OngoingPastTabs'
import VenueBookingCard from '../components/VenueBookingCard'
import { useAuth } from '../context/AuthContext'
import { isPastVenueRequest } from '../coordinatorEventView'

export default function CoordinatorVenueRequestsPage() {
  const { token } = useAuth()
  const [groups, setGroups] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [partialError, setPartialError] = useState('')
  const [view, setView] = useState('ongoing')

  useEffect(() => {
    let active = true
    getAssignedEventRequests(token)
      .then(async ({ events }) => {
        const withVenues = events.filter((event) => (event.venue_bookings || []).length > 0)
        const results = await Promise.all(withVenues.map((event) => (
          getVenueBookingsForEvent(event.id, token)
            .then((data) => ({ event, bookings: data.bookings || [] }))
            .catch(() => ({ event, bookings: [], failed: true }))
        )))
        if (!active) return
        setGroups(results)
        if (results.some((result) => result.failed)) {
          setPartialError('Some events\' venue requests could not be loaded. Refresh to try again.')
        }
      })
      .catch((caught) => {
        if (active) setError(caught.message)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [token])

  const inView = (phase) => groups
    .map(({ event, bookings }) => ({
      event,
      bookings: bookings.filter((booking) => (
        isPastVenueRequest(booking, event) === (phase === 'past')
      )),
    }))
    .filter((group) => group.bookings.length > 0)
  const count = (phase) => inView(phase).reduce((sum, group) => sum + group.bookings.length, 0)
  const shown = inView(view)

  return (
    <AppShell>
      <div className="content">
        <div className="content__header">
          <h1>Venue requests</h1>
          <p className="lead">Track the venues requested for your events. To request one, open the event.</p>
        </div>

        {loading && <p className="note">Loading venue requests…</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        {partialError && <p className="form-error" role="alert">{partialError}</p>}

        {!loading && !error && (
          <OngoingPastTabs view={view} onChange={setView} ongoing={count('ongoing')} past={count('past')} />
        )}

        {!loading && !error && shown.length === 0 && (
          <p className="note">
            {view === 'ongoing' ? 'You have no ongoing venue requests.' : 'You have no past venue requests.'}
          </p>
        )}

        {shown.map(({ event, bookings }) => (
          <section className="stack stack--tight" key={event.id}>
            <h2 className="section-title">
              <Link to={`/event-reviews/${encodeURIComponent(event.id)}`}>{event.name}</Link>
            </h2>
            {bookings.map((booking) => <VenueBookingCard booking={booking} key={booking.booking_id} />)}
          </section>
        ))}
      </div>
    </AppShell>
  )
}
