import AppShell from './AppShell'
import './AttendeeLayout.css'

export default function AttendeeShell({ children }) {
  return (
    <div className="attendee-ui">
      <AppShell>
        {children}
      </AppShell>
    </div>
  )
}
