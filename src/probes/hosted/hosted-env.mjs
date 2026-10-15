// Shared by the hosted-check scripts (HOSTED_CHECKS.md). Values come from .env.hosted (git-ignored),
// loaded with node --env-file=.env.hosted. Nothing here is used by the app or the browser.
import { spawnSync } from 'node:child_process'

const need = ['HOSTED_SUPABASE_URL', 'HOSTED_PUBLISHABLE_KEY', 'HOSTED_DB_URL', 'HOSTED_PROBE_TOKEN']
const missing = need.filter((n) => !process.env[n])
if (missing.length) {
  console.error(`Missing in .env.hosted: ${missing.join(', ')} (see .env.hosted.example and HOSTED_CHECKS.md)`)
  process.exit(2)
}
if (/127\.0\.0\.1|localhost/.test(process.env.HOSTED_SUPABASE_URL)) {
  console.error('HOSTED_SUPABASE_URL points at the local stack; these scripts are for the hosted project.')
  process.exit(2)
}

export const URL = process.env.HOSTED_SUPABASE_URL.replace(/\/$/, '')
export const KEY = process.env.HOSTED_PUBLISHABLE_KEY
export const TOKEN = process.env.HOSTED_PROBE_TOKEN
const DB = process.env.HOSTED_DB_URL

// psql against the hosted database. The connection string holds the password, so it is passed
// as an argument but never printed: errors show psql's message only.
export function psql(query, { file } = {}) {
  const args = [DB, '-At', '-F|', '-v', 'ON_ERROR_STOP=1', ...(file ? ['-f', file] : ['-c', query])]
  const r = spawnSync('psql', args, { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`psql failed: ${(r.stderr || '').trim()}`)
  return r.stdout.trim()
}

export const probe = (body, headers = {}) =>
  fetch(`${URL}/functions/v1/hosted-probe`, {
    method: 'POST',
    headers: { apikey: KEY, 'Content-Type': 'application/json', 'x-probe-token': TOKEN, ...headers },
    body: JSON.stringify(body),
  })

let failures = 0
export function check(name, ok, detail) {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `\n      → ${detail}` : ''}`)
}
export const note = (text) => console.log(`NOTE  ${text}`)
export const finish = (what = 'checks') => {
  console.log(`\n${failures === 0 ? `All ${what} passed` : `${failures} check(s) failed`}`)
  process.exit(failures === 0 ? 0 : 1)
}

// The probe-only objects must be gone or closed before anything runs against the hosted project.
export function lockedDown() {
  const problems = []
  if (psql(`select count(*) from pg_proc where proname like 'sqli_search_bookings_unsafe%'`) !== '0') problems.push('the unsafe SQL-injection functions exist')
  if (psql(`select coalesce(unsafe_enabled_until > now(), false) from public.sqli_probe_switch`) !== 'f') problems.push('the SQL-injection switch is on')
  if (psql(`select has_any_column_privilege('anon', 'public.audit_log_client', 'insert') or has_any_column_privilege('authenticated', 'public.audit_log_client', 'insert')`) !== 'f') problems.push('audit_log_client is writable from the API')
  if (psql(`select count(*) from cron.job where jobname <> 'rate-limit-cleanup'`) !== '0') problems.push('scheduled jobs other than rate-limit-cleanup exist')
  return problems
}
export function requireLockdown() {
  const problems = lockedDown()
  if (problems.length) {
    console.error(`Hosted project not locked down: ${problems.join('; ')}.\nRun npm run hosted:lockdown, then npm run hosted:preflight.`)
    process.exit(3)
  }
}
