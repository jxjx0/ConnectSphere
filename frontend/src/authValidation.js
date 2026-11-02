import { validateContactNumber, validateFullName, validateOrganization } from './validation.js'

export function validateAuthField(name, value, mode) {
  if (name === 'email') {
    if (!value.trim()) return 'Enter your email address.'
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) return 'Enter a valid email address.'
  }
  if (name === 'password') {
    if (!value) return 'Enter your password.'
    if (mode !== 'login' && (value.length < 8 || value.length > 72)) {
      return 'Use between 8 and 72 characters.'
    }
  }
  if (name === 'fullName') {
    return validateFullName(value) || (value.trim().length > 120 ? 'Use 120 characters or fewer.' : null)
  }
  if (name === 'contactNumber') return validateContactNumber(value)
  if (name === 'organization') return validateOrganization(value)
  return null
}

export function validateAuthForm(values, mode) {
  const fields = mode === 'login' ? ['email', 'password'] : [
    'fullName', 'email', ...(mode === 'organiser' ? ['organization'] : []), 'contactNumber', 'password',
  ]
  return Object.fromEntries(fields.map((name) => [name, validateAuthField(name, values[name], mode)]).filter(([, error]) => error))
}

// The current API returns plain messages rather than field paths.
export function getAuthErrorField(message, mode) {
  if (mode !== 'login' && /already (registered|exists)/i.test(message)) return 'email'
  if (/invalid email or password/i.test(message)) return null
  if (/email.*(invalid|valid|format)/i.test(message)) return 'email'
  if (mode !== 'login' && /password.*(characters|length|weak|short)/i.test(message)) return 'password'
  return null
}
