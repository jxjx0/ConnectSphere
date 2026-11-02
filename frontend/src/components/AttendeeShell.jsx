// Attendee workspace keeps its navigation and design separate from other roles.

import { useLocation } from 'react-router-dom'

import AppShell from './AppShell'
import AttendeeTabs from './AttendeeTabs'
import './AttendeeLayout.css'

export default function AttendeeShell({ children }) {
  const { pathname } = useLocation()
  const current = pathname.startsWith('/attendee/registrations')
    ? '/attendee/registrations' : '/attendee/events'

  return (
    <div className="attendee-ui">
      <AppShell>
        <AttendeeTabs current={current} />
        {children}
      </AppShell>
    </div>
  )
}
