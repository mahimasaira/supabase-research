// Feature 3 (spam protection), stage 4: the same attacks against three protection levels.
// Run: npm run probe:spam:compare   (~1-2 min; resets the spam test host before and after)
// Needs `npm run functions:serve` (the CAPTCHA level books through book-slot).
//
//   none     limits set so high they never trigger (= the stage 1 situation)
//   limits   stage 2 defaults: 3 active per email per host, 10 per host / 30 per IP per 10 min
//   captcha  limits + the host requires a CAPTCHA (stage 3)
// Prints a table of what each level stops, what a REAL guest experiences after the attack, and
// what a normal booking costs in time. Checks assert the expected pattern.
import { createClient } from '@supabase/supabase-js'
import { execSync } from 'node:child_process'

const DB = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const HOST = '22222222-2222-4222-8222-222222222222'
const URL = process.env.VITE_SUPABASE_URL
const KEY = process.env.VITE_SUPABASE_ANON_KEY
const TOKEN = 'XXXX.DUMMY.TOKEN.XXXX' // what Cloudflare's test site key produces in a browser
const psql = (q) => execSync(`psql ${DB} -At -F'|' -c "${q.replace(/"/g, '\\"')}"`).toString().trim()
const seed = () => execSync('npm run -s probe:spam:seed', { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rand = () => Math.random().toString(36).slice(2, 8)

// DocuSign safety switch: function URLs unreachable during the run; reset data FIRST on exit.
const vaultUrls = ['docusign_send_url', 'docusign_void_url']
const saved = Object.fromEntries(vaultUrls.map((n) => [n, psql(`select coalesce(max(decrypted_secret), '') from vault.decrypted_secrets where name = '${n}'`)]))
const setUrl = (n, url) => psql(`select vault.update_secret(id, '${url.replace(/'/g, "''")}') from vault.secrets where name = '${n}'`)
vaultUrls.forEach((n) => saved[n] && setUrl(n, 'http://127.0.0.1:9/unreachable'))
process.on('exit', () => { seed(); vaultUrls.forEach((n) => saved[n] && setUrl(n, saved[n])) })

const fnUp = await fetch(`${URL}/functions/v1/book-slot`, { method: 'OPTIONS', signal: AbortSignal.timeout(15000) }).then((r) => r.ok).catch(() => false)
if (!fnUp) { console.error('FAIL  functions serve is not running (npm run functions:serve)'); process.exit(1) }

// ---- levels ----
const LEVELS = ['none', 'limits', 'captcha']
function setLevel(level) {
  seed()
  if (level === 'none') psql(`update rate_limit_settings set max_active_per_email = 100000, max_per_host = 100000, max_per_ip = 100000 where id = 1`)
  if (level === 'captcha') psql(`update profiles set require_captcha = true where id = '${HOST}'`)
}

// ---- how bots and humans book ----
const post = (path, body, bearer = KEY, headers = {}) =>
  fetch(`${URL}${path}`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', Prefer: 'return=minimal', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  }).then((r) => r.status)
const freeSlots = () => psql(`select string_agg(id::text, ',' order by starts_at) from slots where host_id = '${HOST}' and not is_booked`).split(',').filter(Boolean)
const booked = () => Number(psql(`select count(*) from bookings b join slots s on s.id = b.slot_id where s.host_id = '${HOST}' and b.status <> 'cancelled'`))
// Bots skip the booking page: straight to the API.
const bot = (slotId, { email = `bot-${rand()}@example.com`, bearer, headers } = {}) =>
  post('/rest/v1/bookings', { slot_id: slotId, guest_name: `Bot ${rand()}`, guest_email: email, cancel_token: crypto.randomUUID() }, bearer, headers)
// A human uses the booking page: book-slot with a solved CAPTCHA if the host requires one.
const human = (level, slotId, email = `human-${rand()}@example.com`) => level === 'captcha'
  ? post('/functions/v1/book-slot', { slotId, guestName: 'Real Guest', guestEmail: email, cancelToken: crypto.randomUUID(), captchaToken: TOKEN })
  : bot(slotId, { email })

// ---- the attacks ----
const results = {} // results[attack][level] = text
const raw = {}
const record = (attack, level, text, value) => {
  ;(results[attack] ??= {})[level] = text
  ;(raw[attack] ??= {})[level] = value
}

for (const level of LEVELS) {
  console.log(`\n# Level: ${level}`)

  setLevel(level)
  let t0 = performance.now()
  await Promise.all(freeSlots().map((id) => bot(id)))
  const took = Math.round(performance.now() - t0)
  let n = booked()
  record('Calendar takeover (50 parallel bot bookings)', level, `${n}/50 booked (${took} ms)`, n)
  // What does a real guest experience right after that attack?
  const freeAfter = freeSlots()
  const realGuest = freeAfter.length ? await human(level, freeAfter[0]) : 'no free slot'
  record('Real guest right after the takeover', level,
    realGuest === 201 ? 'can book ✅' : realGuest === 'no free slot' ? 'nothing left to book ❌' : `blocked (${realGuest}) ❌`, realGuest)

  setLevel(level)
  for (const id of freeSlots().slice(0, 10)) await bot(id, { email: 'same-bot@example.com' })
  n = booked()
  record('One email, 10 bookings', level, `${n}/10 booked`, n)

  setLevel(level)
  for (const id of freeSlots().slice(0, 10)) await bot(id, { email: `same-bot+${rand()}@example.com` })
  n = booked()
  record('Email variations (name+xyz@…), 10 bookings', level, `${n}/10 booked`, n)

  setLevel(level)
  if (level !== 'none') psql(`update rate_limit_settings set max_per_host = 100000 where id = 1`) // isolate the IP limit
  for (const id of freeSlots().slice(0, 40)) await bot(id, { headers: { 'X-Forwarded-For': `${rand().length}.${rand().length}.1.1` } })
  n = booked()
  record('Fake IP headers, 40 bookings (host limit lifted)', level, `${n}/40 booked`, n)

  setLevel(level)
  const user = createClient(URL, KEY, { auth: { persistSession: false } })
  const { data: su } = await user.auth.signUp({ email: `compare-bot-${Date.now()}@test.dev`, password: 'secret123' })
  await Promise.all(freeSlots().slice(0, 20).map((id) => bot(id, { bearer: su.session.access_token })))
  n = booked()
  record('Bot signs up first, then 20 bookings', level, `${n}/20 booked`, n)
  psql(`delete from auth.users where email like 'compare-bot-%@test.dev'`)

  setLevel(level)
  const first = psql(`select to_char(starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') from slots where host_id = '${HOST}' order by starts_at limit 1`)
  const rpc = await post('/rest/v1/rpc/book_recurring', { p_host_id: HOST, p_first_starts_at: first, p_weeks: 2, p_guest_name: 'Bot', p_guest_email: 'bot@example.com' })
  record('Recurring rpc (bypassing the page)', level, rpc === 200 ? 'booked' : `refused (${rpc})`, rpc)

  setLevel(level)
  psql(`update profiles set require_signature = true where id = '${HOST}'`)
  const lastId = psql('select last_value from net.http_request_queue_id_seq')
  await Promise.all(freeSlots().map((id) => bot(id)))
  for (let i = 0; i < 60 && psql('select count(*) from net.http_request_queue') !== '0'; i++) await sleep(250)
  await sleep(1500)
  n = Number(psql(`select count(*) from net._http_response where id > ${lastId}`))
  record('DocuSign emails from 50 bot bookings', level, `${n} emails`, n)

  // Cost for an honest guest: average time of 5 sequential bookings.
  setLevel(level)
  const times = []
  for (const id of freeSlots().slice(0, 5)) {
    const s = performance.now()
    await human(level, id)
    times.push(performance.now() - s)
  }
  const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length)
  record('Normal booking, average time', level, `${avg} ms`, avg)
  console.log(`  done (${Object.keys(results).length} attacks measured)`)
}

// ---- the table ----
const rows = Object.keys(results)
const width = Math.max(...rows.map((r) => r.length))
const col = (s) => String(s).padEnd(24)
console.log(`\n${''.padEnd(width)}  ${col('none')}${col('limits')}${col('limits + CAPTCHA')}`)
for (const r of rows) console.log(`${r.padEnd(width)}  ${LEVELS.map((l) => col(results[r][l])).join('')}`)

// ---- expected pattern ----
let failures = 0
const check = (name, ok) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`) }
const R = (a) => raw[Object.keys(raw).find((k) => k.startsWith(a))]
console.log()
check('none: the calendar is taken (50), limits: 10, CAPTCHA: 0', R('Calendar takeover').none === 50 && R('Calendar takeover').limits === 10 && R('Calendar takeover').captcha === 0)
check('real guest after the takeover: blocked with limits (host lock-out), can book with CAPTCHA', R('Real guest').limits !== 201 && R('Real guest').captcha === 201)
check('one email: limits stop at 3, CAPTCHA at 0', R('One email').limits === 3 && R('One email').captcha === 0)
check('email variations get past the per-email limit (host limit still caps at 10); CAPTCHA: 0', R('Email variations').limits === 10 && R('Email variations').captcha === 0)
check('fake IP headers don\'t get past the IP limit (30); CAPTCHA: 0', R('Fake IP').limits === 30 && R('Fake IP').captcha === 0)
check('a signed-up bot is limited like a guest (10), refused with CAPTCHA (0)', R('Bot signs up').limits === 10 && R('Bot signs up').captcha === 0)
check('recurring rpc: allowed without CAPTCHA, refused with it', R('Recurring rpc').limits === 200 && R('Recurring rpc').captcha === 403)
check('DocuSign emails: 50 → 10 → 0', R('DocuSign emails').none === 50 && R('DocuSign emails').limits === 10 && R('DocuSign emails').captcha === 0)
console.log(`\n${failures === 0 ? 'All checks passed' : `${failures} check(s) FAILED`} (spam host reset, DocuSign sending restored)`)
process.exit(failures ? 1 : 0)
