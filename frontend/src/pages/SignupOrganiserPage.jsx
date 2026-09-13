import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import SplitLayout from '../components/SplitLayout'
import { useAuth } from '../context/AuthContext'
import { validateContactNumber, validateFullName, validateOrganization } from '../validation'

export default function SignupOrganiserPage() {
  const { signup } = useAuth()
  const navigate = useNavigate()

  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [contactNumber, setContactNumber] = useState('')
  const [organization, setOrganization] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(event) {
    event.preventDefault()
    setError('')

    const validationError =
      validateFullName(fullName) ||
      validateOrganization(organization) ||
      validateContactNumber(contactNumber)
    if (validationError) {
      setError(validationError)
      return
    }

    setSubmitting(true)

    try {
      await signup({ fullName, email, password, role: 'organiser', contactNumber, organization })
      navigate('/dashboard')
    } catch (caught) {
      setError(caught.message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <SplitLayout foot="One email can hold one account. If you already have an Attendee account, use a different email.">
      <div className="content__header">
        <h1>Sign up as an Event Organiser</h1>
        <p className="lead">
          Plan events, book venues, and track their progress.
        </p>
      </div>

      <section className="stack stack--tight">
        <h2 className="section-title">Your details</h2>

        <form className="form" onSubmit={handleSubmit}>
          <div className="field">
            <label htmlFor="fullName">Full name</label>
            <input
              id="fullName"
              name="fullName"
              autoComplete="name"
              autoFocus
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
              required
            />
          </div>

          <div className="field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </div>

          <div className="field">
            <label htmlFor="organization">Organization</label>
            <input
              id="organization"
              name="organization"
              autoComplete="organization"
              maxLength={120}
              value={organization}
              onChange={(event) => setOrganization(event.target.value)}
              required
            />
          </div>

          <div className="field">
            <label htmlFor="contactNumber">Contact number</label>
            <input
              id="contactNumber"
              name="contactNumber"
              type="tel"
              autoComplete="tel"
              maxLength={30}
              value={contactNumber}
              onChange={(event) => setContactNumber(event.target.value)}
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
                autoComplete="new-password"
                minLength={8}
                aria-describedby="password-hint"
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
            <p className="field__hint" id="password-hint">
              At least 8 characters.
            </p>
          </div>

          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}

          <div className="form-actions">
            <button type="submit" className="button" disabled={submitting}>
              {submitting ? 'Creating account…' : 'Create account'}
            </button>
          </div>
        </form>
      </section>

      <div className="form-footer">
        <p>
          Signing up to attend events instead?{' '}
          <Link to="/signup/attendee">Create an Attendee account</Link>
        </p>
        <p>
          Already have an account? <Link to="/login">Log in</Link>
        </p>
      </div>
    </SplitLayout>
  )
}
