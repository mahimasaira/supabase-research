// Exposure scan: what can the public key (anon) and a normal logged-in user (a stranger host)
// do to data that isn't theirs? Run: npm run probe:security:scan (local)
// or npm run hosted:scan (the hosted project, after hosted:lockdown; see HOSTED_CHECKS.md).
//
// For EVERY table in the public schema: try read / insert / update / delete, as anon and as
// a stranger, against another host's row (or an internal row). Updates and deletes are checked
// in the database itself (did the row change?), not by trusting the API's answer.
// For EVERY function in public: call it through the API (rpc) as anon and as a stranger.
// Then Edge Functions, Storage, GraphQL and one abuse check (mass inserts).
// Each result is compared with what SHOULD be allowed (EXPECT below). A table or function the
// scan doesn't know yet fails as "not reviewed", so new ones can't slip through unnoticed.
import { createClient } from '@supabase/supabase-js'
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'

const DB = process.env.SCAN_DB_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
// On the hosted project the probe-only objects are closed (src/probes/hosted/sql/lockdown.sql).
const LOCKED = process.env.PROBES_LOCKED === '1'
const URL = process.env.VITE_SUPABASE_URL
const KEY = process.env.VITE_SUPABASE_ANON_KEY
// The connection string may hold a password (hosted): passed as an argument, never printed.
function psql(q) {
  const r = spawnSync('psql', [DB, '-At', '-F|', '-c', q], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`psql failed: ${(r.stderr || '').trim()}`)
  return r.stdout.trim()
}
const client = () => createClient(URL, KEY, { auth: { persistSession: false } })
const at = (h) => new Date(Date.now() + h * 3600_000).toISOString()
const run = Date.now()

let failures = 0
const mismatches = []
function check(name, ok, detail) {
  if (!ok) { failures++; mismatches.push(name) }
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `\n      → ${detail}` : ''}`)
}

// ---------------------------------------------------------------------------
// Setup: host B owns the data; host A is the "stranger"; anon is a visitor with the public key.
async function host(name) {
  const c = client()
  const { data, error } = await c.auth.signUp({ email: `${name}-${run}@test.dev`, password: 'secret123', options: { data: { display_name: name } } })
  if (error) throw error
  return { c, id: data.user.id }
}
const anon = client()
const A = await host('scan-stranger')
const B = await host('scan-owner')
process.on('exit', () => {
  psql(`delete from auth.users where id in ('${A.id}', '${B.id}')`) // cascades: profiles, slots, bookings, series, rate events
  psql(`delete from audit_log_client where host_id in ('${A.id}', '${B.id}') or changes->>'scan' = '${run}'`)
  psql(`delete from reminder_optouts where email_hash like 'scan-%'`)
  psql(`delete from test_mail_provider_log where id < 0`)
  psql(`delete from booking_series where guest_email like 'scan-%'`)
  psql(`delete from hosted_probe_heartbeats where run_id = 'scan-${run}'`)
})

const slot = async (h) => (await B.c.from('slots').insert({ host_id: B.id, starts_at: at(h), ends_at: at(h + 1) }).select().single()).data.id
const slotFree = await slot(100)        // target for slot update/delete
const slotBooked = await slot(102)      // gets a booking: hidden from everyone but B
const slotForAnon = await slot(104)     // anon may book it (by design)
const slotForStranger = await slot(106) // the stranger may book it too (any visitor can)
const token = crypto.randomUUID()
await anon.from('bookings').insert({ slot_id: slotBooked, guest_name: 'Real Guest', guest_email: 'real-guest@example.com', cancel_token: token })
const bookingB = psql(`select id from bookings where cancel_token = '${token}'`)
const seriesB = psql(`insert into booking_series (host_id, guest_name, guest_email, weekday, start_time, weeks) values ('${B.id}', 'Series Guest', 'series-guest@example.com', 1, '10:00', 3) returning id`).split('\n')[0]
const auditB = psql(`select id from audit_log where host_id = '${B.id}' limit 1`)
const clientAuditB = psql(`insert into audit_log_client (action, table_name, host_id, changes) values ('booking.created', 'bookings', '${B.id}', '{"scan": "${run}"}') returning id`).split('\n')[0]
psql(`insert into booking_rate_events (host_id, ip_hash) values ('${B.id}', 'scan')`)
const rateEventB = psql(`select id from booking_rate_events where host_id = '${B.id}' limit 1`)
psql(`insert into reminder_optouts (email_hash) values ('scan-${run}')`)
psql(`insert into test_mail_provider_log (id, accepted) overriding system value values (-${run % 1e9}, true)`)
const heartbeat = psql(`insert into hosted_probe_heartbeats (run_id, second, note) values ('scan-${run}', 0, 'start') returning id`).split('\n')[0]

// ---------------------------------------------------------------------------
// What SHOULD be possible. Letters: R read, I insert, U update, D delete (on B's / internal rows).
// note = why an open door is intended.
const T = {
  profiles: { key: 'id', row: B.id, expect: { anon: 'R', stranger: 'R' }, note: 'host names are public (booking page)',
    insert: () => ({ id: crypto.randomUUID(), display_name: 'fake' }), patch: { display_name: 'HACKED', require_captcha: false } },
  slots: { key: 'id', row: slotFree, readRow: slotBooked, expect: { anon: '', stranger: '' },
    insert: () => ({ host_id: B.id, starts_at: at(200), ends_at: at(201) }), patch: { starts_at: at(300), ends_at: at(301) } },
  bookings: { key: 'id', row: bookingB, expect: { anon: 'I', stranger: 'I' }, note: 'anyone may book a free slot',
    insert: (who) => ({ slot_id: who === 'anon' ? slotForAnon : slotForStranger, guest_name: 'Scan', guest_email: `scan-${who}@example.com`, cancel_token: crypto.randomUUID() }),
    patch: { status: 'cancelled' } },
  booking_series: { key: 'id', row: seriesB, expect: { anon: 'I', stranger: 'I' }, note: 'guests create a series (all 3 recurring stages need it); volume: see abuse check',
    insert: (who) => ({ host_id: B.id, guest_name: 'Scan', guest_email: `scan-${who}@example.com`, weekday: 1, start_time: '10:00', weeks: 2 }),
    patch: { guest_email: 'attacker@example.com' } },
  audit_log: { key: 'id', row: auditB, expect: { anon: '', stranger: '' },
    insert: () => ({ actor_role: 'authenticated', action: 'delete', table_name: 'bookings', record_id: bookingB, host_id: B.id }), patch: { action: 'forged' } },
  audit_log_client: { key: 'id', row: clientAuditB, expect: LOCKED ? { anon: '', stranger: '' } : { anon: 'I', stranger: 'I' },
    note: 'PROBE table (audit stage 1): deliberately forgeable locally; closed on the hosted project',
    insert: () => ({ action: 'booking.created', table_name: 'bookings', host_id: B.id, changes: { scan: String(run) } }), patch: { action: 'booking.forged' } },
  booking_rate_events: { key: 'id', row: rateEventB, expect: { anon: '', stranger: '' },
    insert: () => ({ host_id: B.id, ip_hash: 'scan' }), patch: { ip_hash: 'reset' } },
  rate_limit_settings: { key: 'id', row: 1, expect: { anon: '', stranger: '' },
    insert: () => ({ id: 99 }), patch: { max_per_host: 100000 } },
  reminder_optouts: { key: 'email_hash', row: `scan-${run}`, expect: { anon: '', stranger: '' },
    insert: () => ({ email_hash: `scan-insert-${run}` }), patch: { email_hash: `scan-moved-${run}` } },
  reminder_worker_lease: { key: 'id', row: 1, expect: { anon: '', stranger: '' },
    insert: () => ({ id: 99 }), patch: { holder: crypto.randomUUID(), expires_at: at(24 * 365) } },
  test_mail_provider_log: { key: 'id', row: -(run % 1e9), expect: { anon: '', stranger: '' }, note: 'PROBE table (test double)',
    insert: () => ({ accepted: true }), patch: { accepted: false } },
  sqli_probe_switch: { key: 'id', row: 1, expect: { anon: '', stranger: '' }, note: 'PROBE switch for the unsafe SQL-injection function',
    insert: () => ({ id: 99 }), patch: { unsafe_enabled_until: at(24) } },
  test_mail_provider_settings: { key: 'id', row: 1, expect: { anon: '', stranger: '' }, note: 'PROBE table (test double)',
    insert: () => ({ id: 99 }), patch: { limit_per_second: 0 } },
  hosted_probe_heartbeats: { key: 'id', row: heartbeat, expect: { anon: '', stranger: '' },
    insert: () => ({ run_id: 'scan', second: 0, note: 'forged' }), patch: { note: 'forged' } },
}

// Functions callable through the API on purpose (each checks its own input, e.g. a secret token).
const CALLABLE = {
  book_recurring: 'guests book a weekly series (SECURITY INVOKER: RLS applies)',
  cancel_booking: 'needs the guest\'s cancel token',
  get_booking_statuses: 'needs the guests\' cancel tokens',
  unsubscribe_reminders: 'needs the guest\'s cancel token',
  sqli_search_bookings_safe: 'SQL-injection probe, safe version (parameters / format %I); logged-in users only',
  sqli_probe_unsafe_enabled: 'only says whether the SQL-injection probe is on; logged-in users only',
}
// Known functions that must NOT be callable from the API (internal, triggers, cron, probes).
const INTERNAL = new Set([
  'audit_mask_email', 'audit_row_change', 'bookings_apply_signature_requirement', 'bookings_check_captcha',
  'bookings_enforce_limits', 'bookings_queue_signature_request', 'bookings_queue_signature_void', 'broadcast_slot_change',
  'docusign_apply_envelope_status', 'docusign_expire_unsigned', 'docusign_queue_call', 'docusign_retry_sends',
  'enqueue_reminders', 'handle_new_user', 'invoke_edge_function', 'process_reminders', 'reminder_email_hash',
  'reminders_opted_out', 'request_client_ip', 'run_reminders', 'set_cancelled_at', 'sync_slot_is_booked',
  'booking_series_enforce_limits', 'bookings_check_series', 'enforce_booking_limits',
  'sqli_search_bookings_unsafe', 'sqli_search_bookings_unsafe_invoker',
])

// ---------------------------------------------------------------------------
console.log('\n# 1. Every table: read / insert / update / delete on rows that are not yours')
const tables = psql(`select tablename from pg_tables where schemaname = 'public' order by 1`).split('\n')
const snapshot = (t, s) => psql(`select coalesce(md5(string_agg(row_to_json(x)::text, '')), 'gone') from ${t} x where ${s.key} = '${s.row}'`)
const matrix = []
for (const t of tables) {
  const s = T[t]
  if (!s) { check(`${t}: not reviewed by this scan (add it to the expectations)`, false); continue }
  for (const [who, c] of [['anon', anon], ['stranger', A.c]]) {
    const got = []
    const r = await c.from(t).select('*').eq(s.key, s.readRow ?? s.row)
    if (r.data?.length) got.push('R')
    const before = psql(`select count(*) from ${t}`)
    const i = await c.from(t).insert(s.insert(who))
    if (!i.error && psql(`select count(*) from ${t}`) !== before) got.push('I')
    const snap = snapshot(t, s)
    await c.from(t).update(s.patch).eq(s.key, s.row)
    if (snapshot(t, s) !== snap) got.push('U')
    await c.from(t).delete().eq(s.key, s.row)
    if (snapshot(t, s) === 'gone') got.push('D')
    const want = s.expect[who]
    matrix.push({ t, who, got: got.join(''), want })
    check(`${t.padEnd(28)} ${who.padEnd(8)} can: ${(got.join('') || '-').padEnd(4)} should: ${want || '-'}${s.note && want ? `   (${s.note})` : ''}`,
      got.join('') === want, i.error ? `insert said: ${i.error.code} ${i.error.message}` : '')
  }
}

// ---------------------------------------------------------------------------
console.log('\n# 2. Every function in public, called through the API (rpc)')
const fns = psql(`select p.proname || '|' || coalesce(array_to_string((p.proargnames)[1:p.pronargs], ','), '')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind = 'f' order by 1`).split('\n').filter(Boolean)
for (const line of fns) {
  const [name, argList] = line.split('|')
  const reviewed = name in CALLABLE || INTERNAL.has(name)
  if (!reviewed) { check(`${name}(): not reviewed by this scan`, false); continue }
  // null for every argument: enough to tell "permission denied / not found" from "it ran".
  const args = Object.fromEntries(argList.split(',').filter((a) => a && !a.startsWith('o_')).map((a) => [a, null]))
  for (const [who, c] of [['anon', anon], ['stranger', A.c]]) {
    const r = await c.rpc(name, args)
    const denied = ['42501', 'PGRST202', 'PGRST203'].includes(r.error?.code) || [401, 403, 404].includes(r.status)
    const should = name in CALLABLE && !(name.startsWith('sqli_') && who === 'anon')
    check(`${(name + '()').padEnd(38)} ${who.padEnd(8)} ${denied ? 'blocked' : 'callable'}${should ? `   (${CALLABLE[name]})` : ''}`,
      denied === !should, `status ${r.status} ${r.error?.code ?? ''} ${r.error?.message ?? ''}`)
  }
}
let r = await anon.rpc('cancel_booking', { p_cancel_token: crypto.randomUUID() })
check('cancel_booking with a guessed token changes nothing', psql(`select status from bookings where id = '${bookingB}'`) === 'confirmed', JSON.stringify(r))
r = await anon.rpc('get_booking_statuses', { p_cancel_tokens: [crypto.randomUUID()] })
check('get_booking_statuses with a guessed token returns nothing', !r.data?.length, JSON.stringify(r.data))

// ---------------------------------------------------------------------------
console.log('\n# 3. Edge Functions, with only the public key and with a stranger\'s login')
// public = anyone may call (checks its own input); secret = only the project's secret key;
// host = a logged-in host; signed = only correctly signed webhook messages.
const EDGE = {
  'book-slot': 'public', 'book-recurring': 'public', 'reminders-unsubscribe': 'public',
  'docusign-webhook': 'signed', 'docusign-sync': 'host',
  'docusign-send': 'secret', 'docusign-void': 'secret', 'send-reminders': 'secret', 'process-reminders': 'secret', 'test-mail-provider': 'secret',
  'hosted-probe': 'secret',      // needs its own probe token
  'hosted-jwt-check': 'public',  // returns only { reached: true }
}
const stranger = (await A.c.auth.getSession()).data.session.access_token
const call = (fn, bearer, body = {}) => fetch(`${URL}/functions/v1/${fn}`, {
  method: 'POST', headers: { apikey: KEY, Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then((x) => x.status).catch(() => 0)
const up = await call('hosted-probe', KEY)
if (up === 0 || up === 503) console.log(`SKIP  Edge Functions not reachable (status ${up}): start npm run functions:serve and run again`)
else {
  for (const fn of readdirSync('supabase/functions').filter((d) => !d.startsWith('_') && !d.startsWith('.'))) {
    const kind = EDGE[fn]
    if (!kind) { check(`${fn}: not reviewed by this scan`, false); continue }
    if ((await call(fn, KEY)) === 404) { console.log(`SKIP  ${fn}: not deployed here`); continue }
    if (kind === 'public') {
      const s = await call(fn, KEY, { token: crypto.randomUUID() })
      check(`${fn.padEnd(24)} public key: ${s}  (public on purpose, checks its own input; must not be 5xx)`, s < 500)
      continue
    }
    const sAnon = await call(fn, KEY)
    const sStranger = await call(fn, stranger)
    const wantStranger = kind === 'host' ? 'any' : 401
    check(`${fn.padEnd(24)} public key: ${sAnon}  stranger: ${sStranger}  (should: 401${kind === 'host' ? ' / own data only' : ' / 401'})`,
      sAnon === 401 && (wantStranger === 'any' || sStranger === 401))
  }
}

// ---------------------------------------------------------------------------
console.log('\n# 4. Storage (avatars bucket: public files, private folders)')
const png = new Blob([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], { type: 'image/png' })
await B.c.storage.from('avatars').upload(`${B.id}/avatar.png`, png, { upsert: true })
const objects = () => psql(`select count(*) from storage.objects where bucket_id = 'avatars' and name like '${B.id}/%'`)
const listed = await anon.storage.from('avatars').list(B.id)
check('anon cannot list a host\'s avatar folder', !listed.data?.length, JSON.stringify(listed.data))
const pub = await fetch(anon.storage.from('avatars').getPublicUrl(`${B.id}/avatar.png`).data.publicUrl)
check(`anyone can download a host's avatar by URL (public bucket, by design): ${pub.status}`, pub.status === 200)
await A.c.storage.from('avatars').upload(`${B.id}/avatar.png`, png, { upsert: true })
await A.c.storage.from('avatars').upload(`${B.id}/extra.png`, png)
check('stranger cannot overwrite or add files in another host\'s folder', objects() === '1')
await A.c.storage.from('avatars').remove([`${B.id}/avatar.png`])
await anon.storage.from('avatars').remove([`${B.id}/avatar.png`])
check('stranger / anon cannot delete another host\'s avatar', objects() === '1')

// ---------------------------------------------------------------------------
console.log('\n# 5. GraphQL endpoint')
const gql = await fetch(`${URL}/graphql/v1`, { method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: '{ __schema { queryType { fields { name } } } }' }) }).then((x) => x.json()).catch((e) => ({ error: String(e) }))
// pg_graphql (not installed locally, usually on in hosted projects) applies the same grants and RLS:
// the public key may only see the tables anon can read (profiles, slots) and callable functions.
const gqlFields = gql?.data?.__schema?.queryType?.fields?.map((f) => f.name) ?? []
const camel = (n) => n.replace(/_(.)/g, (_, c) => c.toUpperCase())
const gqlAllowed = new Set(['node', 'profilesCollection', 'slotsCollection', ...Object.keys(CALLABLE).map(camel)])
const gqlExtra = gqlFields.filter((f) => !gqlAllowed.has(f))
check(`GraphQL shows the public key only what REST does: ${gqlFields.length ? gqlFields.join(', ') : 'nothing (pg_graphql not installed)'}`, gqlExtra.length === 0, `unexpected: ${gqlExtra.join(', ')}`)

// ---------------------------------------------------------------------------
console.log('\n# 6. Abuse: what an open insert allows in bulk')
let accepted = 0
for (let n = 0; n < 30; n++) {
  const x = await anon.from('booking_series').insert({ host_id: B.id, guest_name: `Spam ${n}`, guest_email: `scan-spam${n}@example.com`, weekday: 1, start_time: '10:00', weeks: 2 })
  if (!x.error) accepted++
}
const historyRows = psql(`select count(*) from audit_log where host_id = '${B.id}' and table_name = 'booking_series'`)
check(`30 empty booking series from one visitor: ${accepted} accepted (should be limited like bookings: max 10 per host per 10 min); host's history now has ${historyRows} series entries`,
  accepted <= 10)

// Weeks 2+ of a series skip the booking limits ("the series was counted with its first week").
// Nothing ties a booking to its series' host, weekday or time, so a visitor can open series and
// attach up to 12 ordinary bookings to each.
const C = await host('scan-victim')
const victimSlots = []
for (let h = 0; h < 40; h++) victimSlots.push((await C.c.from('slots').insert({ host_id: C.id, starts_at: at(500 + 2 * h), ends_at: at(501 + 2 * h) }).select().single()).data.id)
process.on('exit', () => psql(`delete from auth.users where id = '${C.id}'`))
let booked = 0
for (let n = 0; n < 4; n++) {
  const sid = crypto.randomUUID()
  await anon.from('booking_series').insert({ id: sid, host_id: C.id, guest_name: 'Bot', guest_email: `scan-bot${n}@example.com`, weekday: 1, start_time: '10:00', weeks: 12 })
  for (let w = 1; w <= 10; w++) {
    const x = await anon.from('bookings').insert({ slot_id: victimSlots[n * 10 + w - 1], guest_name: 'Bot', guest_email: `scan-bot${n}@example.com`, cancel_token: crypto.randomUUID(), series_id: sid, week_no: w })
    if (!x.error) booked++
  }
}
check(`40 bookings on one host via 4 made-up "series": ${booked} accepted (limit is 10 per host per 10 min)`, booked <= 10)

console.log(`\n${failures === 0 ? 'All checks passed' : `${failures} check(s) failed:\n  - ${mismatches.join('\n  - ')}`}`)
process.exit(failures === 0 ? 0 : 1)
