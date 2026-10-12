// Proof script for the audit log, stage 4 (host history page). Local only.
// Run: npm run probe:audit:proof:history   (resets the test data before and after)
// Uses the same service + display code as the History page (src/features/audit/).
import { createClient } from '@supabase/supabase-js'
import { execSync } from 'node:child_process'
import { listAuditHistory } from '../../services/supabase/audit/history.js'
import { bookRecurringRpc } from '../../services/supabase/recurring/rpc.js'
import { groupHistory } from '../../features/audit/history.js'
import { formatDate } from '../../lib/format.js'

const DB = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const HOST = '11111111-1111-4111-8111-111111111111'
const psql = (q) => execSync(`psql ${DB} -At -F'|' -c "${q.replace(/"/g, '\\"')}"`).toString().trim()
const client = () => createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY, { auth: { persistSession: false } })
const slotAt = (week) => psql(`select id || '|' || to_char(starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  from slots where host_id = '${HOST}' order by starts_at offset ${week - 1} limit 1`).split('|')

let failures = 0
function check(name, ok, detail) {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `\n      → ${detail}` : ''}`)
}

execSync('npm run -s probe:audit:seed', { stdio: 'ignore' })
const anon = client()
const host = client()
await host.auth.signInWithPassword({ email: 'recurring-host@test.dev', password: 'password123' })

// ---- A realistic mix of changes ----
const [week1, week1Start] = slotAt(1)
const [week2] = slotAt(2)
const [week5, week5Start] = slotAt(5)
const annaToken = crypto.randomUUID()
await anon.from('bookings').insert({ slot_id: week1, guest_name: 'Anna', guest_email: 'anna@example.com', cancel_token: annaToken })
await bookRecurringRpc(anon, { hostId: HOST, firstSlot: { id: week5, starts_at: week5Start }, weeks: 2, guestName: 'Ben', guestEmail: 'ben@example.com' })
const week2Start = new Date(psql(`select starts_at from slots where id = '${week2}'`))
await host.from('slots').update({
  starts_at: new Date(week2Start.getTime() + 3600_000).toISOString(),
  ends_at: new Date(week2Start.getTime() + 5400_000).toISOString(),
}).eq('id', week2)
const annaBooking = psql(`select id from bookings where guest_name = 'Anna'`)
await host.from('bookings').update({ status: 'cancelled' }).eq('id', annaBooking)
await host.from('slots').delete().eq('id', week1) // Anna's slot is gone now
psql(`update profiles set display_name = 'Renamed In Studio' where id = '${HOST}'`)

// ---- What the History page gets ----
console.log('\n# What the host sees')
const { entries, nextCursor } = await listAuditHistory(host, { hostId: HOST })
const groups = groupHistory(entries, HOST)
for (const g of groups) console.log(`  ${g.who.padEnd(15)} ${g.text}`)
console.log()

check('all entries on one page (no next page)', entries.length === Number(psql(`select count(*) from audit_log where host_id = '${HOST}'`)) && nextCursor === null)
check('newest first: the Studio rename is on top, by "Database admin"',
  groups[0]?.who === 'Database admin' && groups[0].text.includes('"Renamed In Studio"'), JSON.stringify(groups[0]))
const recurring = groups.filter((g) => g.text.startsWith('booked 2 weeks'))
check('the recurring booking (series + 2 bookings) is ONE line, by Guest, for Ben',
  recurring.length === 1 && recurring[0].who === 'Guest' && recurring[0].entries.length === 3 && recurring[0].text.endsWith('for Ben'),
  JSON.stringify(recurring.map((g) => g.text)))
check('…starting at week 5', recurring[0]?.text.includes(formatDate(week5Start)), recurring[0]?.text)
const anna = groups.find((g) => g.text.startsWith('booked') && g.text.includes('Anna'))
check('Anna\'s booking still shows its time although the slot was deleted (context)', anna?.text.includes(formatDate(week1Start)), anna?.text)
check('…with the masked email, by Guest', anna?.text.includes('a***@example.com') && anna.who === 'Guest', anna?.text)
check('host actions read "You": cancel, move, delete',
  ['cancelled Anna\'s booking', 'moved a slot from', 'deleted the slot'].every((t) => groups.some((g) => g.who === 'You' && g.text.startsWith(t))),
  JSON.stringify(groups.filter((g) => g.who === 'You').map((g) => g.text)))

console.log('\n# Paging and filters')
const seen = []
let cursor = null
let pages = 0
do {
  const page = await listAuditHistory(host, { hostId: HOST, limit: 2, cursor })
  seen.push(...page.entries.map((e) => e.id))
  cursor = page.nextCursor
  pages++
} while (cursor && pages < 50)
check(`paging 2 at a time (${pages} pages) returns every entry exactly once`,
  seen.length === entries.length && new Set(seen).size === entries.length && entries.every((e) => seen.includes(e.id)),
  JSON.stringify({ seen: seen.length, all: entries.length, unique: new Set(seen).size }))
const slotsOnly = (await listAuditHistory(host, { hostId: HOST, kind: 'slots' })).entries
const bookingsOnly = (await listAuditHistory(host, { hostId: HOST, kind: 'bookings' })).entries
check('filter "slots" returns only slot entries', slotsOnly.length > 0 && slotsOnly.every((e) => e.table_name === 'slots'))
check('filter "bookings" returns bookings + series', bookingsOnly.length > 0 && bookingsOnly.every((e) => ['bookings', 'booking_series'].includes(e.table_name)))

console.log('\n# Nobody else sees it')
const other = client()
await other.auth.signUp({ email: `history-other-${Date.now()}@test.dev`, password: 'secret123' })
const otherView = await listAuditHistory(other, { hostId: HOST })
check('another host asking for the test host\'s history gets nothing', otherView.entries.length === 0)
const anonView = await listAuditHistory(anon, { hostId: HOST }).catch((err) => ({ error: err }))
check('a guest gets an error (no access to audit_log)', anonView.error?.code === '42501', JSON.stringify(anonView))
psql(`delete from auth.users where email like 'history-other-%@test.dev'`)

execSync('npm run -s probe:audit:seed', { stdio: 'ignore' })
console.log(`\n${failures === 0 ? 'All checks passed' : `${failures} check(s) FAILED`} (test data reset)`)
process.exit(failures ? 1 : 0)
