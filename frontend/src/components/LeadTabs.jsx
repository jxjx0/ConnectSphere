// A Lead Coordinator's main pages: what needs assigning, then everything else.

import { Link, useLocation } from 'react-router-dom'

const TABS = [
  { path: '/events/unassigned-queue', label: 'Unassigned events' },
  { path: '/lead/dashboard', label: 'All events' },
]

export default function LeadTabs() {
  const { pathname } = useLocation()

  return (
    <nav className="form-actions workspace-tabs" aria-label="Lead Coordinator pages">
      {TABS.map((tab) => (
        <Link
          key={tab.path}
          to={tab.path}
          aria-current={pathname.startsWith(tab.path) ? 'page' : undefined}
          className="button button--small button--secondary"
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  )
}
