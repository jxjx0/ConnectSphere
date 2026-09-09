// Holds the logged-in user for the whole app, so any page can ask "who is
// signed in?" without passing props down through every component.

import { createContext, useContext, useEffect, useState } from 'react'

import * as authApi from '../api/auth'

const TOKEN_KEY = 'connectsphere.token'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY))
  const [user, setUser] = useState(null)
  // True until we know whether the stored token is still valid. Without
  // this, a page refresh would flash the login screen before the check
  // finishes.
  const [loading, setLoading] = useState(true)

  // Runs once, on page load. If a token was left in localStorage from a
  // previous visit, ask the backend who it belongs to -- a token that has
  // expired or been tampered with fails here and we sign the user out.
  // Logging in afterwards sets the user directly, so this does not re-run.
  useEffect(() => {
    const storedToken = localStorage.getItem(TOKEN_KEY)
    if (!storedToken) {
      setLoading(false)
      return
    }

    authApi
      .getMe(storedToken)
      .then((data) => setUser(data.profile))
      .catch(() => {
        localStorage.removeItem(TOKEN_KEY)
        setToken(null)
        setUser(null)
      })
      .finally(() => setLoading(false))
  }, [])

  function saveSession({ access_token, profile }) {
    localStorage.setItem(TOKEN_KEY, access_token)
    setToken(access_token)
    setUser(profile)
  }

  async function signup(details) {
    saveSession(await authApi.signup(details))
  }

  async function login(credentials) {
    saveSession(await authApi.login(credentials))
  }

  function logout() {
    localStorage.removeItem(TOKEN_KEY)
    setToken(null)
    setUser(null)
  }

  const value = { user, token, loading, signup, login, logout }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

// Every component reads auth state through this hook.
export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used inside an AuthProvider')
  }
  return context
}
