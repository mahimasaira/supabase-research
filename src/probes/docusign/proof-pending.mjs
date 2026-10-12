// Proof script for feature 4 (DocuSign), stage 1: bookings that wait for a signature.
// Never reaches DocuSign (sending is switched off while it runs). Local only.
// Run: npm run probe:docusign:proof:pending   (resets the test data before and after)
import { createClient } from '@supabase/supabase-js'
import { execSync } from 'node:child_process'
import { bookRecurringRpc } from '../../services/supabase/recurring/rpc.js'

const DB = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const HOST = '11111111-1111-4111-8111-111111111111'
const psql = (q) => execSync(`psql ${DB} -At -F'|' -c "${q.replace(/"/g, '\\"')}"`).toString().trim()
const seed = () => execSync('npm run -s probe:recurring:seed', { stdio: 'ignore' })
const client = () => createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY, { auth: { persistSession: false } })
const slotAt = (week) => psql(`select id || '|' || to_char(starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  from slots where host_id = '${HOST}' order by starts_at offset ${week - 1} limit 1`).split('|')
const booking = (name) => psql(`select status || '|' || coalesce(signature_status, '-') from bookings where guest_name = '${name}'`)
const isBooked = (slotId) => psql(`select is_booked from slots where id = '${slotId}'`) === 't'

let failures = 0
function check(name, ok, detail) {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `\n      → ${detail}` : ''}`)
}
const anon = client()
const book = (slotId, name, extra = {}) => {
  const token = crypto.randomUUID()
  return anon.from('bookings').insert({ slot_id: slotId, guest_name: name, guest_email: 'g@example.com', cancel_token: token, ...extra })
    .then((r) => ({ ...r, token }))
}

seed()
// Since stage 2, waiting bookings trigger a real DocuSign send. This script books with made-up
// addresses, so point the database's send URL at an unreachable address while it runs.
const realSendUrl = psql(`select coalesce(max(decrypted_secret), '') from vault.decrypted_secrets where name = 'docusign_send_url'`)
const setSendUrl = (url) => psql(`select vault.update_secret(id, '${url.replace(/'/g, "''")}') from vault.secrets where name = 'docusign_send_url'`)
if (realSendUrl) {
  setSendUrl('http://127.0.0.1:9/unreachable')
  process.on('exit', () => setSendUrl(realSendUrl)) // also restores after a crash
}
const host = client()
await host.auth.signInWithPassword({ email: 'recurring-host@test.dev', password: 'password123' })

console.log('\n# Hosts who don\'t opt in: nothing changes')
const [w1] = slotAt(1)
await book(w1, 'Plain Guest')
check('booking is confirmed straight away', booking('Plain Guest') === 'confirmed|-', booking('Plain Guest'))

console.log('\n# The host opts in')
const { data: on, error: onErr } = await host.from('profiles').update({ require_signature: true }).eq('id', HOST).select('require_signature')
check('host switches on "require a signed agreement"', !onErr && on?.[0]?.require_signature === true, JSON.stringify(onErr))
const other = client()
await other.auth.signUp({ email: `sig-other-${Date.now()}@test.dev`, password: 'secret123' })
const { data: hijack } = await other.from('profiles').update({ require_signature: false }).eq('id', HOST).select('id')
check('another host can\'t change it (0 rows, RLS)', hijack?.length === 0 && psql(`select require_signature from profiles where id = '${HOST}'`) === 't')
psql(`delete from auth.users where email like 'sig-other-%@test.dev'`)

console.log('\n# A booking now waits for the signature, and holds the slot')
const [w2] = slotAt(2)
const anna = await book(w2, 'Anna')
check('booking accepted', !anna.error, JSON.stringify(anna.error))
check('status pending_signature, signature_status pending', booking('Anna') === 'pending_signature|pending', booking('Anna'))
check('slot is marked booked', isBooked(w2))
const { data: free } = await anon.from('slots').select('id').eq('host_id', HOST).eq('is_booked', false)
check('slot no longer offered to guests', !free.some((s) => s.id === w2))
const second = await book(w2, 'Too Late')
check('a second booking for that slot is rejected', !!second.error, JSON.stringify(second.error))
const { data: statuses } = await anon.rpc('get_booking_statuses', { p_cancel_tokens: [anna.token] })
check('the guest\'s status check says pending_signature', statuses?.[0]?.status === 'pending_signature', JSON.stringify(statuses))

console.log('\n# Nobody can skip the signature')
const [w3] = slotAt(3)
const forced = await book(w3, 'Sneaky', { status: 'confirmed' })
const forcedSig = await book(w3, 'Sneaky', { signature_status: 'completed' })
check('guest can\'t send status or signature_status (42501)', forced.error?.code === '42501' && forcedSig.error?.code === '42501',
  JSON.stringify({ forced: forced.error?.code, forcedSig: forcedSig.error?.code }))
const annaId = psql(`select id from bookings where guest_name = 'Anna'`)
const { error: confirmErr } = await host.from('bookings').update({ status: 'confirmed' }).eq('id', annaId)
const { error: sigErr } = await host.from('bookings').update({ signature_status: 'completed' }).eq('id', annaId)
check('host can\'t confirm it or mark it signed (RLS / no grant)', !!confirmErr && sigErr?.code === '42501' && booking('Anna') === 'pending_signature|pending',
  JSON.stringify({ confirmErr: confirmErr?.code, sigErr: sigErr?.code }))

console.log('\n# Cancelling a waiting booking')
const { data: cancelled } = await anon.rpc('cancel_booking', { p_cancel_token: anna.token })
check('guest cancels via the cancel link (rpc) → slot free again', cancelled === true && booking('Anna').startsWith('cancelled') && !isBooked(w2))
const ben = await book(w3, 'Ben')
const benId = psql(`select id from bookings where guest_name = 'Ben'`)
const { data: hostCancel } = await host.from('bookings').update({ status: 'cancelled' }).eq('id', benId).in('status', ['confirmed', 'pending_signature']).select('id')
check('host cancels a waiting booking → slot free again', !ben.error && hostCancel?.length === 1 && !isBooked(w3), JSON.stringify(hostCancel))

console.log('\n# Recurring bookings and switching off')
const [w5, w5Start] = slotAt(5)
const rec = await bookRecurringRpc(anon, { hostId: HOST, firstSlot: { id: w5, starts_at: w5Start }, weeks: 2, guestName: 'Weekly Guest', guestEmail: 'w@example.com' })
check('recurring booking (rpc) → every week pending_signature', rec.ok && psql(`select string_agg(distinct status, ',') from bookings where guest_name = 'Weekly Guest'`) === 'pending_signature', JSON.stringify(rec))
await host.from('profiles').update({ require_signature: false }).eq('id', HOST)
const [w2again] = slotAt(2)
await book(w2again, 'After Switch Off')
check('after switching off: new bookings are confirmed, waiting ones stay waiting',
  booking('After Switch Off') === 'confirmed|-' && psql(`select count(*) from bookings b join slots s on s.id = b.slot_id where s.host_id = '${HOST}' and b.status = 'pending_signature'`) === '2',
  psql(`select string_agg(b.guest_name || ':' || b.status, ', ') from bookings b join slots s on s.id = b.slot_id where s.host_id = '${HOST}'`))

seed()
console.log(`\n${failures === 0 ? 'All checks passed' : `${failures} check(s) FAILED`} (test data reset)`)
process.exit(failures ? 1 : 0)
