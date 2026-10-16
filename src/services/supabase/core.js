// Core app functions for the Supabase backend (moved out of the core pages in N3).
// The pages call these through '@/services'. Shapes stay as before (snake_case rows),
// so the pages behave exactly as they did when they called supabase-js themselves.
import { supabase } from '@/lib/supabase'

// ---- login ----
export const auth = {
  // supabase-js keeps the session in localStorage and restores it on load.
  async getSession() {
    const { data } = await supabase.auth.getSession()
    return data.session
  },
  // Sign-in, sign-out, token refresh and changes from other tabs.
  onChange(callback) {
    supabase.auth.onAuthStateChange((_event, session) => callback(session))
  },
  async signUp({ email, password, displayName }) {
    // display_name lands in raw_user_meta_data; the handle_new_user trigger copies it to profiles.
    const { data, error } = await supabase.auth.signUp({ email, password, options: { data: { display_name: displayName } } })
    if (error) throw error
    // With email confirmation on (the hosted default) there is no session until the link is clicked.
    return { needsConfirmation: !data.session }
  },
  async signIn({ email, password }) {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw error
  },
  async signOut() {
    const { error } = await supabase.auth.signOut()
    if (error) throw error
  },
}

// ---- profiles ----
// The public booking page: name, picture, CAPTCHA setting. null = no such host (or a bad id).
export async function getPublicProfile(hostId) {
  const { data, error } = await supabase.from('profiles').select('display_name, avatar_path, require_captcha').eq('id', hostId).maybeSingle()
  return error ? null : data
}

export async function getMyProfile(userId) {
  const { data, error } = await supabase.from('profiles').select('display_name, avatar_path').eq('id', userId).single()
  if (error) throw error
  return data
}

// fields: { display_name?, avatar_path? }. Checks a row really changed (RLS-blocked updates return 0 rows).
export async function updateMyProfile(userId, fields) {
  const { data, error } = await supabase.from('profiles').update(fields).eq('id', userId).select('display_name, avatar_path')
  if (error) throw error
  if (data.length === 0) throw new Error('Profile could not be updated.')
  return data[0]
}

// ---- avatars (Storage bucket "avatars", public) ----
const AVATAR_BUCKET = 'avatars'

export async function uploadAvatar(path, file) {
  const { error } = await supabase.storage.from(AVATAR_BUCKET).upload(path, file, { contentType: file.type })
  if (error) throw error
}

export async function removeAvatar(path) {
  await supabase.storage.from(AVATAR_BUCKET).remove([path])
}

// A plain public URL, built locally (no request).
export function avatarUrl(path) {
  return path ? supabase.storage.from(AVATAR_BUCKET).getPublicUrl(path).data.publicUrl : null
}

// ---- the host's dashboard ----
// The host's slots with their bookings. `bookings(...)` is a PostgREST embed along the slot_id
// foreign key; RLS still applies (a host only sees bookings on their own slots).
export async function listDashboardSlots(hostId) {
  const { data, error } = await supabase
    .from('slots')
    .select('id, starts_at, ends_at, is_booked, bookings(id, guest_name, guest_email, status, signature_status, created_at, cancelled_at)')
    .eq('host_id', hostId)
    .order('starts_at')
  return { data, error }
}

// <input type="datetime-local"> values converted to ISO by the caller.
export async function createSlot({ hostId, startsAt, endsAt }) {
  const { error } = await supabase.from('slots').insert({ host_id: hostId, starts_at: startsAt, ends_at: endsAt })
  return { error }
}

// RLS-blocked deletes don't error, they affect 0 rows: deleted = false means "booked meanwhile".
export async function deleteSlot(slotId) {
  const { data, error } = await supabase.from('slots').delete().eq('id', slotId).select('id')
  return { error, deleted: !error && data.length > 0 }
}

// cancelled = false: the booking was already cancelled.
export async function cancelBookingAsHost({ bookingId }) {
  const { data, error } = await supabase
    .from('bookings')
    .update({ status: 'cancelled' })
    .eq('id', bookingId)
    .in('status', ['confirmed', 'pending_signature'])
    .select('id')
  return { error, cancelled: !error && data.length > 0 }
}

// ---- guests ----
// ok = false: token unknown, already cancelled, or the slot already started.
export async function cancelBookingByToken(token) {
  const { data, error } = await supabase.rpc('cancel_booking', { p_cancel_token: token })
  return { ok: !!data, error }
}

// Guests can't read bookings; this asks about the cancel tokens the browser holds.
// data: [{ cancel_token, status }]
export async function getBookingStatuses(tokens) {
  const { data, error } = await supabase.rpc('get_booking_statuses', { p_cancel_tokens: tokens })
  return { data, error }
}

// ---- live updates: broadcast topic "slots:<hostId>" (sent by the slots_broadcast trigger) ----
// onChange(payload) gets { id, starts_at, ends_at, available }. onSync() runs on every (re)connect:
// events sent while disconnected are NOT replayed, so the caller should refetch then.
// Returns a function that stops listening.
export function subscribeSlots(hostId, { onChange, onSync }) {
  // private: true = Realtime checks the RLS policy on realtime.messages before letting us join.
  const channel = supabase
    .channel(`slots:${hostId}`, { config: { private: true } })
    .on('broadcast', { event: 'slot_changed' }, ({ payload }) => onChange(payload))
    .subscribe((status, err) => {
      if (status === 'SUBSCRIBED') onSync?.()
      if (err) console.warn('Realtime:', status, err)
    })
  return () => supabase.removeChannel(channel)
}
