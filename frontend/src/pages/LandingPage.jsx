import { Link } from 'react-router-dom'

import SplitLayout from '../components/SplitLayout'

export default function LandingPage() {
  return (
    <SplitLayout
      foot="Coordinator, Venue Staff and Technical Support accounts are created by the ConnectSphere team. Contact them to request access."
    >
      <div className="content__header">
        <p className="auth-eyebrow">WELCOME TO CONNECTSPHERE</p>
        <h1>Your next connection<br />starts here.</h1>
        <p className="lead">
          Great events begin with you. Choose how you want to get involved.
        </p>
      </div>

      <section className="stack stack--tight">
        <h2 className="section-title">Find your place</h2>

        <ul className="choices">
          <li>
            <Link to="/signup/organiser" className="choice">
              <span className="choice__text">
                <span className="choice__badge" aria-hidden="true">01 / CREATE</span>
                <span className="choice__title">I'm an event organiser</span>
                <span className="choice__description">
                  Plan events, book venues, and track their progress.
                </span>
              </span>
              <span className="choice__arrow" aria-hidden="true">
                &rarr;
              </span>
            </Link>
          </li>
          <li>
            <Link to="/signup/attendee" className="choice">
              <span className="choice__text">
                <span className="choice__badge" aria-hidden="true">02 / DISCOVER</span>
                <span className="choice__title">I'm here to attend</span>
                <span className="choice__description">
                  Browse events and register to attend.
                </span>
              </span>
              <span className="choice__arrow" aria-hidden="true">
                &rarr;
              </span>
            </Link>
          </li>
        </ul>
      </section>

      <p className="auth-account-note">One email, one account. Pick the role that fits you.</p>
      <p className="note">
        Already registered? <Link to="/login">Log in</Link>
      </p>
    </SplitLayout>
  )
}
