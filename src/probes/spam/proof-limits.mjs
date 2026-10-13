// Proof script for feature 3 (spam protection), stage 2: limits inside the database. Local only.
// Run: npm run probe:spam:proof:limits   (resets the spam test host before and after)
//
// 1. The stage 1 attacks again, now expected to be STOPPED (HTTP 429).
// 2. Trying to get around the limits. Checks marked "WEAKNESS" pass when the weakness is
//    demonstrated: they document what database limits can't do.
// Limits are tuned per test through rate_limit_settings (the database owner may do that).
import { createClient } from '@supabase/supabase-js'
import { execSync } from 'node:child_process'

const DB = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const HOST = '22222222-2222-4222-8222-222222222222'
const URL = process.env.VITE_SUPABASE_URL
const KEY = process.env.VITE_SUPABASE_ANON_KEY
const psql = (q) => execSync(`psql ${DB} -At -F'|' -c "${q.replace(/"/g, '\\"')}"`).toString().trim()
const seed = () => execSync('npm run -s probe:spam:seed', { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rand = () => Math.random().toString(36).slice(2, 8)
const setLimits = (sql) => psql(`update rate_limit_settings set ${sql} where id = 1`)

// DocuSign safety switch (round D): reset data FIRST, then switch sending back on (also after a crash).
const vaultUrls = ['docusign_send_url', 'docusign_void_url']
const saved = Object.fromEntries(vaultUrls.map((n) => [n, psql(`select coalesce(max(decrypted_secret), '') from vault.decrypted_secrets where name = '${n}'`)]))
const setUrl = (n, url) => psql(`select vault.update_secret(id, '${url.replace(/'/g, "''")}') from vault.secrets where name = '${n}'`)
process.on('exit', () => { seed(); vaultUrls.forEach((n) => saved[n] && setUrl(n, saved[n])) })

let failures = 0
function check(name, ok, detail) {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `\n      → ${detail}` : ''}`)
}

// Raw HTTP, so the status code (429) and extra headers (spoofing) are visible.
const book = (slotId, { name = `Bot ${rand()}`, email = `bot-${rand()}@example.com`, headers = {} } = {}) =>
  fetch(`${URL}/rest/v1/bookings`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal', ...headers },
    body: JSON.stringify({ slot_id: slotId, guest_name: name, guest_email: email, cancel_token: crypto.randomUUID() }),
  }).then(async (r) => ({ status: r.status, body: r.status >= 400 ? await r.json().catch(() => ({})) : null }))
const limitOf = (r) => { try { return JSON.parse(r.body?.details ?? '{}').limit } catch { return undefined } }
const tally = (results) => results.reduce((t, r) => { const k = r.status === 429 ? `429 ${limitOf(r)}` : String(r.status); t[k] = (t[k] ?? 0) + 1; return t }, {})
const freeSlots = () => psql(`select string_agg(id::text, ',' order by starts_at) from slots where host_id = '${HOST}' and not is_booked`).split(',').filter(Boolean)

// ===========================================================================
console.log('\n# 1. The stage 1 attacks again')
seed()
let slots = freeSlots()
let t0 = performance.now()
let res = await Promise.all(slots.map((id) => book(id)))
let ms = Math.round(performance.now() - t0)
let t = tally(res)
check(`A. take every slot (50 in parallel, new email each): only ${t['201'] ?? 0} booked, ${t['429 per_host'] ?? 0} refused with 429 (${ms} ms)`,
  t['201'] === 10 && t['429 per_host'] === 40, JSON.stringify(t))
check(`   …${freeSlots().length} of 50 slots still free for real guests`, freeSlots().length === 40)

seed()
slots = freeSlots()
res = []
for (const id of slots.slice(0, 10)) res.push(await book(id, { email: 'same-guest@example.com' }))
t = tally(res)
check(`B. one email: ${t['201'] ?? 0} accepted, then 429 per_email`, t['201'] === 3 && t['429 per_email'] === 7, JSON.stringify(t))

seed()
slots = freeSlots()
res = []
for (let batch = 0; batch < 10; batch++) res.push(...await Promise.all(slots.map((id) => book(id))))
t = tally(res)
check(`C. burst of ${res.length} writes: ${t['201'] ?? 0} booked, the rest refused (${JSON.stringify(t)})`, t['201'] === 10 && (t['429 per_host'] ?? 0) > 0)

seed()
vaultUrls.forEach((n) => saved[n] && setUrl(n, 'http://127.0.0.1:9/unreachable'))
psql(`update profiles set require_signature = true where id = '${HOST}'`)
const lastId = psql('select last_value from net.http_request_queue_id_seq')
res = await Promise.all(freeSlots().map((id) => book(id)))
for (let i = 0; i < 60 && psql('select count(*) from net.http_request_queue') !== '0'; i++) await sleep(250)
await sleep(1500)
const sends = Number(psql(`select count(*) from net._http_response where id > ${lastId}`))
check(`D. DocuSign multiplier: 50 fake bookings → ${sends} send requests (was 50)`, sends === 10, `send requests: ${sends}`)

// ===========================================================================
console.log('\n# 2. Getting around the limits')

seed()
setLimits('max_per_host = 1000, max_per_ip = 5')
slots = freeSlots()
res = []
for (const id of slots.slice(0, 8)) {
  res.push(await book(id, { headers: { 'X-Forwarded-For': `${10 + res.length}.${rand().length}.0.1`, 'X-Real-IP': '9.9.9.9', 'CF-Connecting-IP': '8.8.8.8' } }))
}
t = tally(res)
check(`fake IP headers (new X-Forwarded-For each time): still ${t['201'] ?? 0} accepted, then 429 per_ip (only the last, proxy-added entry counts)`,
  t['201'] === 5 && t['429 per_ip'] === 3, JSON.stringify(t))

const realGuest = await book(slots[20], { name: 'Real Guest', email: 'real.guest@example.com' })
check('WEAKNESS shared IP: a real guest on the same network (same IP) is now blocked too', realGuest.status === 429 && limitOf(realGuest) === 'per_ip', JSON.stringify(realGuest))

seed()
setLimits('max_per_ip = 1000') // per host stays 10
slots = freeSlots()
await Promise.all(slots.slice(0, 10).map((id) => book(id)))
const lockedOut = await book(slots[20], { name: 'Real Guest', email: 'real.guest@example.com' })
check('WEAKNESS host lock-out: after 10 bot bookings, real guests can\'t book this host for 10 minutes', lockedOut.status === 429 && limitOf(lockedOut) === 'per_host', JSON.stringify(lockedOut))
check('   …and the bots still hold 10 slots (the limit slows them down, it doesn\'t undo anything)', freeSlots().length === 40)

seed()
slots = freeSlots()
res = []
for (const id of slots.slice(0, 8)) res.push(await book(id, { email: `same-guest+${rand()}@example.com` }))
t = tally(res)
check(`WEAKNESS email variations (same-guest+xyz@…): ${t['201'] ?? 0} accepted, the per-email limit can't tell they're one person`, t['201'] === 8, JSON.stringify(t))

seed()
setLimits('max_per_ip = 1')
psql(`insert into bookings (slot_id, guest_name, guest_email, cancel_token)
  select id, 'Direct ' || n, 'direct' || n || '@example.com', gen_random_uuid()
    from (select id, row_number() over (order by starts_at) as n from slots where host_id = '${HOST}' and not is_booked limit 3) s`)
const viaOwner = Number(psql(`select count(*) from bookings where guest_name like 'Direct %'`))
check(`WEAKNESS no HTTP request, no IP: ${viaOwner} bookings over a direct connection (Studio, Edge Functions) aren't IP-limited`, viaOwner === 3)
const fnUp = await fetch(`${URL}/functions/v1/book-recurring`, { method: 'OPTIONS', signal: AbortSignal.timeout(15000) }).then((r) => r.ok).catch(() => false)
if (fnUp) {
  const viaFn = []
  for (const week of [5, 7]) {
    const first = psql(`select to_char(starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') from slots where host_id = '${HOST}' and not is_booked order by starts_at offset ${week} limit 1`)
    viaFn.push(await fetch(`${URL}/functions/v1/book-recurring`, {
      method: 'POST',
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostId: HOST, firstStartsAt: first, weeks: 2, guestName: `Fn ${rand()}`, guestEmail: `fn-${rand()}@example.com` }),
    }).then((r) => r.status))
  }
  check(`WEAKNESS the Edge Function path (book-recurring) has no IP either: ${viaFn.filter((s) => s === 409 || s === 200).length} of 2 calls got past the IP limit of 1 (it would have to forward the IP itself)`,
    viaFn.every((s) => s !== 429), JSON.stringify(viaFn))
} else {
  console.log('SKIP  Edge Function path: functions serve is not running')
}

seed()
const [w1, w1Start] = psql(`select id || '|' || to_char(starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') from slots where host_id = '${HOST}' order by starts_at limit 1`).split('|')
const anon = createClient(URL, KEY, { auth: { persistSession: false } })
// Slots repeat daily at the same time; a "weekly" series needs the same weekday+time 7 days later: slot 1 and slot 36 (day 1 and day 8, 09:00).
const rec = await anon.rpc('book_recurring', { p_host_id: HOST, p_first_starts_at: w1Start, p_weeks: 2, p_guest_name: 'Weekly', p_guest_email: 'weekly@example.com' })
const recCount = psql(`select count(*) || '|' || (select count(*) from booking_rate_events where host_id = '${HOST}') from bookings where guest_name = 'Weekly'`)
check('a recurring booking (2 weeks) is counted once, not per week', !rec.error && recCount === '2|1', JSON.stringify({ error: rec.error, bookings_events: recCount }))

console.log('\n# 3. Privacy')
const stored = psql(`select count(*) || '|' || bool_and(ip_hash ~ '^[0-9a-f]{64}$') from booking_rate_events where ip_hash is not null`)
check('only salted hashes of IPs are stored (no addresses)', stored.split('|')[1] === 'true', stored)
check('IP hashes are deleted after a day (pg_cron job rate-limit-cleanup)', psql(`select count(*) from cron.job where jobname = 'rate-limit-cleanup'`) === '1')

console.log(`\n${failures === 0 ? 'All checks passed' : `${failures} check(s) FAILED`} (test data and limits reset)`)
process.exit(failures ? 1 : 0)
