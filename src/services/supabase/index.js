// Supabase implementation of the service functions. Pages import from '@/services',
// never from here. All supabase-js calls on this branch live under src/services/supabase/.
import { supabase } from '@/lib/supabase'
import { bookRecurringSplit } from './recurring/split'
import { bookRecurringRpc } from './recurring/rpc'

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

// ---- recurring bookings ----
// Three ways to do the same thing, so the probe page can compare them.
export const recurringStrategies = [
  { id: 'split', label: 'Stage 1: separate browser calls', ready: true },
  { id: 'rpc', label: 'Stage 2: Postgres function (rpc)', ready: true },
  { id: 'edge', label: 'Stage 3: Edge Function (direct connection)', ready: false },
]

// input: { hostId, firstSlot: { starts_at }, weeks, guestName, guestEmail }
// result: { ok: true, seriesId, weeks: [{ week, startsAt, cancelToken }] }
//      or { ok: false, clash: { week, startsAt, reason } | null, notEnoughWeeks?: { requested, available }, error?, saved }
//         saved = what is left in the database after the failure (should be nothing!)
export async function bookRecurring(input, { strategy = 'split' } = {}) {
  switch (strategy) {
    case 'split': return bookRecurringSplit(supabase, input)
    case 'rpc': return bookRecurringRpc(supabase, input)
    default: throw new Error(`Recurring strategy "${strategy}" is not built yet`)
  }
}
