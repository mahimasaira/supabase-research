// Supabase implementation of the service functions. Pages import from '@/services',
// never from here. All supabase-js calls on this branch live under src/services/supabase/.
import { supabase } from '@/lib/supabase'
import { bookRecurringSplit } from './recurring/split'
import { bookRecurringRpc } from './recurring/rpc'
import { bookRecurringEdge } from './recurring/edge'
import * as clientAudit from './audit/clientLog'
import * as auditHistory from './audit/history'

// ---- slots ----
export async function getHostProfile(hostId) {
  const { data, error } = await supabase.from('profiles').select('display_name').eq('id', hostId).maybeSingle()
  if (error) throw error
  return data
}

// RLS limits guests to free, future slots; the explicit filters keep it that way for a
// logged-in host too (their "read own slots" policy would also return booked ones).
export async function listFreeSlots(hostId) {
  const { data, error } = await supabase
    .from('slots')
    .select('id, starts_at, ends_at')
    .eq('host_id', hostId)
    .eq('is_booked', false)
    .gt('starts_at', new Date().toISOString())
    .order('starts_at')
  if (error) throw error
  return data
}

// A logged-in host's own slots with their bookings (RLS: only their own).
export async function listHostSlots(hostId) {
  const { data, error } = await supabase
    .from('slots')
    .select('id, starts_at, ends_at, is_booked, bookings(id, guest_name, status)')
    .eq('host_id', hostId)
    .order('starts_at')
  if (error) throw error
  return data
}

// ---- recurring bookings ----
// Three ways to do the same thing, so the probe page can compare them.
export const recurringStrategies = [
  { id: 'split', label: 'Stage 1: separate browser calls', ready: true },
  { id: 'rpc', label: 'Stage 2: Postgres function (rpc)', ready: true },
  { id: 'edge', label: 'Stage 3: Edge Function (direct connection)', ready: true },
]

// input: { hostId, firstSlot: { starts_at }, weeks, guestName, guestEmail }
// result: { ok: true, seriesId, weeks: [{ week, startsAt, cancelToken }] }
//      or { ok: false, clash: { week, startsAt, reason } | null, notEnoughWeeks?: { requested, available }, error?, saved }
//         saved = what is left in the database after the failure (should be nothing!)
export async function bookRecurring(input, { strategy = 'split' } = {}) {
  switch (strategy) {
    case 'split': return bookRecurringSplit(supabase, input)
    case 'rpc': return bookRecurringRpc(supabase, input)
    case 'edge': return bookRecurringEdge(supabase, input)
    default: throw new Error(`Recurring strategy "${strategy}" is not built yet`)
  }
}

// ---- audit log, stage 1: written by the browser (audit_log_client) ----
// opts: { order: 'act-first' | 'log-first', failLog: boolean }
// result: { order, acted, logged, actError, logError } (+ cancelToken for bookings)
export const bookSlotLogged = (params, opts) => clientAudit.bookSlotLogged(supabase, params, opts)
export const cancelAsGuestLogged = (params, opts) => clientAudit.cancelAsGuestLogged(supabase, params, opts)
export const cancelAsHostLogged = (params, opts) => clientAudit.cancelAsHostLogged(supabase, params, opts)
export const deleteSlotLogged = (params, opts) => clientAudit.deleteSlotLogged(supabase, params, opts)
// Writes any entry the caller likes, which is the point of the forging demo.
export const logAuditEventFromClient = (entry) => clientAudit.logEvent(supabase, entry)

// ---- audit log, stage 4: the host's history (audit_log, written by triggers) ----
// opts: { hostId, kind: 'all' | 'bookings' | 'slots' | 'profile', limit, cursor }
// result: { entries, nextCursor } (nextCursor null on the last page)
export const listAuditHistory = (opts) => auditHistory.listAuditHistory(supabase, opts)

// ---- DocuSign (feature 4), stage 1: the host's "require a signed agreement" setting ----
export async function getSignatureRequirement(hostId) {
  const { data, error } = await supabase.from('profiles').select('require_signature').eq('id', hostId).single()
  if (error) throw error
  return data.require_signature
}

export async function setSignatureRequirement(hostId, required) {
  // .select() so an RLS-filtered update (0 rows, no error) is noticed.
  const { data, error } = await supabase.from('profiles').update({ require_signature: required }).eq('id', hostId).select('require_signature')
  if (error) throw error
  if (data.length === 0) throw new Error('Setting not saved (not your profile?)')
  return data[0].require_signature
}

// ---- DocuSign, stage 3: ask DocuSign about the host's agreements that are still out ----
// result: { checked, signed, cancelled, waiting, errors }
export async function checkSignatureStatus() {
  const { data, error } = await supabase.functions.invoke('docusign-sync')
  if (error) {
    const body = await error.context?.json?.().catch(() => null)
    throw new Error(body?.error ?? error.message)
  }
  return data
}

// ---- spam protection (feature 3), stage 3: CAPTCHA ----
export async function getCaptchaRequirement(hostId) {
  const { data, error } = await supabase.from('profiles').select('require_captcha').eq('id', hostId).single()
  if (error) throw error
  return data.require_captcha
}

export async function setCaptchaRequirement(hostId, required) {
  const { data, error } = await supabase.from('profiles').update({ require_captcha: required }).eq('id', hostId).select('require_captcha')
  if (error) throw error
  if (data.length === 0) throw new Error('Setting not saved (not your profile?)')
  return data[0].require_captcha
}

// One booking by a guest. With a CAPTCHA token (hosts who require one) it goes through the Edge
// Function book-slot, which verifies the token; otherwise straight into the bookings table.
// Either way the result is { error } with the database's error code (42501 taken, PT429 rate
// limit, PT403 CAPTCHA required, captcha_failed, …), so the page handles both the same.
export async function bookSlot({ slotId, guestName, guestEmail, cancelToken, captchaToken }) {
  if (!captchaToken) {
    const { error } = await supabase.from('bookings').insert({ slot_id: slotId, guest_name: guestName, guest_email: guestEmail, cancel_token: cancelToken })
    return { error }
  }
  const { error } = await supabase.functions.invoke('book-slot', { body: { slotId, guestName, guestEmail, cancelToken, captchaToken } })
  if (!error) return { error: null }
  const body = await error.context?.json?.().catch(() => null)
  return { error: body?.error ?? { code: 'network', message: error.message } }
}

// ---- bulk reminders (feature 5), stage 3: stop reminder emails (guest, no account) ----
// token = the booking's cancel token (from the reminder email). true = opted out.
export async function unsubscribeReminders(token) {
  const { data, error } = await supabase.rpc('unsubscribe_reminders', { p_cancel_token: token })
  if (error) throw error
  return data
}
