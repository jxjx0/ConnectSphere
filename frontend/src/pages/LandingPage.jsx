import { Link } from 'react-router-dom'

export default function LandingPage() {
  return (
    <main>
      <h1>ConnectSphere</h1>
      <p>Event planning and venue booking.</p>

      <ul>
        <li>
          <Link to="/signup/organiser">Sign up as an Event Organiser</Link>
        </li>
        <li>
          <Link to="/signup/attendee">Sign up as an Attendee</Link>
        </li>
        <li>
          <Link to="/login">Log in</Link>
        </li>
      </ul>

      <p>
        Coordinator, Venue Staff and Technical Support accounts are created by
        the ConnectSphere team.
      </p>
    </main>
  )
}
