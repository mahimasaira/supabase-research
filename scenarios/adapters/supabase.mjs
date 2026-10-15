// Supabase adapter for the shared scenarios: the requests a browser can send with the
// publishable key (supabase-js), including the ones an attacker would try. Results are turned
// into the shared shape { ok, data, error } with camelCase fields.
// Back door (setup/cleanup): psql as the database owner, like the proof scripts.
import { createClient } from '@supabase/supabase-js'
import { spawnSync } from 'node:child_process'

const URL = process.env.VITE_SUPABASE_URL
const KEY = process.env.VITE_SUPABASE_ANON_KEY
const DB = process.env.SCENARIO_SUPABASE_DB_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
if (!URL || !KEY) throw new Error('VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY missing (run with --env-file=.env.local)')

const client = () => createClient(URL, KEY, { auth: { persistSession: false } })
const psql = (q) => {
  const r = spawnSync('psql', [DB, '-At', '-c', q], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`psql failed: ${r.stderr.trim()}`)
  return r.stdout.trim()
}

// supabase-js result → { ok, data, error }
const wrap = (r, map = (x) => x) => (r.error
  ? { ok: false, data: null, error: { code: r.error.code ?? String(r.status), message: r.error.message } }
  : { ok: true, data: Array.isArray(r.data) ? r.data.map(map) : r.data == null ? r.data : map(r.data), error: null })
const slot = (s) => ({ id: s.id, hostId: s.host_id, startsAt: s.starts_at, endsAt: s.ends_at, isBooked: s.is_booked })
const booking = (b) => ({ slotId: b.slot_id, guestName: b.guest_name, guestEmail: b.guest_email, status: b.status, cancelledAt: b.cancelled_at })
const slotCols = (p) => Object.fromEntries(Object.entries({ host_id: p.hostId, starts_at: p.startsAt, ends_at: p.endsAt, is_booked: p.isBooked }).filter(([, v]) => v !== undefined))

const run = Date.now()
const users = []

export const name = 'supabase'
const features = new Set(['insertReadBack', 'realtime', 'avatars'])
export const has = (f) => features.has(f)

// ---- identities ----
export async function guest() {
  return client()
}
export async function signUpHost(displayName) {
  const s = client()
  const { data, error } = await s.auth.signUp({ email: `${displayName}-${run}@test.dev`, password: 'secret123', options: { data: { display_name: displayName } } })
  if (error) throw error
  users.push(data.user.id)
  return { id: data.user.id, s }
}

// ---- slots ----
export const createSlot = async (s, p) => wrap(await s.from('slots').insert(slotCols(p)).select().single(), slot)
export const listFreeSlots = async (s, hostId) => wrap(await s.from('slots').select('*').eq('host_id', hostId), slot)
export async function getSlot(s, slotId) {
  const r = wrap(await s.from('slots').select('*').eq('id', slotId), slot)
  return r.ok ? { ...r, data: r.data[0] ?? null } : r
}
export const updateSlot = async (s, slotId, patch) => wrap(await s.from('slots').update(slotCols(patch)).eq('id', slotId).select(), slot)
export const deleteSlot = async (s, slotId) => wrap(await s.from('slots').delete().eq('id', slotId).select(), slot)

// ---- profiles ----
export async function getHostProfile(s, hostId) {
  const r = await s.from('profiles').select('display_name').eq('id', hostId).single()
  return wrap(r, (p) => ({ displayName: p.display_name }))
}
export async function updateProfile(s, hostId, patch) {
  const cols = Object.fromEntries(Object.entries({ id: patch.id, display_name: patch.displayName, avatar_path: patch.avatarPath }).filter(([, v]) => v !== undefined))
  return wrap(await s.from('profiles').update(cols).eq('id', hostId).select(), (p) => ({ id: p.id, displayName: p.display_name, avatarPath: p.avatar_path }))
}

// ---- bookings ----
export async function book(s, { slotId, guestName, guestEmail, cancelToken, status, readBack }) {
  const row = { slot_id: slotId, guest_name: guestName, guest_email: guestEmail, cancel_token: cancelToken, ...(status ? { status } : {}) }
  return wrap(readBack ? await s.from('bookings').insert(row).select() : await s.from('bookings').insert(row))
}
export const listBookings = async (s) => wrap(await s.from('bookings').select('*'), booking)
export async function updateBooking(s, slotId, patch, { onlyIfStatus } = {}) {
  const cols = Object.fromEntries(Object.entries({ status: patch.status, guest_email: patch.guestEmail }).filter(([, v]) => v !== undefined))
  let q = s.from('bookings').update(cols).eq('slot_id', slotId)
  if (onlyIfStatus) q = q.eq('status', onlyIfStatus)
  return wrap(await q.select(), booking)
}
export const deleteBooking = async (s, slotId) => wrap(await s.from('bookings').delete().eq('slot_id', slotId).select(), booking)
export const cancelByToken = async (s, token) => wrap(await s.rpc('cancel_booking', { p_cancel_token: token }))
// Raw rows on purpose: the scenario checks that no guest data comes back.
export const bookingStatuses = async (s, tokens) => wrap(await s.rpc('get_booking_statuses', { p_cancel_tokens: tokens }))

// An internal operation that must not be reachable from outside (a trigger function).
export const callInternal = async (s) => wrap(await s.rpc('sync_slot_is_booked'))

// ---- live updates: Realtime broadcast on a private channel slots:<host_id> ----
export async function subscribeSlots(hostId, onEvent) {
  const ch = client().channel(`slots:${hostId}`, { config: { private: true } })
    .on('broadcast', { event: 'slot_changed' }, ({ payload }) => onEvent(payload))
  await new Promise((res, rej) => ch.subscribe((st, err) => (st === 'SUBSCRIBED' ? res() : err && rej(err))))
  return {
    sendFake: (payload) => ch.send({ type: 'broadcast', event: 'slot_changed', payload }),
    close: () => ch.unsubscribe(),
  }
}

// ---- avatars: Storage bucket "avatars", path <host_id>/<file> ----
export const avatarUpload = async (s, path, blob, { upsert = false } = {}) =>
  wrap(await s.storage.from('avatars').upload(path, blob, { contentType: blob.type, upsert }))
export const avatarRemove = async (s, path) => wrap(await s.storage.from('avatars').remove([path]))
export const avatarUrl = (path) => client().storage.from('avatars').getPublicUrl(path).data.publicUrl

// ---- back door ----
export async function cleanup() {
  if (users.length) psql(`delete from auth.users where id in (${users.map((u) => `'${u}'`).join(',')})`)
}
