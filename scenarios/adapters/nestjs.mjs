// NestJS adapter for the shared scenarios: plain HTTP requests to the NestJS API, the way a
// browser (or an attacker) would send them. Results in the shared shape { ok, data, error }.
// Back door (cleanup): psql against the NestJS database.
import { spawnSync } from 'node:child_process'
import { io } from 'socket.io-client'
import { rmSync } from 'node:fs'

const API = (process.env.NESTJS_URL || 'http://127.0.0.1:3000').replace(/\/$/, '')
const DB = process.env.SCENARIO_NESTJS_DB_URL || 'postgresql://booking:booking@127.0.0.1:5433/booking'

const health = await fetch(`${API}/health`).catch(() => null)
if (!health?.ok) throw new Error(`NestJS API not reachable at ${API} (npm run backend:db:start && npm run backend:dev)`)

const psql = (q) => {
  const r = spawnSync('psql', [DB, '-At', '-c', q], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`psql failed: ${r.stderr.trim()}`)
  return r.stdout.trim()
}

// A session is { token } for a logged-in user, or {} for a guest.
async function call(s, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { ...(body !== undefined && { 'Content-Type': 'application/json' }), ...(s?.token && { Authorization: `Bearer ${s.token}` }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  const json = text ? JSON.parse(text) : null
  return res.ok
    ? { ok: true, data: json, error: null }
    : { ok: false, data: null, error: { code: String(res.status), message: Array.isArray(json?.message) ? json.message.join('; ') : json?.message ?? res.statusText } }
}
const defined = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))
const asList = (r) => (r.ok ? { ...r, data: [r.data] } : r) // single changed object → "changed rows"

const run = Date.now()
const users = []

export const name = 'nestjs'
const features = new Set(['realtime', 'avatars']) // 'insertReadBack' is Supabase-only
export const has = (f) => features.has(f)

// ---- identities ----
export async function guest() {
  return {}
}
export async function signUpHost(displayName) {
  const r = await call({}, 'POST', '/auth/signup', { email: `${displayName}-${run}@test.dev`, password: 'secret123', displayName })
  if (!r.ok) throw new Error(`signup failed: ${r.error.message}`)
  users.push(r.data.user.id)
  return { id: r.data.user.id, s: { token: r.data.accessToken } }
}

// ---- slots ----
export const createSlot = (s, p) => call(s, 'POST', '/slots', defined({ hostId: p.hostId, startsAt: p.startsAt, endsAt: p.endsAt, isBooked: p.isBooked }))
export const listFreeSlots = (s, hostId) => call(s, 'GET', `/hosts/${hostId}/slots`)
export async function getSlot(s, slotId) {
  const r = await call(s, 'GET', `/slots/${slotId}`)
  return r.error?.code === '404' ? { ok: true, data: null, error: null } : r
}
export const updateSlot = async (s, slotId, patch) => asList(await call(s, 'PATCH', `/slots/${slotId}`, defined(patch)))
export const deleteSlot = async (s, slotId) => asList(await call(s, 'DELETE', `/slots/${slotId}`))

// ---- profiles ----
export const getHostProfile = (s, hostId) => call(s, 'GET', `/profiles/${hostId}`)
export const updateProfile = async (s, hostId, patch) => asList(await call(s, 'PATCH', `/profiles/${hostId}`, defined(patch)))

// ---- bookings ----
export const book = (s, { slotId, guestName, guestEmail, cancelToken, status }) =>
  call(s, 'POST', '/bookings', defined({ slotId, guestName, guestEmail, cancelToken, status }))
export const listBookings = (s) => call(s, 'GET', '/bookings')
// A host cancels the booking on their slot; there is no other way to change a booking.
export const updateBooking = async (s, slotId, patch) => asList(await call(s, 'PATCH', `/slots/${slotId}/booking`, defined(patch)))
export const deleteBooking = async (s, slotId) => asList(await call(s, 'DELETE', `/slots/${slotId}/booking`))
export async function cancelByToken(s, token) {
  const r = await call(s, 'POST', '/bookings/cancel', { cancelToken: token })
  return r.ok ? { ...r, data: r.data.cancelled } : r
}
export const bookingStatuses = (s, tokens) => call(s, 'POST', '/bookings/statuses', { cancelTokens: tokens })

// NestJS has no internal operations exposed over HTTP; this tries the obvious guess.
export const callInternal = (s) => call(s, 'POST', '/internal/sync-slot-is-booked', {})

// ---- live updates: Socket.IO namespace /slots, room per host ----
export async function subscribeSlots(hostId, onEvent) {
  const socket = io(`${API}/slots`, { transports: ['websocket'] })
  socket.on('slot_changed', onEvent)
  await new Promise((ok, fail) => {
    socket.on('connect_error', fail)
    socket.on('connect', () => socket.emit('subscribe', { hostId }, ok))
  })
  return {
    // A client trying to broadcast to the others: the server has no handler that relays it.
    sendFake: async (payload) => socket.emit('slot_changed', payload),
    close: async () => socket.disconnect(),
  }
}

// ---- avatars: files under /avatars/<hostId>/<file> ----
export async function avatarUpload(s, path, blob, { upsert = false } = {}) {
  const form = new FormData()
  form.append('file', blob, path.split('/').pop())
  const res = await fetch(`${API}/avatars/${path}${upsert ? '?upsert=true' : ''}`, {
    method: 'POST', body: form, headers: s?.token ? { Authorization: `Bearer ${s.token}` } : {},
  })
  const json = await res.json().catch(() => null)
  return res.ok ? { ok: true, data: json, error: null } : { ok: false, data: null, error: { code: String(res.status), message: json?.message ?? res.statusText } }
}
export const avatarRemove = async (s, path) => asList(await call(s, 'DELETE', `/avatars/${path}`))
export const avatarUrl = (path) => `${API}/avatars/${path}`

// ---- back door ----
export async function cleanup() {
  if (users.length) psql(`delete from users where id in (${users.map((u) => `'${u}'`).join(',')})`)
  // Deleting a user doesn't delete their files (same as Supabase Storage): remove the test folders.
  for (const u of users) rmSync(new URL(`../../backend/uploads/avatars/${u}`, import.meta.url), { recursive: true, force: true })
}
