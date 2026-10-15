// npm run hosted:ip: can a client fake its IP address on the hosted project?
// Locally (feature 3, stage 2): X-Forwarded-For lists every hop; a client can PREPEND fake entries,
// the proxy APPENDS the real one, so the database trusts only the LAST entry. Behind Supabase's
// real proxy chain this has to be checked again.
//   1. What the Edge Function receives, with and without fake headers.
//   2. What the database's per-IP limit does with fake headers (the same round as proof-limits).
import { URL, KEY, check, finish, note, probe, psql, requireLockdown } from './hosted-env.mjs'

requireLockdown()
const HOST = '22222222-2222-4222-8222-222222222222'
const fake = { 'x-forwarded-for': '203.0.113.7', 'x-real-ip': '203.0.113.8', 'cf-connecting-ip': '203.0.113.9' }
const show = (h) => Object.entries(h).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(' · ') || '(none)'
const entries = (h) => (h['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)

console.log('\n# 1. Headers as the Edge Function sees them')
const plain = await (await probe({ mode: 'headers' })).json()
note(`no fake headers:   ${show(plain)}`)
const spoofed = await (await probe({ mode: 'headers' }, fake)).json()
note(`with fake headers: ${show(spoofed)}`)
const xff = entries(spoofed)
note(`fake X-Forwarded-For entry kept: ${xff.includes(fake['x-forwarded-for']) ? `yes, at position ${xff.indexOf(fake['x-forwarded-for']) + 1} of ${xff.length}` : 'no (dropped or replaced)'}`)
note(`last X-Forwarded-For entry: ${xff.at(-1)} (same as without fake headers: ${xff.at(-1) === entries(plain).at(-1)})`)
check('the last X-Forwarded-For entry is not the faked one', xff.at(-1) !== fake['x-forwarded-for'], JSON.stringify(spoofed))
for (const h of ['x-real-ip', 'cf-connecting-ip']) note(`${h}: ${spoofed[h] === fake[h] ? 'TAKEN FROM THE CLIENT (spoofable)' : `not the fake value (${spoofed[h] ?? 'absent'})`}`)

console.log('\n# 2. The per-IP booking limit with a new fake IP on every request')
try {
  psql(null, { file: 'src/probes/spam/sql/seed.sql' })
} catch (e) {
  console.error(`Seeding the spam test host failed on the hosted database: ${e.message}`)
  console.error('(The seed inserts into auth.users directly; if the hosted project refuses that, record it and skip section 2.)')
  finish('IP checks')
}
psql(`update rate_limit_settings set max_per_host = 1000, max_per_ip = 5 where id = 1`)
const slots = psql(`select string_agg(id::text, ',' order by starts_at) from slots where host_id = '${HOST}' and not is_booked`).split(',').slice(0, 10)
const statuses = []
for (const [n, id] of slots.entries()) {
  const r = await fetch(`${URL}/rest/v1/bookings`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal',
      'X-Forwarded-For': `198.51.100.${n + 1}`, 'X-Real-IP': '9.9.9.9', 'CF-Connecting-IP': '8.8.8.8' },
    body: JSON.stringify({ slot_id: id, guest_name: 'Spoof', guest_email: `spoof${n}@example.com`, cancel_token: crypto.randomUUID() }),
  })
  statuses.push(r.status)
}
const [distinct, noIp] = psql(`select count(distinct ip_hash) || '|' || count(*) filter (where ip_hash is null) from booking_rate_events where host_id = '${HOST}'`).split('|')
note(`10 bookings, each with a new fake X-Forwarded-For: ${statuses.join(' ')}`)
note(`distinct IP hashes stored: ${distinct} (1 = fake entries ignored; 10 = spoofable); events without an IP: ${noIp}`)
check('per-IP limit held (5 accepted, then 429)', statuses.filter((s) => s === 201).length === 5 && statuses.slice(5).every((s) => s === 429), statuses.join(' '))
check('the database never counted a fake IP (1 distinct hash)', distinct === '1', `${distinct} distinct`)

psql(null, { file: 'src/probes/spam/sql/seed.sql' }) // also resets the limits and rate events
finish('IP checks')
