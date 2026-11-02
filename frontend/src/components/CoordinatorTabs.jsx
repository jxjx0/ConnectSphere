// A Coordinator's main pages. An event's own page counts as Events, and finding
// a venue and checking its availability count as Venue requests.

import { Link, useLocation } from 'react-router-dom'

const TABS = [
  { path: '/dashboard', label: 'Events' },
  { path: '/equipment-requests', label: 'Equipment requests' },
  { path: '/venue-requests', label: 'Venue requests' },
]

function currentTab(pathname) {
  if (pathname.startsWith('/event-reviews')) return '/dashboard'
  if (pathname.startsWith('/venues')) return '/venue-requests'
  return TABS.find((tab) => pathname.startsWith(tab.path))?.path ?? null
}

export default function CoordinatorTabs() {
  const current = currentTab(useLocation().pathname)

  return (
    <nav className="form-actions workspace-tabs" aria-label="Coordinator pages">
      {TABS.map((tab) => (
        <Link
          key={tab.path}
          to={tab.path}
          aria-current={tab.path === current ? 'page' : undefined}
          className="button button--small button--secondary"
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  )
}
