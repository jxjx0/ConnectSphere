// Switches between the Attendee's two lists: events open for registration
// and the events they have registered for.

import { Link } from 'react-router-dom'

const TABS = [
  { path: '/attendee/events', label: 'Events' },
  { path: '/attendee/registrations', label: 'My registrations' },
]

export default function AttendeeTabs({ current }) {
  return (
    <nav className="form-actions attendee-tabs" aria-label="Attendee pages">
      {TABS.map((tab) => (
        <Link
          key={tab.path}
          to={tab.path}
          aria-current={tab.path === current ? 'page' : undefined}
          className={tab.path === current
            ? 'button button--small'
            : 'button button--small button--secondary'}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  )
}
