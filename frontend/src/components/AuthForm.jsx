import { useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import SplitLayout from './SplitLayout'
import { useAuth } from '../context/AuthContext'
import { getAuthErrorField, validateAuthField, validateAuthForm } from '../authValidation.js'

const FIELD_DETAILS = {
  fullName: { label: 'Full name', autoComplete: 'name', placeholder: 'Your full name', maxLength: 120 },
  email: { label: 'Email address', type: 'email', autoComplete: 'email', placeholder: 'you@example.com' },
  organization: { label: 'Organization', autoComplete: 'organization', placeholder: 'Your organization', maxLength: 120 },
  contactNumber: { label: 'Contact number', type: 'tel', autoComplete: 'tel', placeholder: 'Your contact number', maxLength: 30 },
  password: { label: 'Password', placeholder: 'Enter your password' },
}

export default function AuthForm({ mode }) {
  const isLogin = mode === 'login'
  const isOrganiser = mode === 'organiser'
  const { login, signup } = useAuth()
  const navigate = useNavigate()
  const [values, setValues] = useState({ fullName: '', email: '', organization: '', contactNumber: '', password: '' })
  const [errors, setErrors] = useState({})
  const [error, setError] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const pending = useRef(false)
  const form = useRef(null)
  const fields = isLogin ? ['email', 'password'] : ['fullName', 'email', ...(isOrganiser ? ['organization'] : []), 'contactNumber', 'password']

  function updateField(name, value) {
    setValues((current) => ({ ...current, [name]: value }))
    setErrors((current) => ({ ...current, [name]: undefined }))
    setError('')
  }

  async function handleSubmit(event) {
    event.preventDefault()
    if (pending.current) return
    setError('')
    const nextErrors = validateAuthForm(values, mode)
    setErrors(nextErrors)
    const firstError = Object.keys(nextErrors)[0]
    if (firstError) {
      form.current?.elements.namedItem(firstError)?.focus()
      return
    }
    pending.current = true
    setSubmitting(true)
    try {
      const details = { ...values, email: values.email.trim() }
      if (isLogin) await login({ email: details.email, password: details.password })
      else await signup({ ...details, role: mode, organization: isOrganiser ? values.organization : undefined })
      navigate('/dashboard')
    } catch (caught) {
      const message = caught.message || 'Something went wrong. Please try again.'
      const field = getAuthErrorField(message, mode)
      if (field) setErrors({ [field]: message })
      else setError(message)
    } finally {
      pending.current = false
      setSubmitting(false)
    }
  }

  return (
    <SplitLayout foot={isLogin
      ? 'Staff accounts are created by the ConnectSphere team. Contact them to request access.'
      : 'One email can hold one account. Choose the role that fits you.'}>
      <form ref={form} className="form auth-form" onSubmit={handleSubmit} noValidate aria-label={isLogin ? 'Log in' : 'Create account'} aria-busy={submitting}>
        <Link to="/" className="auth-back" aria-label="Back to account options"><span aria-hidden="true">&larr;</span> Back</Link>
        <h1 className={isLogin ? undefined : 'visually-hidden'}>{isLogin ? 'Welcome back.' : isOrganiser ? 'Create an organiser account' : 'Create an attendee account'}</h1>
        {fields.map((name) => {
          const { label, ...details } = FIELD_DETAILS[name]
          const isPassword = name === 'password'
          const describedBy = [errors[name] && `${name}-error`, isPassword && !isLogin && 'password-hint'].filter(Boolean).join(' ') || undefined
          const input = <input
            {...details}
            id={name}
            name={name}
            type={isPassword ? (showPassword ? 'text' : 'password') : details.type || 'text'}
            autoComplete={isPassword ? (isLogin ? 'current-password' : 'new-password') : details.autoComplete}
            value={values[name]} disabled={submitting} required
            minLength={isPassword && !isLogin ? 8 : undefined}
            aria-invalid={Boolean(errors[name])} aria-describedby={describedBy}
            onChange={(event) => updateField(name, event.target.value)}
            onBlur={() => setErrors((current) => ({ ...current, [name]: validateAuthField(name, values[name], mode) }))} />
          return <div className="field" key={name}>
            <label htmlFor={name}>{label}</label>
            {isPassword ? (
              <div className="password">
                {input}
                <button
                  type="button"
                  className="password__toggle"
                  disabled={submitting}
                  aria-controls="password"
                  aria-pressed={showPassword}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  onClick={() => setShowPassword((shown) => !shown)}
                >
                  {showPassword ? 'Hide' : 'Show'}
                </button>
              </div>
            ) : input}
            {isPassword && !isLogin && <p className="field__hint" id="password-hint">Use 8 to 72 characters.</p>}
            {errors[name] && <p className="field__error" id={`${name}-error`} role="alert">{errors[name]}</p>}
          </div>
        })}
        {error && <p className="form-error" role="alert">{error}</p>}
        <button type="submit" className="button auth-submit" disabled={submitting}>
          {submitting ? (isLogin ? 'Logging in...' : 'Creating account...') : (isLogin ? 'Log in' : 'Create account')}
          {!submitting && <span aria-hidden="true">&rarr;</span>}
        </button>
      </form>
      <div className="form-footer">
        <p>{isLogin ? <>New to ConnectSphere? <Link to="/">Create an account</Link></> : <>Already have an account? <Link to="/login">Log in</Link></>}</p>
      </div>
    </SplitLayout>
  )
}
