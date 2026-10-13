// Proof script for feature 3 (spam protection), stage 3: CAPTCHA via an Edge Function. Local only.
// Run: npm run probe:spam:proof:captcha   (resets the spam test host before and after)
// Needs: `npm run probe:spam:setup` once and `npm run functions:serve`.
//
// With Cloudflare's TEST secret, any non-empty token passes ("XXXX.DUMMY.TOKEN.XXXX" is what the
// test site key produces in the browser). So this proves the wiring (no token → no booking,
// no way around the check), not Cloudflare's bot detection itself.
import { createClient } from '@supabase/supabase-js'
import { execSync } from 'node:child_process'

const DB = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const HOST = '22222222-2222-4222-8222-222222222222'
const URL = process.env.VITE_SUPABASE_URL
const KEY = process.env.VITE_SUPABASE_ANON_KEY
const TOKEN = 'XXXX.DUMMY.TOKEN.XXXX'
const psql = (q) => execSync(`psql ${DB} -At -F'|' -c "${q.replace(/"/g, '\\"')}"`).toString().trim()
const seed = () => execSync('npm run -s probe:spam:seed', { stdio: 'ignore' })
const rand = () => Math.random().toString(36).slice(2, 8)
const captchaOn = (on = true) => psql(`update profiles set require_captcha = ${on} where id = '${HOST}'`)
const freeSlot = (offset = 0) => psql(`select id from slots where host_id = '${HOST}' and not is_booked order by starts_at offset ${offset} limit 1`)
const booked = () => Number(psql(`select count(*) from bookings b join slots s on s.id = b.slot_id where s.host_id = '${HOST}'`))
process.on('exit', seed)

let failures = 0
function check(name, ok, detail) {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `\n      → ${detail}` : ''}`)
}
const api = (path, body, { bearer = KEY, headers = {} } = {}) =>
  fetch(`${URL}${path}`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', Prefer: 'return=minimal', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))
const direct = (opts) => api('/rest/v1/bookings', { slot_id: freeSlot(), guest_name: `Bot ${rand()}`, guest_email: `bot-${rand()}@example.com`, cancel_token: crypto.randomUUID() }, opts)
const viaFunction = (fields = {}) => api('/functions/v1/book-slot', { slotId: freeSlot(), guestName: 'Human', guestEmail: `human-${rand()}@example.com`, cancelToken: crypto.randomUUID(), captchaToken: TOKEN, ...fields })

const fnUp = await fetch(`${URL}/functions/v1/book-slot`, { method: 'OPTIONS', signal: AbortSignal.timeout(15000) }).then((r) => r.ok).catch(() => false)
if (!fnUp) { console.error('FAIL  functions serve is not running (npm run functions:serve)'); process.exit(1) }

// ===========================================================================
console.log('\n# 1. No way around the CAPTCHA (host requires it)')
seed(); captchaOn()
let r = await direct()
check('guest books directly through the API → 403 "requires a CAPTCHA check"', r.status === 403 && r.body?.code === 'PT403', JSON.stringify(r))
const user = createClient(URL, KEY, { auth: { persistSession: false } })
const { data: signUp } = await user.auth.signUp({ email: `captcha-bot-${Date.now()}@test.dev`, password: 'secret123' })
r = await direct({ bearer: signUp.session.access_token })
check('…as a logged-in user (anyone can sign up) → 403 too', r.status === 403 && r.body?.code === 'PT403', JSON.stringify(r))
psql(`delete from auth.users where email like 'captcha-bot-%@test.dev'`)
r = await direct({ headers: { 'app.captcha_verified': 'true', 'X-Captcha-Verified': 'true', Prefer: 'return=minimal, tx=commit' } })
check('…with headers trying to set the CAPTCHA mark → 403 (clients can\'t set it)', r.status === 403, JSON.stringify(r))
const first = psql(`select to_char(starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') from slots where host_id = '${HOST}' order by starts_at limit 1`)
r = await api('/rest/v1/rpc/book_recurring', { p_host_id: HOST, p_first_starts_at: first, p_weeks: 2, p_guest_name: 'Bot', p_guest_email: 'bot@example.com' })
check('…through the recurring rpc → 403, nothing saved (series rolled back)', r.status === 403 && psql(`select count(*) from booking_series where host_id = '${HOST}'`) === '0', JSON.stringify(r))
const flood = await Promise.all(Array.from({ length: 50 }, (_, i) => api('/rest/v1/bookings', { slot_id: freeSlot(i), guest_name: `Bot ${rand()}`, guest_email: `bot-${rand()}@example.com`, cancel_token: crypto.randomUUID() })))
check(`the stage 1 flood (50 parallel direct bookings) → ${booked()} booked`, booked() === 0 && flood.every((x) => x.status === 403))
check('…and the bots used up none of the rate-limit quota (CAPTCHA is checked before the limits)', psql(`select count(*) from booking_rate_events where host_id = '${HOST}'`) === '0')

// ===========================================================================
console.log('\n# 2. Humans book through the CAPTCHA (Edge Function book-slot)')
r = await viaFunction({ captchaToken: undefined })
check('book-slot without a token → 403 captcha_failed, nothing booked', r.status === 403 && r.body?.error?.code === 'captcha_failed' && booked() === 0, JSON.stringify(r))
r = await viaFunction()
check('book-slot with a solved CAPTCHA → 201, booked', r.status === 201 && booked() === 1, JSON.stringify(r))
check('…the guest\'s IP reached the database (hashed): the IP limit now applies to this path too',
  psql(`select bool_and(ip_hash is not null) from booking_rate_events where host_id = '${HOST}'`) === 't')
const sameEmail = []
for (let i = 0; i < 4; i++) sameEmail.push(await viaFunction({ guestEmail: 'same-human@example.com' }))
check('stage 2 limits still apply through the function: 4th booking for one email → 429 per_email (max 3 active)',
  sameEmail.slice(0, 3).every((x) => x.status === 201) && sameEmail[3].status === 429, JSON.stringify(sameEmail.map((x) => x.status)))
psql(`update rate_limit_settings set max_per_ip = ${Number(psql('select count(*) from booking_rate_events where ip_hash is not null'))} where id = 1`)
r = await viaFunction()
check('…and the IP limit too (closes stage 2\'s "Edge Functions have no IP" weakness) → 429 per_ip',
  r.status === 429 && /network/.test(r.body?.error?.message ?? ''), JSON.stringify(r))
psql(`update rate_limit_settings set max_per_ip = 30 where id = 1`)

seed(); captchaOn()
const firstSlot = psql(`select to_char(starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') from slots where host_id = '${HOST}' order by starts_at limit 1`)
const recurring = (extra) => api('/functions/v1/book-recurring', { hostId: HOST, firstStartsAt: firstSlot, weeks: 2, guestName: 'Weekly Human', guestEmail: `weekly-${rand()}@example.com`, ...extra })
r = await recurring({})
check('recurring booking (book-recurring) without a token → 403', r.status === 403, JSON.stringify(r))
r = await recurring({ captchaToken: TOKEN })
check('…with a solved CAPTCHA → 2 weeks booked', r.status === 200 && r.body?.weeks?.length === 2, JSON.stringify(r))

// ===========================================================================
console.log('\n# 3. Hosts who don\'t require a CAPTCHA: unchanged')
seed()
r = await direct()
check('direct booking still works (201)', r.status === 201 && booked() === 1, JSON.stringify(r))

console.log('\n# 4. What this can\'t prove locally')
seed(); captchaOn()
r = await viaFunction({ captchaToken: 'anything-a-bot-makes-up' })
check('WEAKNESS with Cloudflare\'s TEST secret any made-up token passes; only real keys prove bot detection', r.status === 201, JSON.stringify(r))

console.log(`\n${failures === 0 ? 'All checks passed' : `${failures} check(s) FAILED`} (spam host reset)`)
process.exit(failures ? 1 : 0)
