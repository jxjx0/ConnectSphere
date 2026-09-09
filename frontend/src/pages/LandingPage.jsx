import { Link } from 'react-router-dom'

import SplitLayout from '../components/SplitLayout'

export default function LandingPage() {
  return (
    <SplitLayout
      foot="Coordinator, Venue Staff and Technical Support accounts are created by the ConnectSphere team. Contact them to request access."
    >
      <div className="content__header">
        <h1>Get started</h1>
        <p className="lead">
          Choose the type of account you need. You can only hold one.
        </p>
      </div>

      <section className="stack stack--tight">
        <h2 className="section-title">Create an account</h2>

        <ul className="choices">
          <li>
            <Link to="/signup/organiser" className="choice">
              <span className="choice__text">
                <span className="choice__title">Event Organiser</span>
                <span className="choice__description">
                  Plan events, book venues, and track their progress.
                </span>
              </span>
              <span className="choice__arrow" aria-hidden="true">
                →
              </span>
            </Link>
          </li>
          <li>
            <Link to="/signup/attendee" className="choice">
              <span className="choice__text">
                <span className="choice__title">Attendee</span>
                <span className="choice__description">
                  Browse events and register to attend.
                </span>
              </span>
              <span className="choice__arrow" aria-hidden="true">
                →
              </span>
            </Link>
          </li>
        </ul>
      </section>

      <p className="note">
        Already registered? <Link to="/login">Log in</Link>
      </p>
    </SplitLayout>
  )
}
