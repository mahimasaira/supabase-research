// Audit log, stage 3: the same actions, seen by three audit tools. Local only.
// Run: npm run probe:audit:compare   (resets test data; takes ~30 s)
//   ours        audit_log            stage 2 triggers (migration 20261012160421)
//   supa_audit  audit.record_version Supabase's archived extension (migration 20261012182300)
//   pgaudit     Postgres server log  built into Supabase; switched on ONLY while this script
//                                    runs (it's a role setting, not schema), then off again.
// Restarts the local API container twice (PostgREST only reads role settings on connect).
// psql (database owner) is used to inspect the tables and to play "Studio".
import { createClient } from '@supabase/supabase-js'
import { execSync } from 'node:child_process'
import { bookRecurringRpc } from '../../services/supabase/recurring/rpc.js'

const DB = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const HOST = '11111111-1111-4111-8111-111111111111'
const url = process.env.VITE_SUPABASE_URL
const key = process.env.VITE_SUPABASE_ANON_KEY
const psql = (q) => execSync(`psql ${DB} -At -F'|' -c "${q.replace(/"/g, '\\"')}"`).toString().trim()
const sh = (cmd) => execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] }).toString()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const client = () => createClient(url, key, { auth: { persistSession: false } })
const slotAt = (week) => psql(`select id || '|' || to_char(starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  from slots where host_id = '${HOST}' order by starts_at offset ${week - 1} limit 1`).split('|')

let failures = 0
function check(name, ok, detail) {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `\n      → ${detail}` : ''}`)
}

// ---- pgaudit on/off ----
async function restartApi() {
  sh('docker restart supabase_rest_supabase-booking')
  for (let i = 0; i < 30; i++) {
    const ok = await fetch(`${url}/rest/v1/`, { headers: { apikey: key } }).then((r) => r.ok).catch(() => false)
    if (ok) return
    await sleep(500)
  }
  throw new Error('API did not come back after restart')
}
async function pgauditOn() {
  psql('create extension if not exists pgaudit')
  // API requests: 'read' is needed too, because PostgREST sends writes as
  // WITH ... INSERT ... SELECT, which pgaudit classifies as a READ.
  psql(`alter role authenticator set pgaudit.log = 'read, write'`)
  psql(`alter role postgres set pgaudit.log = 'write'`) // "Studio" changes
  await restartApi()
}
async function pgauditOff() {
  psql('alter role authenticator reset pgaudit.log')
  psql('alter role postgres reset pgaudit.log')
  psql('drop extension if exists pgaudit')
  await restartApi()
}

// "<ip> <time> UTC [pid] user@db LOG:  AUDIT: SESSION,1,1,WRITE,INSERT,,,<statement>,<params>"
function pgauditLines(sinceIso) {
  const out = execSync(`docker logs --since ${sinceIso} supabase_db_supabase-booking 2>&1`).toString()
  return out.split('\n').filter((l) => l.includes('AUDIT: SESSION')).map((l) => {
    const m = l.match(/\] (\S+)@\S+ LOG:\s+AUDIT: SESSION,\d+,\d+,(\w+),([A-Z ]+),[^,]*,[^,]*,(.*)$/)
    return m ? { user: m[1], cls: m[2], command: m[3], text: m[4] } : { user: '?', cls: '?', command: '?', text: l }
  })
}

// Run one scenario and collect what each tool recorded during it.
const results = []
async function scenario(name, fn) {
  const sinceIso = new Date().toISOString()
  const dbSince = psql('select now()')
  await fn()
  await sleep(1500) // let the server log flush
  const r = {
    name,
    ours: psql(`select coalesce(string_agg(action || ' by ' || actor_role || coalesce(':' || left(actor_id::text, 8), ''), ', ' order by created_at), '')
      from audit_log where created_at >= '${dbSince}'`),
    supa: psql(`select coalesce(string_agg(table_name || ' ' || op || ' by ' || coalesce(auth_role, '?') || coalesce(':' || left(auth_uid::text, 8), ''), ', ' order by id), '')
      from audit.record_version where ts >= '${dbSince}'`),
    pg: pgauditLines(sinceIso),
  }
  results.push(r)
  return r
}

// ---------------------------------------------------------------------------
console.log('\n# supa_audit as published breaks sign-up (reproduced inside a rolled-back transaction)')
const bug = execSync(`psql ${DB} -q -At 2>&1`, {
  input: `begin;
alter function audit.to_record_id(oid, text[], jsonb) reset search_path;
alter function audit.insert_update_delete_trigger() reset search_path;
set local search_path = '';   -- what public.handle_new_user() runs with
insert into public.slots (host_id, starts_at, ends_at) values ('${HOST}', now() + interval '400 days', now() + interval '400 days 1 hour');
rollback;`,
}).toString()
check('unpatched: "function uuid_generate_v4() does not exist"', bug.includes('uuid_generate_v4() does not exist'), bug)
const signup = await client().auth.signUp({ email: `compare-${Date.now()}@test.dev`, password: 'secret123' })
check('patched (our migration): sign-up works', !signup.error, JSON.stringify(signup.error))
psql(`delete from auth.users where email like 'compare-%@test.dev'`)

// ---------------------------------------------------------------------------
console.log('\n# Same actions, three tools')
execSync('npm run -s probe:audit:seed', { stdio: 'ignore' })
psql('truncate audit.record_version')
await pgauditOn()
const anon = client()
const host = client()
let s1, s2, s3, s4, s5
try {
  const token = crypto.randomUUID()
  s1 = await scenario('Guest books (API)', async () => {
    await anon.from('bookings').insert({ slot_id: slotAt(1)[0], guest_name: 'Compare Guest', guest_email: 'compare@example.com', cancel_token: token })
  })
  s2 = await scenario('Recurring rpc, rolled back', async () => {
    const [id, starts_at] = slotAt(2) // weeks 2, 3 inserted, week 4 taken → rollback
    const r = await bookRecurringRpc(anon, { hostId: HOST, firstSlot: { id, starts_at }, weeks: 3, guestName: 'Rollback Guest', guestEmail: 'rb@example.com' })
    if (r.clash?.week !== 3) throw new Error(`expected clash in week 3: ${JSON.stringify(r)}`)
  })
  s3 = await scenario('Guest cancels (rpc)', async () => {
    await anon.rpc('cancel_booking', { p_cancel_token: token })
  })
  await host.auth.signInWithPassword({ email: 'recurring-host@test.dev', password: 'password123' })
  s4 = await scenario('Host deletes a slot (API)', async () => {
    await host.from('slots').delete().eq('id', slotAt(6)[0])
  })
  s5 = await scenario('Studio edit (owner)', async () => {
    psql(`update profiles set display_name = 'Renamed In Studio' where id = '${HOST}'`)
  })
} finally {
  await pgauditOff()
}

const pgUsers = (s) => [...new Set(s.pg.map((l) => l.user))].join(',')
const pgMentions = (s, table) => s.pg.filter((l) => l.text.includes(table))

check('WHO, guest: ours anon, supa_audit anon, pgaudit only "authenticator"',
  s1.ours.includes('by anon') && s1.supa.includes('by anon') && pgUsers(s1) === 'authenticator', JSON.stringify({ ours: s1.ours, supa: s1.supa, pg: pgUsers(s1) }))
check('WHO, host: ours + supa_audit have the host id, pgaudit only "authenticator"',
  s4.ours.includes(`:${HOST.slice(0, 8)}`) && s4.supa.includes(`:${HOST.slice(0, 8)}`) && pgUsers(s4) === 'authenticator', JSON.stringify({ ours: s4.ours, supa: s4.supa, pg: pgUsers(s4) }))
check('WHO, Studio: ours "postgres", supa_audit nothing ("?"), pgaudit "postgres"',
  s5.ours.includes('by postgres') && s5.supa.includes('by ?') && pgUsers(s5) === 'postgres', JSON.stringify({ ours: s5.ours, supa: s5.supa, pg: pgUsers(s5) }))
check('ROLLBACK: ours and supa_audit record nothing, pgaudit logged the undone inserts',
  s2.ours === '' && s2.supa === '' && pgMentions(s2, 'insert into public.bookings').length === 2 && pgMentions(s2, 'insert into public.booking_series').length === 1,
  JSON.stringify({ ours: s2.ours, supa: s2.supa, pgInserts: pgMentions(s2, 'insert into').length }))
check('NOISE, one guest booking: ours 1 entry, supa_audit 2 (+ slot is_booked), pgaudit more lines',
  s1.ours.split(', ').length === 1 && s1.supa.split(', ').length === 2 && s1.pg.length > 2, JSON.stringify({ ours: s1.ours, supa: s1.supa, pg: s1.pg.length }))
const supaRow = psql(`select (record ? 'cancel_token') || '|' || (record->>'guest_email') from audit.record_version where table_name = 'bookings' and op = 'INSERT' order by id limit 1`)
const oursRow = psql(`select (changes ? 'cancel_token') || '|' || (changes->>'guest_email') from audit_log where action = 'booking.created' order by created_at limit 1`)
check('SECRETS: supa_audit copies the cancel token and the full email, ours doesn\'t',
  supaRow === 'true|compare@example.com' && oursRow === 'false|c***@example.com', JSON.stringify({ supaRow, oursRow }))
check('VALUES: pgaudit can\'t show API values (params "<not logged>", no email in the text)',
  s1.pg.every((l) => !l.text.includes('compare@example.com')) && s1.pg.some((l) => l.text.endsWith('<not logged>')))
check('…but a Studio statement is logged with its literal values', pgMentions(s5, 'Renamed In Studio').length > 0)
const { error: supaRead } = await host.schema('audit').from('record_version').select('id')
const { data: oursRead } = await host.from('audit_log').select('id')
check('READING in the app: ours yes (host\'s own entries), supa_audit no (schema not exposed), pgaudit no (server log)',
  oursRead?.length > 0 && !!supaRead, JSON.stringify({ supaRead, ours: oursRead?.length }))

// ---------------------------------------------------------------------------
console.log('\n# What each tool recorded')
for (const r of results) {
  console.log(`\n## ${r.name}`)
  console.log(`  ours:       ${r.ours || '(nothing)'}`)
  console.log(`  supa_audit: ${r.supa || '(nothing)'}`)
  const lines = r.pg.map((l) => `${l.user} ${l.cls} ${l.command.trim()}: ${l.text.slice(0, 60).replace(/\s+/g, ' ')}…`)
  console.log(`  pgaudit:    ${lines.length} line(s)${lines.length ? '\n              ' + lines.slice(0, 6).join('\n              ') : ''}${lines.length > 6 ? `\n              … ${lines.length - 6} more` : ''}`)
}

execSync('npm run -s probe:audit:seed', { stdio: 'ignore' })
psql('truncate audit.record_version')
console.log(`\n${failures === 0 ? 'All checks passed' : `${failures} check(s) FAILED`} (test data reset, pgaudit off)`)
process.exit(failures ? 1 : 0)
