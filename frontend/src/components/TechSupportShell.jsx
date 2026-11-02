// Technical Support's workspace keeps its navigation and design separate from
// other roles, as the attendee workspace does.

import { Link, useLocation } from 'react-router-dom'

import AppShell from './AppShell'
import './TechSupportLayout.css'

const TABS = [
  { path: '/equipment-requests', label: 'Requests' },
  { path: '/equipment', label: 'Catalogue' },
  { path: '/equipment/bookings', label: 'Shared bookings' },
]

function currentTab(pathname) {
  if (pathname.startsWith('/equipment-requests')) return '/equipment-requests'
  if (pathname === '/equipment/bookings') return '/equipment/bookings'
  if (pathname.startsWith('/equipment')) return '/equipment'
  return null
}

export default function TechSupportShell({ children }) {
  const current = currentTab(useLocation().pathname)

  return (
    <div className="tech-ui">
      <AppShell>
        <nav className="form-actions tech-tabs" aria-label="Technical Support pages">
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
        {children}
      </AppShell>
    </div>
  )
}
