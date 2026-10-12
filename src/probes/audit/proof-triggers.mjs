// Proof script for the audit log, stage 2 (written by database triggers). Local only.
// Run: npm run probe:audit:proof:triggers   (resets the test data before and after)
// Section 4 also needs `npm run functions:serve` running; it's skipped otherwise.
// psql (database owner) is only used to inspect the log, and once to play "Studio".
import { createClient } from '@supabase/supabase-js'
import { execSync } from 'node:child_process'
import * as stage1 from '../../services/supabase/audit/clientLog.js'
import { bookRecurringRpc } from '../../services/supabase/recurring/rpc.js'
import { bookRecurringEdge } from '../../services/supabase/recurring/edge.js'

const DB = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const HOST = '11111111-1111-4111-8111-111111111111'
const url = process.env.VITE_SUPABASE_URL
const psql = (q) => execSync(`psql ${DB} -At -F'|' -c "${q.replace(/"/g, '\\"')}"`).toString().trim()
const seed = () => execSync('npm run -s probe:audit:seed', { stdio: 'ignore' })
const n = (q) => Number(psql(`select count(*) from ${q}`))
const client = () => createClient(url, process.env.VITE_SUPABASE_ANON_KEY, { auth: { persistSession: false } })
// [id, starts_at as ISO]
const slotAt = (week) => psql(`select id || '|' || to_char(starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  from slots where host_id = '${HOST}' order by starts_at offset ${week - 1} limit 1`).split('|')
const entries = (where) => psql(`select action || ',' || actor_role || ',' || coalesce(actor_id::text, '-')
  from audit_log where ${where} order by created_at`).split('\n').filter(Boolean)

let failures = 0
function check(name, ok, detail) {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `\n      → ${detail}` : ''}`)
}
const input = (week, weeks, guestName) => {
  const [id, starts_at] = slotAt(week)
  return { hostId: HOST, firstSlot: { id, starts_at }, weeks, guestName, guestEmail: 'g@example.com' }
}

seed()
const anon = client()

console.log('\n# 1. Skipping is impossible: a direct API call with no logging code')
let [slotId] = slotAt(1)
await anon.from('bookings').insert({ slot_id: slotId, guest_name: 'Sneaky Guest', guest_email: 'sneaky@example.com', cancel_token: crypto.randomUUID() })
const bookingId = psql(`select id from bookings where guest_name = 'Sneaky Guest'`)
const [row] = psql(`select actor_role || '|' || coalesce(actor_id::text, '-') || '|' || (record_id = '${bookingId}') || '|' || host_id || '|' || (changes->>'guest_email') || '|' || (changes ? 'cancel_token')
  from audit_log where action = 'booking.created'`).split('\n')
check('booking.created logged anyway', !!row, 'no entry')
check('…with the real booking id (stage 1 couldn\'t know it), host, actor anon',
  row?.startsWith(`anon|-|true|${HOST}`), row)
check('…email masked, cancel token left out', row?.endsWith('s***@example.com|false'), row)
check('…and no extra entry for the slot\'s is_booked flag', n(`audit_log where table_name = 'slots'`) === 0)

console.log('\n# 2. Stage 1 vs stage 2 for the same booking, when the browser\'s log request fails')
;[slotId] = slotAt(2)
await stage1.bookSlotLogged(anon, { hostId: HOST, slotId, guestName: 'Unlogged Guest', guestEmail: 'u@example.com' }, { failLog: true })
check('browser log (stage 1): 0 entries', n(`audit_log_client where changes->>'guest_name' = 'Unlogged Guest'`) === 0)
check('trigger log (stage 2): 1 entry', n(`audit_log where changes->>'guest_name' = 'Unlogged Guest'`) === 1)

console.log('\n# 3. Rollbacks remove their entries too')
seed()
let before = n('audit_log')
let res = await bookRecurringRpc(anon, input(1, 6, 'Clash Guest'))
check('recurring rpc, clash in week 4 → rolled back', res.clash?.week === 4, JSON.stringify(res))
check('…and 0 new entries (the series + weeks 1-3 entries were rolled back with them)', n('audit_log') === before)
res = await bookRecurringRpc(anon, input(5, 2, 'Series Guest'))
const tx = psql(`select count(distinct tx_id) || '|' || string_agg(action, ',' order by action) from audit_log`)
check('recurring rpc, 2 weeks → series.created + 2 × booking.created, one transaction', res.ok && tx === '1|booking.created,booking.created,series.created', tx)
const { error: takenErr } = await anon.from('bookings').insert({ slot_id: slotAt(4)[0], guest_name: 'Too Late', guest_email: 'l@example.com', cancel_token: crypto.randomUUID() })
check('a failed booking (week 4 taken) leaves no entry', takenErr && n(`audit_log where changes->>'guest_name' = 'Too Late'`) === 0, JSON.stringify(takenErr))

console.log('\n# 4. Edge Function path (direct connection), identity included')
const fnUp = await fetch(`${url}/functions/v1/book-recurring`, { method: 'OPTIONS', signal: AbortSignal.timeout(15000) }).then((r) => r.ok).catch(() => false)
if (!fnUp) {
  console.log('SKIP  functions serve is not running (npm run functions:serve)')
} else {
  seed()
  res = await bookRecurringEdge(anon, input(1, 2, 'Edge Guest'))
  check('guest via Edge Function → 3 entries as anon', res.ok && entries('true').every((e) => e.endsWith(',anon,-')) && n('audit_log') === 3, JSON.stringify(entries('true')))
  const user = client()
  const email = `audit-proof-${Date.now()}@test.dev`
  const { data: signUp } = await user.auth.signUp({ email, password: 'secret123' })
  before = n('audit_log')
  res = await bookRecurringEdge(user, input(5, 2, 'Edge User'))
  check('logged-in user via Edge Function → entries carry their user id',
    res.ok && n(`audit_log where actor_id = '${signUp.user.id}'`) === 3, JSON.stringify(res))
  psql(`delete from auth.users where email = '${email}'`)
}

console.log('\n# 5. Other paths: guest cancel (rpc), host actions, Studio')
seed()
const token = crypto.randomUUID()
;[slotId] = slotAt(1)
await anon.from('bookings').insert({ slot_id: slotId, guest_name: 'Cancel Guest', guest_email: 'c@example.com', cancel_token: token })
await anon.rpc('cancel_booking', { p_cancel_token: token })
check('guest cancel via rpc (security definer) → booking.cancelled, actor still anon',
  entries(`action = 'booking.cancelled'`).join() === 'booking.cancelled,anon,-', entries('true').join(' / '))

const host = client()
await host.auth.signInWithPassword({ email: 'recurring-host@test.dev', password: 'password123' })
const hostBooking = psql(`select b.id from bookings b join slots s on s.id = b.slot_id where s.host_id = '${HOST}' and b.guest_name = 'Someone Else'`)
await host.from('bookings').update({ status: 'cancelled' }).eq('id', hostBooking)
const [s6, starts6] = slotAt(6)
const moved = new Date(new Date(starts6).getTime() + 3600_000)
await host.from('slots').update({ starts_at: moved.toISOString(), ends_at: new Date(moved.getTime() + 1800_000).toISOString() }).eq('id', s6)
await host.from('slots').delete().eq('id', slotAt(3)[0])
const hostActions = entries(`actor_id = '${HOST}'`)
check('host cancel, move, delete → 3 entries with the host\'s id',
  hostActions.join() === `booking.cancelled,authenticated,${HOST},slot.moved,authenticated,${HOST},slot.deleted,authenticated,${HOST}`, hostActions.join(' / '))
const move = psql(`select changes->'starts_at'->>'from' is not null and changes->'starts_at'->>'to' is not null from audit_log where action = 'slot.moved'`)
check('slot.moved records only the changed fields, as from → to', move === 't')

psql(`update profiles set display_name = 'Renamed In Studio' where id = '${HOST}'`)
check('profile edit in Studio → logged, actor = database user "postgres", no person',
  entries(`action = 'profile.updated'`).join() === 'profile.updated,postgres,-', entries(`table_name = 'profiles'`).join())

console.log('\n# 6. Forging and tampering are impossible')
const fake = { actor_role: 'anon', action: 'slot.deleted', table_name: 'slots', record_id: crypto.randomUUID(), host_id: HOST }
const { error: anonIns } = await anon.from('audit_log').insert(fake)
const { error: hostIns } = await host.from('audit_log').insert(fake)
check('guest and host can\'t insert entries (42501)', anonIns?.code === '42501' && hostIns?.code === '42501', JSON.stringify({ anonIns, hostIns }))
const { error: upd } = await host.from('audit_log').update({ action: 'nothing.happened' }).neq('id', crypto.randomUUID())
const { error: del } = await host.from('audit_log').delete().neq('id', crypto.randomUUID())
check('host can\'t edit or delete entries (42501)', upd?.code === '42501' && del?.code === '42501', JSON.stringify({ upd, del }))
const { error: rpcErr } = await anon.rpc('audit_row_change')
check('the trigger function can\'t be called as an rpc', !!rpcErr, 'no error')

console.log('\n# 7. Reading')
const { data: hostRows } = await host.from('audit_log').select('id')
const { data: anonRows, error: anonErr } = await anon.from('audit_log').select('id')
const other = client()
await other.auth.signUp({ email: `audit-other-${Date.now()}@test.dev`, password: 'secret123' })
// The other host sees exactly one entry: their own profile.created from signing up.
const { data: otherRows } = await other.from('audit_log').select('action, host_id')
const otherId = (await other.auth.getUser()).data.user.id
check(`host reads entries about them (${hostRows?.length} of ${n('audit_log')}), guests read none`,
  hostRows?.length === n(`audit_log where host_id = '${HOST}'`) && (anonErr || anonRows.length === 0),
  JSON.stringify({ host: hostRows?.length, anon: anonErr ?? anonRows.length }))
check('another host sees only entries about themselves (their sign-up), none about the test host',
  otherRows?.length > 0 && otherRows.every((e) => e.host_id === otherId), JSON.stringify(otherRows))
psql(`delete from auth.users where email like 'audit-other-%@test.dev'`)

seed()
console.log(`\n${failures === 0 ? 'All checks passed' : `${failures} check(s) FAILED`} (test data reset)`)
process.exit(failures ? 1 : 0)
