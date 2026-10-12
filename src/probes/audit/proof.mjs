// Proof script for the audit log, stage 1 (log written by the browser). Local only.
// Run: npm run probe:audit:proof   (resets the test data before and after)
// Each "DEMO" line shows one of the problems from the plan; PASS means it was reproduced.
// psql (database owner) is only used to look at the data, and once to play "Studio".
import { createClient } from '@supabase/supabase-js'
import { execSync } from 'node:child_process'
import * as audit from '../../services/supabase/audit/clientLog.js'
import { bookRecurringRpc } from '../../services/supabase/recurring/rpc.js'

const DB = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const HOST = '11111111-1111-4111-8111-111111111111'
const psql = (q) => execSync(`psql ${DB} -At -c "${q.replace(/"/g, '\\"')}"`).toString().trim()
const seed = () => execSync('npm run -s probe:audit:seed', { stdio: 'ignore' })
const n = (q) => Number(psql(`select count(*) from ${q}`))
const logCount = () => n('audit_log_client')
const client = () => createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY, { auth: { persistSession: false } })
// [id, starts_at as ISO]
const slotAt = (week) => psql(`select id || ' ' || to_char(starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  from slots where host_id = '${HOST}' order by starts_at offset ${week - 1} limit 1`).split(' ')

let failures = 0
function check(name, ok, detail) {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `\n      → ${detail}` : ''}`)
}
const guest = (name) => ({ hostId: HOST, guestName: name, guestEmail: 'someone@example.com' })

seed()
const anon = client()

console.log('\n# 0. When everything goes right, it works')
let [slotId] = slotAt(1)
let r = await audit.bookSlotLogged(anon, { ...guest('Logged Guest'), slotId })
const [entry] = (psql(`select actor_role || ',' || coalesce(actor_id::text, 'null') || ',' || (changes->>'guest_email') from audit_log_client`)).split('\n')
check('guest booking → 1 booking + 1 log entry', r.acted && r.logged && logCount() === 1, JSON.stringify(r))
check('entry: actor anon (no id), email masked', entry === 'anon,null,s***@example.com', entry)

console.log('\n# 1. DEMO skipping: the same action without the logging code')
;[slotId] = slotAt(2)
let before = logCount()
const { error: rawErr } = await anon.from('bookings').insert({ slot_id: slotId, guest_name: 'Sneaky Guest', guest_email: 'x@example.com', cancel_token: crypto.randomUUID() })
check('booking saved by a direct API call', !rawErr, JSON.stringify(rawErr))
check('…and the log knows nothing about it', logCount() === before)

console.log('\n# 2. DEMO other paths: nothing logs unless every path calls the logger')
before = logCount()
const [s5, starts5] = slotAt(5)
const rec = await bookRecurringRpc(anon, { hostId: HOST, firstSlot: { id: s5, starts_at: starts5 }, weeks: 2, guestName: 'Recurring Guest', guestEmail: 'r@example.com' })
check('recurring booking (rpc) saved 2 bookings + a series', rec.ok, JSON.stringify(rec))
psql(`update profiles set display_name = 'Renamed In Studio' where id = '${HOST}'`)
check('…a profile edit in Studio (as owner) saved', psql(`select display_name from profiles where id = '${HOST}'`) === 'Renamed In Studio')
check('…and neither left a single log entry', logCount() === before)

console.log('\n# 3. DEMO forging: anyone who can log, can log anything')
const [s3] = slotAt(3)
const forged = await audit.logEvent(anon, { action: 'slot.deleted', table: 'slots', recordId: s3, hostId: HOST, changes: { note: 'never happened' } })
check('anonymous guest writes "host deleted slot (week 3)" → accepted', !forged.error, JSON.stringify(forged.error))
check('…but the slot still exists', n(`slots where id = '${s3}'`) === 1)
const { error: actorErr } = await anon.from('audit_log_client').insert({ action: 'slot.deleted', table_name: 'slots', actor_id: HOST })
check('the WHO can\'t be faked: setting actor_id → permission denied (42501)', actorErr?.code === '42501', JSON.stringify(actorErr))

console.log('\n# 4. DEMO act first, then the log request fails')
seed()
;[slotId] = slotAt(1)
r = await audit.bookSlotLogged(anon, { ...guest('Unlogged Guest'), slotId }, { failLog: true })
check('booking saved, log rejected', r.acted && !r.logged, JSON.stringify(r))
check('…so a real booking has no log entry', n(`bookings where guest_name = 'Unlogged Guest'`) === 1 && logCount() === 0)

;[slotId] = slotAt(2)
r = await audit.bookSlotLogged(anon, { ...guest('Careful Guest'), slotId }, { order: 'log-first', failLog: true })
check('log first + log fails → the action is not even tried (nothing happens)', !r.acted && !r.logged && n(`bookings where guest_name = 'Careful Guest'`) === 0, JSON.stringify(r))

console.log('\n# 5. DEMO log first, then the action fails')
const [taken] = slotAt(4) // week 4: already booked by "Someone Else"
r = await audit.bookSlotLogged(anon, { ...guest('Ghost Guest'), slotId: taken }, { order: 'log-first' })
check('log entry written, booking rejected', r.logged && !r.acted, JSON.stringify(r))
check('…so the log describes a booking that never existed', n(`audit_log_client where changes->>'guest_name' = 'Ghost Guest'`) === 1 && n(`bookings where guest_name = 'Ghost Guest'`) === 0)

console.log('\n# 6. Host actions, reading and tampering')
const host = client()
const { error: loginErr } = await host.auth.signInWithPassword({ email: 'recurring-host@test.dev', password: 'password123' })
if (loginErr) throw loginErr
const bookingId = psql(`select id from bookings where guest_name = 'Unlogged Guest'`)
r = await audit.cancelAsHostLogged(host, { hostId: HOST, bookingId })
check('host cancels a booking → logged', r.acted && r.logged, JSON.stringify(r))
check('entry: actor = the host\'s id, role authenticated',
  psql(`select actor_role || ',' || actor_id from audit_log_client where action = 'booking.cancelled'`) === `authenticated,${HOST}`)
const { data: hostRows } = await host.from('audit_log_client').select('id')
const { data: anonRows, error: anonReadErr } = await anon.from('audit_log_client').select('id')
check(`host reads the entries about them (${hostRows?.length}), guests read none`, hostRows?.length === logCount() && (anonReadErr || anonRows.length === 0))
const { error: delErr } = await host.from('audit_log_client').delete().neq('id', crypto.randomUUID())
const { error: updErr } = await host.from('audit_log_client').update({ action: 'nothing.happened' }).neq('id', crypto.randomUUID())
check('host can\'t delete or edit entries (no grants)', delErr?.code === '42501' && updErr?.code === '42501', JSON.stringify({ delErr, updErr }))

seed()
console.log(`\n${failures === 0 ? 'All demos reproduced' : `${failures} check(s) FAILED`} (test data reset)`)
process.exit(failures ? 1 : 0)
