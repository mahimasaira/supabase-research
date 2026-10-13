// Feature 5 (bulk reminders), stage 1: show the problem with the naive design. Local only.
// Run: npm run probe:reminders:naive   (~1.5 min; resets the reminder test host before and after)
// Needs: `npm run probe:reminders:setup` once, `npm run functions:serve`.
// Only the reminder test host's 200 bookings are used; emails go to Mailpit only, and only the
// test emails (…@reminder-test.example) are deleted from Mailpit afterwards.
//   A. a quiet day                 B. crash halfway, then a retry
//   C. slow provider: the caller times out; the function finishes unseen, or the runtime stops it half-way
//   D. two runs overlap
//   E. (--with-time-limit) how long one call may run locally; takes several minutes
// "PASS" here means: the problem was reproduced. Stage 2 fixes it.
import { execSync } from 'node:child_process'

const DB = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const HOST = '33333333-3333-4333-8333-333333333333'
const URL = process.env.VITE_SUPABASE_URL
const MAILPIT = 'http://127.0.0.1:54324/api/v1'
const TEST_MAIL = 'to:reminder-test.example'
const psql = (q) => execSync(`psql ${DB} -At -F'|' -c "${q.replace(/"/g, '\\"')}"`).toString().trim()
const seed = () => execSync('npm run -s probe:reminders:seed', { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const secretKey = JSON.parse(execSync('npx supabase status -o json < /dev/null', { stdio: ['ignore', 'pipe', 'ignore'] }).toString()).SECRET_KEY

// ---- Mailpit: what actually arrived ----
const clearMail = () => fetch(`${MAILPIT}/search?query=${encodeURIComponent(TEST_MAIL)}`, { method: 'DELETE' })
async function inbox() {
  const d = await fetch(`${MAILPIT}/search?query=${encodeURIComponent(TEST_MAIL)}&limit=5000`).then((r) => r.json())
  const perGuest = {}
  for (const m of d.messages) perGuest[m.To[0].Address] = (perGuest[m.To[0].Address] ?? 0) + 1
  const counts = Object.values(perGuest)
  return { total: d.messages_count, guests: counts.length, twice: counts.filter((c) => c >= 2).length, missing: 200 - counts.length }
}
const marked = () => Number(psql(`select count(*) from bookings b join slots s on s.id = b.slot_id where s.host_id = '${HOST}' and b.reminder_sent_at is not null`))
const reset = async () => { seed(); await clearMail() }
process.on('exit', () => { seed(); execSync(`curl -s -o /dev/null -X DELETE "${MAILPIT}/search?query=${encodeURIComponent(TEST_MAIL)}"`) })

// Direct call (like the scheduler's request, but we wait for the answer).
const run = (body) => fetch(`${URL}/functions/v1/send-reminders`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ hostId: HOST, ...body }),
  signal: AbortSignal.timeout(600_000),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))

let failures = 0
function check(name, ok, detail) {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      → ${detail}` : ''}`)
}
const summary = []
const fnUp = await fetch(`${URL}/functions/v1/send-reminders`, { method: 'OPTIONS', signal: AbortSignal.timeout(20000) }).then(() => true).catch(() => false)
if (!fnUp) { console.error('FAIL  functions serve is not running (npm run functions:serve)'); process.exit(1) }

// ===========================================================================
console.log('\n# A. A quiet day')
await reset()
let r = await run({})
let mail = await inbox()
check(`${mail.total} reminders for 200 guests in ${r.body?.ms} ms, all marked as sent`, r.status === 200 && mail.total === 200 && mail.twice === 0 && marked() === 200, JSON.stringify({ r, mail }))
summary.push(['A. quiet day', `200 emails, ${r.body?.ms} ms: works`])

// ===========================================================================
console.log('\n# B. Crash halfway, then the next scheduled run')
await reset()
r = await run({ crashAfter: 120 })
mail = await inbox()
check(`the run crashes after 120 emails (HTTP ${r.status}); ${mail.total} delivered, ${marked()} marked as sent`, r.status >= 500 && mail.total === 120 && marked() === 0, JSON.stringify({ r, mail }))
r = await run({})
mail = await inbox()
check(`the retry sends to everyone unmarked: ${mail.total} emails, ${mail.twice} guests got the reminder TWICE`, mail.total === 320 && mail.twice === 120, JSON.stringify(mail))
summary.push(['B. crash + retry', `${mail.twice} guests reminded twice (nothing recorded which 120 were sent)`])

// ===========================================================================
console.log('\n# C. Slow provider: the scheduler\'s request times out (pg_net, 30 s)')
await reset()
// Exactly what the scheduled job runs, with 200 ms per email (40 s in total).
const requestId = psql(`select public.run_reminders('{"hostId": "${HOST}", "delayMs": 200}')`)
let response = ''
for (let i = 0; i < 60 && !response; i++) {
  await sleep(1000)
  response = psql(`select coalesce(status_code::text, '') || '|' || coalesce(left(error_msg, 60), '') from net._http_response where id = ${requestId}`)
}
const atTimeout = await inbox()
check(`the scheduler's request did not see the run finish: "${response.split('|')[1] || `HTTP ${response.split('|')[0]}`}" with ${atTimeout.total} of 200 emails sent at that moment`,
  (/timeout/i.test(response) || Number(response.split('|')[0]) >= 500) && atTimeout.total < 200, response)
for (let i = 0; i < 30 && marked() < 200; i++) await sleep(1000)
mail = await inbox()
// Two outcomes seen locally, depending on load: the function finishes unseen after the caller
// gave up (Timeout), or the Edge runtime stops it half-way (HTTP 546, resource limit).
const outcome = marked() === 200 ? `the function kept going and finished unseen (${mail.total} sent, all marked)` : `the runtime stopped the function half-way: ${mail.total} sent, ${marked()} marked, so the next run sends those ${mail.total} again`
check(`…and then ${outcome}; the database recorded only "${response.split('|')[1] ? 'Timeout' : `HTTP ${response.split('|')[0]}`}"`,
  (mail.total === 200 && marked() === 200) || (mail.total < 200 && marked() === 0), JSON.stringify(mail))
summary.push(['C. slow provider', `caller saw no result after ${atTimeout.total} emails; then: ${outcome}`])

// ===========================================================================
console.log('\n# D. Two runs overlap')
await reset()
const first = run({ delayMs: 30 })      // 200 × 30 ms ≈ 6 s
await sleep(1000)
const second = run({ delayMs: 30 })     // starts before the first has marked anything
await Promise.all([first, second])
mail = await inbox()
check(`both runs found the same 200 unreminded bookings: ${mail.total} emails, ${mail.twice} guests got it twice`, mail.twice >= 190, JSON.stringify(mail))
summary.push(['D. overlapping runs', `${mail.twice} guests reminded twice`])

// ===========================================================================
if (process.argv.includes('--with-time-limit')) {
  console.log('\n# E. How long may one call run? (several minutes)')
  await reset()
  const t0 = Date.now()
  r = await run({ delayMs: 3000 }) // 200 × 3 s = 10 min if never stopped
  mail = await inbox()
  const s = Math.round((Date.now() - t0) / 1000)
  check(`stopped after ${s} s with ${mail.total} of 200 sent, ${marked()} marked (HTTP ${r.status})`, mail.total < 200, JSON.stringify({ r, mail }))
  summary.push(['E. time limit', `stopped after ${s} s: ${mail.total} sent, ${marked()} marked`])
} else {
  console.log('\nSKIP  E. time limit (takes minutes): npm run probe:reminders:naive -- --with-time-limit')
}

console.log('\n# Summary')
for (const [k, v] of summary) console.log(`  ${k}: ${v}`)
console.log(`\n${failures === 0 ? 'All problems reproduced' : `${failures} check(s) did NOT reproduce`} (test data and test emails reset)`)
process.exit(failures ? 1 : 0)
