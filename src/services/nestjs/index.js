// NestJS implementation of the service functions (same names as src/services/supabase/).
// HTTP + login session: ./http.js. Data is converted to the row shapes the pages already use
// (snake_case, as Supabase returns them), so the pages don't change between backends.
//
// Errors: the pages' error vocabulary is Postgres codes (inherited from the Supabase version:
// 42501 = not allowed / slot taken, 23514 = invalid input, 22P02 = malformed id). HTTP statuses
// from NestJS are translated into those codes where a page checks for one.
import { io } from 'socket.io-client'
import * as http from './http'

// ---- what this backend can do (pages hide the rest) ----
export const capabilities = {
  avatars: true, realtime: true, captcha: false, signatures: false, auditHistory: false, reminders: false, probes: false,
}

// ---- helpers ----
const toError = (e, codes = {}) =>
  e instanceof http.ApiError ? { code: codes[e.status] ?? `http_${e.status}`, message: e.message, status: e.status } : { code: 'network', message: e.message }
const slotRow = (s) => ({ id: s.id, starts_at: s.startsAt, ends_at: s.endsAt, is_booked: s.isBooked })
const bookingRow = (b) => ({
  id: b.id, guest_name: b.guestName, guest_email: b.guestEmail, status: b.status,
  signature_status: null, created_at: b.createdAt, cancelled_at: b.cancelledAt,
})
const notBuilt = (what) => async () => {
  throw new Error(`${what} is not built in the NestJS version yet`)
}

// ---- login ----
export const auth = {
  async getSession() {
    return http.getSession()
  },
  onChange(callback) {
    http.onSessionChange(callback)
  },
  async signUp({ email, password, displayName }) {
    await http.signup(email, password, displayName)
    return { needsConfirmation: false }
  },
  async signIn({ email, password }) {
    await http.login(email, password)
  },
  async signOut() {
    await http.logout()
  },
}

// ---- profiles ----
export async function getPublicProfile(hostId) {
  try {
    const p = await http.request(`/profiles/${hostId}`, { auth: false })
    return { display_name: p.displayName, avatar_path: p.avatarPath, require_captcha: false }
  } catch {
    return null // no such host, or a malformed id
  }
}

export async function getHostProfile(hostId) {
  const p = await getPublicProfile(hostId)
  return p && { display_name: p.display_name }
}

export async function getMyProfile(userId) {
  const p = await http.request(`/profiles/${userId}`)
  return { display_name: p.displayName, avatar_path: p.avatarPath }
}

export async function updateMyProfile(userId, fields) {
  const body = { displayName: fields.display_name, avatarPath: fields.avatar_path }
  const p = await http.request(`/profiles/${userId}`, { method: 'PATCH', body })
  return { display_name: p.displayName, avatar_path: p.avatarPath }
}

// ---- avatars: files on the API server, /avatars/<hostId>/<file> ----
export async function uploadAvatar(path, file) {
  const form = new FormData()
  form.append('file', file)
  await http.request(`/avatars/${path}`, { method: 'POST', body: form })
}

// Best effort, like the Supabase version.
export async function removeAvatar(path) {
  await http.request(`/avatars/${path}`, { method: 'DELETE' }).catch(() => {})
}

export const avatarUrl = (path) => (path ? `${http.BASE_URL}/avatars/${path}` : null)

// ---- slots ----
// The guest view (free, future), also when a host looks at their own booking page.
export async function listFreeSlots(hostId) {
  const slots = await http.request(`/hosts/${hostId}/slots`, { auth: false })
  return slots.map(slotRow).map(({ id, starts_at, ends_at }) => ({ id, starts_at, ends_at }))
}

// The host's slots with their bookings: two requests, joined here (Supabase: one query with an embed).
export async function listDashboardSlots(hostId) {
  try {
    const [slots, bookings] = await Promise.all([http.request(`/hosts/${hostId}/slots`), http.request('/bookings')])
    const bySlot = Map.groupBy(bookings, (b) => b.slotId)
    return { data: slots.map((s) => ({ ...slotRow(s), bookings: (bySlot.get(s.id) ?? []).map(bookingRow) })), error: null }
  } catch (e) {
    return { data: null, error: toError(e) }
  }
}

export async function createSlot({ hostId, startsAt, endsAt }) {
  try {
    await http.request('/slots', { method: 'POST', body: { hostId, startsAt, endsAt } })
    return { error: null }
  } catch (e) {
    return { error: toError(e) }
  }
}

// 409 (booked) or 404 (gone): nothing deleted, same as Supabase's "0 rows".
export async function deleteSlot(slotId) {
  try {
    await http.request(`/slots/${slotId}`, { method: 'DELETE' })
    return { error: null, deleted: true }
  } catch (e) {
    return [404, 409].includes(e.status) ? { error: null, deleted: false } : { error: toError(e), deleted: false }
  }
}

// The NestJS API addresses a booking through its slot (one active booking per slot).
export async function cancelBookingAsHost({ slotId }) {
  try {
    await http.request(`/slots/${slotId}/booking`, { method: 'PATCH', body: { status: 'cancelled' } })
    return { error: null, cancelled: true }
  } catch (e) {
    return e.status === 404 ? { error: null, cancelled: false } : { error: toError(e), cancelled: false }
  }
}

// ---- guests ----
// The browser makes the cancel token (same as the Supabase version). The CAPTCHA (feature 3)
// isn't built here yet, so captchaToken is ignored.
export async function bookSlot({ slotId, guestName, guestEmail, cancelToken }) {
  try {
    await http.request('/bookings', { method: 'POST', body: { slotId, guestName, guestEmail, cancelToken } })
    return { error: null }
  } catch (e) {
    return { error: toError(e, { 409: '42501', 400: '23514' }) }
  }
}

export async function cancelBookingByToken(token) {
  try {
    const r = await http.request('/bookings/cancel', { method: 'POST', body: { cancelToken: token }, auth: false })
    return { ok: r.cancelled, error: null }
  } catch (e) {
    return { ok: false, error: toError(e, { 400: '22P02' }) }
  }
}

export async function getBookingStatuses(tokens) {
  try {
    const rows = await http.request('/bookings/statuses', { method: 'POST', body: { cancelTokens: tokens }, auth: false })
    return { data: rows.map((r) => ({ cancel_token: r.cancelToken, status: r.status })), error: null }
  } catch (e) {
    return { data: null, error: toError(e) }
  }
}

// ---- live updates: Socket.IO namespace /slots, one room per host ----
// The server sends { id, startsAt, endsAt, available }; the pages expect starts_at / ends_at.
// "connect" also fires after a reconnect: subscribe again and let the page refetch (events sent
// while disconnected are not replayed, same as Supabase Realtime).
export function subscribeSlots(hostId, { onChange, onSync }) {
  const socket = io(`${http.BASE_URL}/slots`, { transports: ['websocket'] })
  socket.on('connect', () => socket.emit('subscribe', { hostId }, () => onSync?.()))
  socket.on('slot_changed', (e) => onChange({ id: e.id, starts_at: e.startsAt, ends_at: e.endsAt, available: e.available }))
  socket.on('connect_error', (err) => console.warn('Live updates:', err.message))
  return () => socket.disconnect()
}

// ---- advanced features (built later, one by one) ----
export const listHostSlots = notBuilt('The recurring-bookings probe')
export const recurringStrategies = []
export const bookRecurring = notBuilt('Recurring bookings')
export const bookSlotLogged = notBuilt('The audit-log probe')
export const cancelAsGuestLogged = notBuilt('The audit-log probe')
export const cancelAsHostLogged = notBuilt('The audit-log probe')
export const deleteSlotLogged = notBuilt('The audit-log probe')
export const logAuditEventFromClient = notBuilt('The audit-log probe')
export const listAuditHistory = notBuilt('The history page')
export const getSignatureRequirement = notBuilt('Signed agreements')
export const setSignatureRequirement = notBuilt('Signed agreements')
export const checkSignatureStatus = notBuilt('Signed agreements')
export const getCaptchaRequirement = notBuilt('The CAPTCHA setting')
export const setCaptchaRequirement = notBuilt('The CAPTCHA setting')
export const unsubscribeReminders = notBuilt('Reminder emails')
