// Proof script for stage 3 (Edge Function book-recurring). Local only.
// Run: npm run probe:recurring:edge-proof
// Needs: `npm run db:start` and `npx supabase functions serve` running in another terminal.
// Uses psql (as the database owner) only to set up / inspect test data, never to book.
import { createClient } from '@supabase/supabase-js'
import { execSync, spawn } from 'node:child_process'
import { bookRecurringEdge } from '../../services/supabase/recurring/edge.js'

const DB = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const url = process.env.VITE_SUPABASE_URL
const key = process.env.VITE_SUPABASE_ANON_KEY
const HOST = '11111111-1111-4111-8111-111111111111'
const fnUrl = `${url}/functions/v1/book-recurring`

const psql = (q) => execSync(`psql ${DB} -At -F' ' -c "${q.replace(/"/g, '\\"')}"`).toString().trim()
const seed = () => execSync('npm run -s probe:recurring:seed', { stdio: 'ignore' })
const count = (table) => Number(psql(`select count(*) from ${table}`))
const client = () => createClient(url, key, { auth: { persistSession: false } })
const input = (firstStartsAt, weeks) => ({ hostId: HOST, firstSlot: { starts_at: firstStartsAt }, weeks, guestName: 'Probe Guest', guestEmail: 'g@example.com' })
const monday = (n) => psql(`select to_char(starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') from slots where host_id = '${HOST}' order by starts_at offset ${n - 1} limit 1`)

let failures = 0
function check(name, ok, detail) {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      → ${detail}` : ''}`)
}
const post = (headers, body = {}) =>
  fetch(fnUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')

// ---------------------------------------------------------------------------
console.log('\n# 1. Identity is verified before anything touches the database')
seed()
let r = await post({}, {})
check('no apikey → 401', r.status === 401, `${r.status} ${await r.text()}`)

r = await post({ apikey: 'sb_publishable_made_up' }, {})
check('unknown apikey → 401', r.status === 401, `${r.status} ${await r.text()}`)

// A token that CLAIMS to be service_role (which would bypass RLS), with a made-up signature.
const kid = JSON.parse(execSync(`curl -s ${url}/auth/v1/.well-known/jwks.json`).toString()).keys[0].kid
const fakeClaims = { role: 'service_role', sub: crypto.randomUUID(), exp: Math.floor(Date.now() / 1000) + 3600 }
for (const alg of ['ES256', 'HS256']) {
  const forged = `${b64url({ alg, typ: 'JWT', kid })}.${b64url(fakeClaims)}.${Buffer.from('not-a-signature').toString('base64url')}`
  r = await post({ apikey: key, Authorization: `Bearer ${forged}` }, input(monday(1), 2))
  check(`forged ${alg} "service_role" token → 401`, r.status === 401, `${r.status} ${await r.text()}`)
}
check('…and nothing was written', count('booking_series') === 0)

// ---------------------------------------------------------------------------
console.log('\n# 2. Anonymous guest: all-or-nothing')
const anon = client()
let res = await bookRecurringEdge(anon, input(monday(1), 6))
check('6 weeks from week 1 → clash in week 4', res.clash?.week === 4, JSON.stringify(res))
check('ran as role anon, auth.uid() null', res.ranAs?.role === 'anon' && res.ranAs?.uid === null, JSON.stringify(res.ranAs))
check('rolled back: 0 series, 0 Probe Guest bookings',
  count('booking_series') === 0 && count("bookings where guest_name = 'Probe Guest'") === 0)

res = await bookRecurringEdge(anon, input(monday(5), 6))
check('6 weeks from week 5 → only 2 weeks available', res.notEnoughWeeks?.available === 2, JSON.stringify(res))

// ---------------------------------------------------------------------------
console.log('\n# 3. Logged-in user: their identity reaches the database')
const user = client()
const email = `edge-proof-${Date.now()}@test.dev`
const { data: signUp, error: signUpErr } = await user.auth.signUp({ email, password: 'secret123' })
if (signUpErr) throw signUpErr
res = await bookRecurringEdge(user, input(monday(5), 2))
check('2 weeks from week 5 → booked', res.ok, JSON.stringify(res))
check('ran as role authenticated, auth.uid() = the user\'s id',
  res.ranAs?.role === 'authenticated' && res.ranAs?.uid === signUp.user.id, JSON.stringify(res.ranAs))
check('committed: 1 series, 2 bookings', count('booking_series') === 1 && count('bookings where series_id is not null') === 2)

// ---------------------------------------------------------------------------
console.log('\n# 4. RLS is enforced inside the direct connection')
// A rule that ONLY RLS enforces (no constraint): guests can't see or book past slots.
// Three weekly slots: P (yesterday 03:00 UTC, past), P+7d and P+14d (future). 03:00 so they
// never overlap the seeded Monday 10:00 slots (the exclusion constraint would refuse them).
seed()
const P = psql(`select to_char((date_trunc('day', now() - interval '1 day') + interval '3 hours') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`)
psql(`insert into slots (host_id, starts_at, ends_at) select '${HOST}', t, t + interval '5 minutes'
      from (select '${P}'::timestamptz + n * interval '168 hours' as t from generate_series(0, 2) n) s`)
const asOwner = psql(`select count(*) from slots where host_id = '${HOST}' and starts_at = '${P}' and not is_booked`)
// Same query after switching to the anon role, exactly what the Edge Function does first.
const asAnon = execSync(`psql ${DB} -q -At`, { input: `begin; set local role anon;
  select count(*) from slots where host_id = '${HOST}' and starts_at = '${P}' and not is_booked; rollback;` }).toString().trim()
check('the past slot is visible to the owner (postgres) but not to anon', asOwner === '1' && asAnon === '0', `owner=${asOwner} anon=${asAnon}`)
res = await bookRecurringEdge(anon, input(P, 3))
check('booking it via the Edge Function → week 1 not available (RLS applied)', res.clash?.week === 1, JSON.stringify(res))
check('the past slot is still free', psql(`select is_booked from slots where host_id = '${HOST}' and starts_at = '${P}'`) === 'f')

// ---------------------------------------------------------------------------
console.log('\n# 5. Race: someone books week 3 while our transaction runs')
seed()
const other = spawn('psql', [DB, '-q', '-c', `begin; insert into bookings (slot_id, guest_name, guest_email)
  select id, 'Racer', 'r@example.com' from slots where host_id = '${HOST}' and starts_at = '${monday(3)}';
  select pg_sleep(2); commit;`])
const otherDone = new Promise((resolve) => other.on('close', resolve))
await new Promise((resolve) => setTimeout(resolve, 500))
const t0 = Date.now()
res = await bookRecurringEdge(anon, input(monday(1), 3))
await otherDone
check(`week 3 reported "just taken" (waited ${Date.now() - t0} ms)`, res.clash?.week === 3 && res.clash?.reason === 'just taken', JSON.stringify(res))
check('rolled back: 0 series, weeks 1-2 still free', count('booking_series') === 0 && count("bookings where guest_name = 'Probe Guest'") === 0)

// ---------------------------------------------------------------------------
psql(`delete from auth.users where email = '${email}'`)
seed()
console.log(`\n${failures === 0 ? 'All checks passed' : `${failures} check(s) FAILED`} (test data reset)`)
process.exit(failures ? 1 : 0)
