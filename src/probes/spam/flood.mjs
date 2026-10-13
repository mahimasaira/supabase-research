// Feature 3 (spam protection), stage 1: show the problem. Local only.
// Run: npm run probe:spam:flood   (resets the spam test host before and after)
//
// Acts like an attacker who has only what every visitor's browser has: the project URL and
// the publishable key. Everything goes through the same public API as the booking page.
//   A. take every slot of a host        B. one email, many bookings
//   C. a burst of requests (any 429?)   D. the DocuSign multiplier (sending switched OFF)
// "PASS" here means: the problem was reproduced. Stage 2 adds limits and a proof that they hold.
import { createClient } from '@supabase/supabase-js'
import { execSync } from 'node:child_process'

const DB = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const HOST = '22222222-2222-4222-8222-222222222222'
const URL = process.env.VITE_SUPABASE_URL
const KEY = process.env.VITE_SUPABASE_ANON_KEY
const psql = (q) => execSync(`psql ${DB} -At -F'|' -c "${q.replace(/"/g, '\\"')}"`).toString().trim()
const seed = () => execSync('npm run -s probe:spam:seed', { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const anon = createClient(URL, KEY, { auth: { persistSession: false } })
const count = (where) => Number(psql(`select count(*) from bookings b join slots s on s.id = b.slot_id where s.host_id = '${HOST}' ${where}`))

// DocuSign safety switch (round D): function URLs unreachable while fake bookings exist.
// On exit (also after a crash): reset the data FIRST, then switch sending back on,
// otherwise the retry job (every minute) would send agreements to the fake addresses.
const vaultUrls = ['docusign_send_url', 'docusign_void_url']
const saved = Object.fromEntries(vaultUrls.map((n) => [n, psql(`select coalesce(max(decrypted_secret), '') from vault.decrypted_secrets where name = '${n}'`)]))
const setUrl = (n, url) => psql(`select vault.update_secret(id, '${url.replace(/'/g, "''")}') from vault.secrets where name = '${n}'`)
process.on('exit', () => {
  seed()
  vaultUrls.forEach((n) => saved[n] && setUrl(n, saved[n]))
})

let failures = 0
function check(name, ok, detail) {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      → ${detail}` : ''}`)
}
const findings = []
const rand = () => Math.random().toString(36).slice(2, 8)

// What an attacker does first: ask the public API which slots are free.
const freeSlots = async () => (await anon.from('slots').select('id').eq('host_id', HOST).eq('is_booked', false).gt('starts_at', new Date().toISOString())).data
const bookAll = (slots, email) => Promise.all(slots.map((s) =>
  anon.from('bookings').insert({ slot_id: s.id, guest_name: `Bot ${rand()}`, guest_email: email ?? `bot-${rand()}@example.com`, cancel_token: crypto.randomUUID() })))

// ===========================================================================
console.log('\n# A. Take every slot of a host')
seed()
let slots = await freeSlots()
let t0 = performance.now()
let results = await bookAll(slots)
let ms = Math.round(performance.now() - t0)
let ok = results.filter((r) => !r.error).length
check(`${ok} of ${slots.length} slots booked by one script in ${ms} ms (parallel, fake names and emails)`, ok === 50 && slots.length === 50)
const left = (await freeSlots()).length
check(`the host's booking page now offers ${left} free slots`, left === 0)
findings.push(['A', `whole calendar (50 slots) booked in ${ms} ms`])

// ===========================================================================
console.log('\n# B. One email, many bookings')
seed()
slots = await freeSlots()
results = await bookAll(slots, 'same-guest@example.com')
ok = results.filter((r) => !r.error).length
check(`${ok} bookings accepted for the SAME email address`, ok === 50, null)
findings.push(['B', `${ok} bookings for one email, no per-guest limit`])

// ===========================================================================
console.log('\n# C. A burst of requests')
seed()
slots = await freeSlots()
const statuses = {}
t0 = performance.now()
for (let batch = 0; batch < 10; batch++) {
  // 10 × 50 parallel inserts: the first 50 take the slots, the rest are rejected as taken.
  const res = await Promise.all(slots.map((s) => fetch(`${URL}/rest/v1/bookings`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ slot_id: s.id, guest_name: `Burst ${rand()}`, guest_email: `burst-${rand()}@example.com`, cancel_token: crypto.randomUUID() }),
  }).then((r) => r.status)))
  for (const st of res) statuses[st] = (statuses[st] ?? 0) + 1
}
ms = Math.round(performance.now() - t0)
const total = Object.values(statuses).reduce((a, b) => a + b, 0)
const perSecond = Math.round(total / (ms / 1000))
check(`${total} write requests in ${ms} ms (~${perSecond}/s), never answered 429 "too many requests"`,
  !statuses[429], `HTTP status counts: ${JSON.stringify(statuses)} (201 = booked, 401/409 = slot already taken)`)
findings.push(['C', `${total} writes in ${ms} ms (~${perSecond}/s), no 429: ${JSON.stringify(statuses)}`])

// ===========================================================================
console.log('\n# D. The DocuSign multiplier (sending switched off: nothing reaches DocuSign)')
seed()
vaultUrls.forEach((n) => saved[n] && setUrl(n, 'http://127.0.0.1:9/unreachable'))
psql(`update profiles set require_signature = true where id = '${HOST}'`)
const drain = async () => {
  for (let i = 0; i < 60 && psql('select count(*) from net.http_request_queue') !== '0'; i++) await sleep(250)
  await sleep(1500)
}
// Count responses to requests newer than the start (pg_net cleans up OLD responses
// periodically, so "rows after minus rows before" can even come out negative).
await drain()
const lastId = psql('select last_value from net.http_request_queue_id_seq')
slots = await freeSlots()
results = await bookAll(slots)
await drain()
const sendRequests = Number(psql(`select count(*) from net._http_response where id > ${lastId}`))
ok = results.filter((r) => !r.error).length
check(`${ok} fake bookings on a host that requires signatures → ${sendRequests} DocuSign send requests (= agreement emails)`,
  ok === 50 && sendRequests === 50, `waiting bookings: ${count(`and b.status = 'pending_signature'`)}`)
findings.push(['D', `${ok} fake bookings → ${sendRequests} agreement emails from our DocuSign account (if sending were on)`])

// ===========================================================================
console.log('\n# Summary')
for (const [round, text] of findings) console.log(`  ${round}. ${text}`)
console.log(`\n${failures === 0 ? 'All problems reproduced' : `${failures} check(s) did NOT reproduce`} (test data reset, DocuSign sending restored)`)
process.exit(failures ? 1 : 0)
