import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import SplitLayout from '../components/SplitLayout'
import { useAuth } from '../context/AuthContext'

export default function LoginPage() {
  const { login } = useAuth()
  const navigate = useNavigate()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(event) {
    event.preventDefault()
    setError('')
    setSubmitting(true)

    try {
      await login({ email, password })
      navigate('/dashboard')
    } catch (caught) {
      setError(caught.message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <SplitLayout foot="Coordinator, Venue Staff and Technical Support accounts are created by the ConnectSphere team. Contact them to request access.">
      <div className="content__header">
        <h1>Log in</h1>
        <p className="lead">Use the email you signed up with.</p>
      </div>

      <section className="stack stack--tight">
        <h2 className="section-title">Credentials</h2>

        <form className="form" onSubmit={handleSubmit}>
          <div className="field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              autoFocus
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </div>

          <div className="field">
            <label htmlFor="password">Password</label>
            <div className="password">
              <input
                id="password"
                name="password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
              <button
                type="button"
                className="password__toggle"
                onClick={() => setShowPassword((shown) => !shown)}
              >
                {showPassword ? 'Hide' : 'Show'}
              </button>
            </div>
          </div>

          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}

          <div className="form-actions">
            <button type="submit" className="button" disabled={submitting}>
              {submitting ? 'Logging in…' : 'Log in'}
            </button>
          </div>
        </form>
      </section>

      <div className="form-footer">
        <p>
          Need an account?{' '}
          <Link to="/signup/organiser">Sign up as an Organiser</Link> or{' '}
          <Link to="/signup/attendee">as an Attendee</Link>
        </p>
      </div>
    </SplitLayout>
  )
}
