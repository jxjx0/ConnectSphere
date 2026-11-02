import { Link, NavLink } from 'react-router-dom'
import './AuthLayout.css'

export default function SplitLayout({ children, foot }) {
  return (
    <div className="split auth-layout">
      <header className="auth-header">
        <Link to="/" className="auth-brand" aria-label="ConnectSphere home">
          <span className="auth-brand__mark" aria-hidden="true">c<span /></span>
          ConnectSphere<span className="auth-brand__dot">.</span>
        </Link>
        <nav aria-label="Account navigation">
          <NavLink to="/login" className="auth-nav-link">Log in</NavLink>
        </nav>
      </header>
      <aside className="rail">
        <div className="rail__top">
          <p className="auth-eyebrow"><span /> GOOD EVENTS START WITH CONNECTION.</p>
          <h2 className="auth-headline">Bring people <br />together. <br /><span>Make it happen.</span></h2>
        </div>
        {foot && <p className="rail__foot">{foot}</p>}
      </aside>
      <main className="content" id="main-content">{children}</main>
    </div>
  )
}
