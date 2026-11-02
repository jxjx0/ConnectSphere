// The ConnectSphere logo, the same on the landing page and in every role's
// navigation bar.

import { Link } from 'react-router-dom'

import './BrandLogo.css'

export default function BrandLogo({ to }) {
  return (
    <Link to={to} className="brand-logo" aria-label="ConnectSphere home">
      <span className="brand-logo__mark" aria-hidden="true">c<span /></span>
      ConnectSphere<span className="brand-logo__dot">.</span>
    </Link>
  )
}
