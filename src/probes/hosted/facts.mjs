// npm run hosted:facts: the "to verify before publishing" items that a query or one request answers.
// Every line is a NOTE to copy into FRICTION_LOG / BLOG_REPORT; local values are in brackets.
import { createClient } from '@supabase/supabase-js'
import { URL, KEY, check, finish, note, probe, psql, requireLockdown } from './hosted-env.mjs'

requireLockdown()
const tryPsql = (q) => { try { return psql(q) } catch (e) { return `error: ${e.message.replace(/^psql failed: /, '')}` } }

console.log('\n# Database')
note(`Postgres: ${tryPsql('show server_version')}   [local 17.11]`)
note(`direct connection from Edge Functions (SUPABASE_DB_URL): ${JSON.stringify(await (await probe({ mode: 'dbrole' })).json())}   [local: postgres, superuser false, bypass_rls true, owns the tables]`)
note(`pg_cron: ${tryPsql(`select extversion from pg_extension where extname = 'pg_cron'`)}; cron.timezone: ${tryPsql(`select setting || ' (' || context || ')' from pg_settings where name = 'cron.timezone'`)}; postgres may SET it: ${tryPsql(`select has_parameter_privilege('cron.timezone', 'SET')`)}   [local: 1.6.4, GMT (postmaster), f]`)
note(`pgaudit: available ${tryPsql(`select count(*) > 0 from pg_available_extensions where name = 'pgaudit'`)}, installed ${tryPsql(`select count(*) > 0 from pg_extension where extname = 'pgaudit'`)}; settings: ${tryPsql(`select coalesce(string_agg(name || '=' || setting || ' (' || context || ')', ', '), 'none visible') from pg_settings where name like 'pgaudit.%'`)}   [local: preloaded]`)
note(`pg_net: schema ${tryPsql(`select n.nspname from pg_extension e join pg_namespace n on n.oid = e.extnamespace where extname = 'pg_net'`)}; anon may execute net.http_get: ${tryPsql(`select has_function_privilege('anon', 'net.http_get(text, jsonb, jsonb, integer)', 'execute')`)}, authenticated: ${tryPsql(`select has_function_privilege('authenticated', 'net.http_get(text, jsonb, jsonb, integer)', 'execute')`)}   [local: public, t, t]`)

console.log('\n# Edge Functions: what gets through the built-in JWT check (verify_jwt = true)')
const reach = async (label, headers) => {
  const s = (await fetch(`${URL}/functions/v1/hosted-jwt-check`, { method: 'POST', headers })).status
  note(`${label.padEnd(44)} → ${s}${s === 200 ? ' (reached the function)' : ''}`)
  return s
}
await reach('no key, no token', {})
await reach('publishable key as apikey only', { apikey: KEY })
await reach('publishable key as apikey + Bearer', { apikey: KEY, Authorization: `Bearer ${KEY}` })
if (process.env.HOSTED_LEGACY_ANON_KEY) await reach('legacy anon JWT as Bearer', { apikey: process.env.HOSTED_LEGACY_ANON_KEY, Authorization: `Bearer ${process.env.HOSTED_LEGACY_ANON_KEY}` })
await reach('a made-up JWT', { apikey: KEY, Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.x' })
const c = createClient(URL, KEY, { auth: { persistSession: false } })
const { data, error } = await c.auth.signUp({ email: `facts-${Date.now()}@test.dev`, password: 'secret123' })
if (data?.session) {
  await reach('a real user token', { apikey: KEY, Authorization: `Bearer ${data.session.access_token}` })
  psql(`delete from auth.users where id = '${data.user.id}'`)
} else note(`no user token to try (${error?.message ?? 'sign-up needs email confirmation: switch "Confirm email" off, see HOSTED_CHECKS.md'})`)
note('[local CLI 2.120: the publishable key alone got through, so the check does not identify the caller]')

check('facts collected (copy the NOTE lines)', true)
finish('fact checks')
