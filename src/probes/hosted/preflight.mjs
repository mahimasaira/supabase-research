// npm run hosted:preflight: confirms the hosted project is safe to measure on.
// 1. Probe-only objects are gone or closed (checked in the database AND through the public API).
// 2. Only the two hosted-check Edge Functions are deployed; hosted-probe is locked by its token.
import { readdirSync } from 'node:fs'
import { URL, KEY, check, finish, lockedDown, probe } from './hosted-env.mjs'

const api = (path, init = {}) => fetch(`${URL}${path}`, { ...init, headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...init.headers } })

console.log('\n# 1. Probe-only objects (database)')
const problems = lockedDown()
check(`unsafe SQL-injection functions dropped, switch off, audit_log_client closed, only rate-limit-cleanup scheduled`, problems.length === 0, problems.join('; '))

console.log('\n# 2. The same, through the public API (publishable key only)')
for (const fn of ['sqli_search_bookings_unsafe', 'sqli_search_bookings_unsafe_invoker']) {
  const r = await api(`/rest/v1/rpc/${fn}`, { method: 'POST', body: JSON.stringify({ p_search: "x' or true --" }) })
  check(`rpc ${fn}: ${r.status} (should be 404: not there)`, r.status === 404)
}
let r = await api('/rest/v1/audit_log_client', { method: 'POST', body: JSON.stringify({ action: 'booking.created', table_name: 'bookings' }) })
check(`insert into audit_log_client: ${r.status} (should be refused, 401/403)`, r.status === 401 || r.status === 403)
r = await api('/rest/v1/sqli_probe_switch?select=*')
const rows = r.ok ? await r.json() : []
check(`read sqli_probe_switch: ${r.status}, ${rows.length} rows (should be refused or empty)`, !r.ok || rows.length === 0)

console.log('\n# 3. Edge Functions')
const local = readdirSync('supabase/functions').filter((d) => !d.startsWith('_') && !d.startsWith('.'))
for (const fn of local.filter((f) => !f.startsWith('hosted-'))) {
  const s = (await fetch(`${URL}/functions/v1/${fn}`, { method: 'POST', headers: { apikey: KEY } })).status
  check(`${fn}: ${s} (should be 404: not deployed)`, s === 404)
}
const noToken = (await fetch(`${URL}/functions/v1/hosted-probe`, { method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: '{"mode":"headers"}' })).status
check(`hosted-probe without the probe token: ${noToken} (should be 401)`, noToken === 401)
const withToken = (await probe({ mode: 'headers' })).status
check(`hosted-probe with the token: ${withToken} (should be 200: deployed, secret set)`, withToken === 200)
const jwt = (await fetch(`${URL}/functions/v1/hosted-jwt-check`)).status
check(`hosted-jwt-check deployed: ${jwt} (any answer but 404)`, jwt !== 404)

finish('preflight checks')
