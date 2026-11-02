// A Safety Officer's three lists. An event's own page counts as To review
// unless it was opened from another list.

import { Link, useLocation, useSearchParams } from 'react-router-dom'

export const SAFETY_TABS = [
  { id: 'to-review', label: 'To review' },
  { id: 'reviewed', label: 'Reviewed' },
  { id: 'no-longer-needed', label: 'No longer needed' },
]

export function safetyTabFrom(value) {
  return SAFETY_TABS.some((tab) => tab.id === value) ? value : SAFETY_TABS[0].id
}

export default function SafetyTabs() {
  const { pathname } = useLocation()
  const [searchParams] = useSearchParams()
  const current = safetyTabFrom(searchParams.get(pathname === '/safetyreview' ? 'tab' : 'from'))

  return (
    <nav className="form-actions workspace-tabs" aria-label="Safety Officer pages">
      {SAFETY_TABS.map((tab) => (
        <Link
          key={tab.id}
          to={tab.id === SAFETY_TABS[0].id ? '/safetyreview' : `/safetyreview?tab=${tab.id}`}
          aria-current={tab.id === current ? 'page' : undefined}
          className="button button--small button--secondary"
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  )
}
