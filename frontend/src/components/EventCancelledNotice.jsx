export default function EventCancelledNotice({ hasRegistration = false }) {
  return (
    <div className="attendee-cancelled-notice" role="status">
      <div>
        <strong>Event cancelled</strong>
        <p>This event will no longer take place. Registration is closed.</p>
        {hasRegistration && <p>Your registration is kept for your records.</p>}
      </div>
    </div>
  )
}
