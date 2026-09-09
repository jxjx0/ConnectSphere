// The shell every auth page sits in: a fixed left rail carrying the product
// and the context, and a right column carrying the page's actual task.
// Shared so all five pages have the same layout instead of each inventing
// its own.

import { Link } from 'react-router-dom'

export default function SplitLayout({ children, foot }) {
  return (
    <div className="split">
      <aside className="rail">
        <div className="rail__top">
          <Link to="/" className="wordmark">
            ConnectSphere
          </Link>
          <p className="rail__blurb">
            Event planning and venue booking for organisers, coordinators and
            venue teams.
          </p>
        </div>

        {foot && <p className="rail__foot">{foot}</p>}
      </aside>

      <main className="content">{children}</main>
    </div>
  )
}
