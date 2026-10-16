// src/services/nestjs/http.js
// Minimal HTTP client for the NestJS backend.
// - Sends "Authorization: Bearer <accessToken>" when logged in
// - Keeps the session from /auth/login in localStorage
// - On a 401, calls /auth/refresh once (shared across parallel requests) and retries
//
// Note for the blog: tokens in localStorage are readable by any script on the page (XSS risk).
// Supabase's JS client stores its session in localStorage too, so this keeps the comparison fair.
// A production NestJS app would usually put the refresh token in an httpOnly cookie instead.

// 127.0.0.1, not localhost: the API listens on 127.0.0.1 only, and on macOS "localhost" may
// resolve to the IPv6 address first.
const BASE_URL = (import.meta.env.VITE_NESTJS_URL || 'http://127.0.0.1:3000').replace(/\/$/, '')
const STORAGE_KEY = 'nestjs.session'

// ---------- session storage ----------

function readSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function writeSession(session) {
  try {
    if (session) localStorage.setItem(STORAGE_KEY, JSON.stringify(session))
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    // storage unavailable (private mode etc.): session lives only in memory for this page
  }
  current = session
  listeners.forEach((fn) => {
    try { fn(session) } catch { /* ignore listener errors */ }
  })
}

let current = readSession()
const listeners = new Set()

/** Current session: { accessToken, refreshToken, user } or null */
export function getSession() {
  return current
}

/** Subscribe to login/logout/refresh changes. Returns an unsubscribe function. */
export function onSessionChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

// Keep tabs in sync: logging out in one tab logs out the others
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY) {
      current = readSession()
      listeners.forEach((fn) => { try { fn(current) } catch {} })
    }
  })
}

// ---------- errors ----------

export class ApiError extends Error {
  constructor(status, body) {
    super((body && (body.message || body.error)) || `Request failed with status ${status}`)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
}

async function parseBody(res) {
  if (res.status === 204) return null
  const text = await res.text()
  if (!text) return null
  try { return JSON.parse(text) } catch { return text }
}

// ---------- refresh (single-flight) ----------

let refreshPromise = null

// One refresh at a time across all tabs of this site (falls back to no lock where unsupported).
function withRefreshLock(fn) {
  return typeof navigator !== 'undefined' && navigator.locks
    ? navigator.locks.request('nestjs-session-refresh', fn)
    : fn()
}

async function refreshSession() {
  const session = current
  if (!session?.refreshToken) throw new ApiError(401, { message: 'Not logged in' })

  // If several requests get a 401 at once, they all wait for the same refresh call.
  // The backend replaces the refresh token on every use and treats a second use of an old one
  // as theft (logs out everywhere), so tabs must not refresh at the same time either: the Web
  // Locks API serialises them, and inside the lock we first check whether another tab already
  // refreshed (localStorage then holds a different refresh token) and just take its tokens.
  if (!refreshPromise) {
    refreshPromise = withRefreshLock(async () => {
      const stored = readSession()
      if (stored?.refreshToken && stored.refreshToken !== session.refreshToken) {
        writeSession(stored)
        return stored
      }
      const res = await fetch(`${BASE_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: session.refreshToken }),
      })
      const body = await parseBody(res)
      if (!res.ok) {
        writeSession(null) // refresh token expired or revoked: log out
        throw new ApiError(res.status, body)
      }
      // Keep fields the refresh response doesn't return (e.g. user)
      const next = { ...session, ...body }
      writeSession(next)
      return next
    }).finally(() => {
      refreshPromise = null
    })
  }
  return refreshPromise
}

// ---------- main request function ----------

/**
 * Call the NestJS API.
 * @param {string} path   e.g. '/slots'
 * @param {object} opts   { method, body, auth (default true), headers }
 *                        body: plain object (sent as JSON) or FormData (for uploads)
 */
export async function request(path, { method = 'GET', body, auth = true, headers = {} } = {}) {
  let usedToken
  const send = async () => {
    const h = { ...headers }
    usedToken = current?.accessToken
    let payload
    if (body instanceof FormData) {
      payload = body // browser sets the multipart Content-Type itself
    } else if (body !== undefined) {
      h['Content-Type'] = 'application/json'
      payload = JSON.stringify(body)
    }
    if (auth && current?.accessToken) h.Authorization = `Bearer ${current.accessToken}`
    return fetch(`${BASE_URL}${path}`, { method, headers: h, body: payload })
  }

  let res = await send()

  // Access token expired: refresh once, then retry once
  // (If another request already refreshed meanwhile, just retry with the newer token.)
  if (res.status === 401 && auth && current?.refreshToken && path !== '/auth/refresh') {
    if (current.accessToken === usedToken) await refreshSession()
    res = await send()
  }

  const data = await parseBody(res)
  if (!res.ok) throw new ApiError(res.status, data)
  return data
}

// ---------- auth helpers ----------

export async function login(email, password) {
  const session = await request('/auth/login', {
    method: 'POST',
    body: { email, password },
    auth: false,
  })
  writeSession(session) // expects { accessToken, refreshToken, user }
  return session
}

// Same answer shape as /auth/login: the new account is logged in straight away
// (no email confirmation in the NestJS version).
export async function signup(email, password, displayName) {
  const session = await request('/auth/signup', {
    method: 'POST',
    body: { email, password, displayName },
    auth: false,
  })
  writeSession(session)
  return session
}

export async function logout() {
  const session = current
  writeSession(null)
  if (session?.refreshToken) {
    // Best effort: ask the server to revoke the refresh token
    try {
      await request('/auth/logout', {
        method: 'POST',
        body: { refreshToken: session.refreshToken },
        auth: false,
      })
    } catch {
      // ignore: the local session is already cleared
    }
  }
}

export { BASE_URL }