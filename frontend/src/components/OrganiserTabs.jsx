// An Organiser's main pages. Continuing a draft counts as New event, and an
// event's own pages count as My events.

import { Link, useLocation } from 'react-router-dom'

const TABS = [
  { path: '/my-events', label: 'My events' },
  { path: '/my-events/new', label: 'New event' },
]

function currentTab(pathname) {
  if (pathname.startsWith('/my-events/new') || pathname.startsWith('/my-events/drafts')) {
    return '/my-events/new'
  }
  return pathname.startsWith('/my-events') ? '/my-events' : null
}

export default function OrganiserTabs() {
  const current = currentTab(useLocation().pathname)

  return (
    <nav className="form-actions workspace-tabs" aria-label="Organiser pages">
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
