// Proof script for feature 5 (bulk reminders), stage 3: opt-out + the provider's sending limit.
// Run: npm run probe:reminders:proof:optout   (~3 min; resets the reminder test host before and after)
// Needs: `npm run probe:reminders:setup`, `npm run functions:serve`.
// Emails go to Mailpit only; only the test emails (…@reminder-test.example) are deleted afterwards.
//
// B1 runs the worker with stage 2's behaviour against a rate-limited (test) provider to show the
// problem first; B2–B4 show the fix. "PASS" in B1 means the problem was reproduced.
import { createClient } from '@supabase/supabase-js'
import { execSync } from 'node:child_process'

const DB = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const HOST = '33333333-3333-4333-8333-333333333333'
const URL = process.env.VITE_SUPABASE_URL
const MAILPIT = 'http://127.0.0.1:54324/api/v1'
const TEST_MAIL = 'to:reminder-test.example'
const psql = (q) => execSync(`psql ${DB} -At -F'|' -c "${q.replace(/"/g, '\\"')}"`).toString().trim()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const secretKey = JSON.parse(execSync('npx supabase status -o json < /dev/null', { stdio: ['ignore', 'pipe', 'ignore'] }).toString()).SECRET_KEY
const anon = createClient(URL, process.env.VITE_SUPABASE_ANON_KEY, { auth: { persistSession: false } })

const clearMail = () => fetch(`${MAILPIT}/search?query=${encodeURIComponent(TEST_MAIL)}`, { method: 'DELETE' })
async function inbox() {
  const d = await fetch(`${MAILPIT}/search?query=${encodeURIComponent(TEST_MAIL)}&limit=5000`).then((r) => r.json())
  const perGuest = {}
  for (const m of d.messages) perGuest[m.To[0].Address] = (perGuest[m.To[0].Address] ?? 0) + 1
  return { total: d.messages_count, guests: Object.keys(perGuest).length, twice: Object.values(perGuest).filter((c) => c > 1).length, perGuest, first: d.messages[0] }
}
const guestEmail = (n) => `guest-${String(n).padStart(3, '0')}@reminder-test.example`
const tokenOf = (n) => psql(`select cancel_token from bookings where guest_email = '${guestEmail(n)}'`)
const queueLength = () => Number(psql(`select queue_length from pgmq.metrics('reminders')`))
const archived = () => Number(psql(`select count(*) from pgmq.a_reminders`))
const optouts = () => Number(psql(`select count(*) from reminder_optouts`))
const providerLog = () => psql(`select count(*) filter (where accepted) || '|' || count(*) filter (where not accepted) from test_mail_provider_log`).split('|').map(Number)
const enqueue = () => Number(psql(`select public.enqueue_reminders('${HOST}')`))
const reset = async () => { execSync('npm run -s probe:reminders:seed', { stdio: 'ignore' }); await clearMail() }
process.on('exit', () => { execSync('npm run -s probe:reminders:seed', { stdio: 'ignore' }); execSync(`curl -s -o /dev/null -X DELETE "${MAILPIT}/search?query=${encodeURIComponent(TEST_MAIL)}"`) })

const work = (body = {}) => fetch(`${URL}/functions/v1/process-reminders`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ vt: 2, ...body }),
  signal: AbortSignal.timeout(120_000),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))
// Keep running workers (as the every-minute job would) until the queue is empty.
async function drain(body = {}, { workers = 1, maxRounds = 150 } = {}) {
  const totals = { runs: 0, busy: 0, throttled: 0 }
  for (let i = 0; i < maxRounds && queueLength() > 0; i++) {
    const rs = await Promise.all(Array.from({ length: workers }, () => work(body)))
    for (const r of rs) { totals.runs++; if (r.body?.busy) totals.busy++; totals.throttled += r.body?.throttled ?? 0 }
    if (queueLength() > 0) await sleep(1200) // throttled reminders come back after Retry-After (1 s), failed ones after vt (2 s)
  }
  return totals
}

let failures = 0
function check(name, ok, detail) {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `\n      → ${detail}` : ''}`)
}
const fnUp = await fetch(`${URL}/functions/v1/process-reminders`, { method: 'OPTIONS', signal: AbortSignal.timeout(20000) }).then(() => true).catch(() => false)
if (!fnUp) { console.error('FAIL  functions serve is not running (npm run functions:serve)'); process.exit(1) }
const oneClick = (token, method = 'POST') => fetch(`${URL}/functions/v1/reminders-unsubscribe?token=${token}`, {
  method, redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: method === 'POST' ? 'List-Unsubscribe=One-Click' : undefined,
}).then(async (r) => ({ status: r.status, location: r.headers.get('location'), text: await r.text() }))

// ===========================================================================
console.log('\n# A. Opt-out without an account')
await reset()
const { data: viaPage } = await anon.rpc('unsubscribe_reminders', { p_cancel_token: tokenOf(1) })
check('guest 001 unsubscribes on the page (rpc with their cancel token) → true', viaPage === true)
check('…stored as a hash of the address only (no email in the opt-out table)', psql(`select bool_and(email_hash ~ '^[0-9a-f]{64}$') from reminder_optouts`) === 't' && optouts() === 1)
const queued = enqueue()
check(`queuing skips guest 001: ${queued} queued`, queued === 199)
let oc = await oneClick(tokenOf(2))
check('guest 002 uses the mail app\'s one-click "Unsubscribe" (POST, no Supabase key) AFTER queuing → 200', oc.status === 200 && optouts() === 2, JSON.stringify(oc))
oc = await oneClick(tokenOf(3), 'GET')
check('opening the one-click URL in a browser (GET) does NOT unsubscribe; it redirects to the page, which asks first', oc.status === 303 && oc.location?.endsWith(`/reminders/unsubscribe/${tokenOf(3)}`) && optouts() === 2, JSON.stringify(oc))
const { data: unknown } = await anon.rpc('unsubscribe_reminders', { p_cancel_token: crypto.randomUUID() })
oc = await oneClick(crypto.randomUUID())
check('an unknown token: rpc false, one-click answers the same as for a real one (no hint), nothing stored', unknown === false && oc.status === 200 && optouts() === 2)
let r = await work({ ratePerSecond: 0, budgetMs: 30_000 })
let mail = await inbox()
check(`the worker skips guest 002 (opted out after queuing): ${mail.total} reminders, optedOut ${r.body?.optedOut}`,
  mail.total === 198 && r.body?.optedOut === 1 && !mail.perGuest[guestEmail(1)] && !mail.perGuest[guestEmail(2)] && mail.perGuest[guestEmail(3)] === 1, JSON.stringify(r.body))
const headers = await fetch(`${MAILPIT}/message/${mail.first.ID}/headers`).then((x) => x.json())
const text = (await fetch(`${MAILPIT}/message/${mail.first.ID}`).then((x) => x.json())).Text
check('every reminder has the unsubscribe link and the one-click headers (List-Unsubscribe + List-Unsubscribe-Post)',
  /\/reminders\/unsubscribe\/[0-9a-f-]{36}/.test(text) && /reminders-unsubscribe\?token=/.test(headers['List-Unsubscribe']?.[0] ?? '') && headers['List-Unsubscribe-Post']?.[0] === 'List-Unsubscribe=One-Click',
  JSON.stringify({ headers: { u: headers['List-Unsubscribe'], p: headers['List-Unsubscribe-Post'] } }))

// ===========================================================================
console.log('\n# B1. Provider limit 20/s, worker as in stage 2 (no pacing, two workers, 429 = failure)')
await reset(); enqueue()
const stage2 = { ratePerSecond: 0, lease: false, throttleAware: false, provider: 'test', maxReads: 3 }
let t0 = Date.now()
let d = await drain(stage2, { workers: 2 })
mail = await inbox()
let [accepted, refused] = providerLog()
check(`the provider refused ${refused} requests (429); each refusal counted as a failed attempt`, refused > 0, `accepted ${accepted}`)
check(`→ ${archived()} perfectly fine reminders ended as dead letters: only ${mail.guests} of 200 guests reminded (${Math.round((Date.now() - t0) / 1000)} s)`,
  archived() > 0 && mail.guests < 200, JSON.stringify({ guests: mail.guests, archived: archived() }))
const b1 = { refused, dead: archived(), reminded: mail.guests }

console.log('\n# B2. The fix: steady pace (10/s), one worker at a time, 429 = come back later')
await reset(); enqueue()
t0 = Date.now()
d = await drain({ provider: 'test' }, { workers: 2 })
mail = await inbox()
;[accepted, refused] = providerLog()
const secs = Math.round((Date.now() - t0) / 1000)
check(`two workers started each round: ${d.busy} of ${d.runs} runs found the other one working and stepped back`, d.busy > 0)
check(`all ${mail.guests} guests reminded once, ${refused} refusals, ${archived()} dead letters (${secs} s at 10/s)`,
  mail.guests === 200 && mail.twice === 0 && refused === 0 && archived() === 0, JSON.stringify({ guests: mail.guests, twice: mail.twice, refused, archived: archived() }))

console.log('\n# B3. The provider lowers its limit to 5/s mid-way (worker still paces at 10/s)')
await reset(); enqueue()
psql(`update test_mail_provider_settings set limit_per_second = 5`)
d = await drain({ provider: 'test', budgetMs: 10_000 })
mail = await inbox()
;[accepted, refused] = providerLog()
check(`${refused} refusals → ${d.throttled} reminders put back for later, not counted as failures: ${mail.guests} of 200 reminded, ${archived()} dead letters`,
  refused > 0 && d.throttled > 0 && mail.guests === 200 && mail.twice === 0 && archived() === 0, JSON.stringify({ refused, throttled: d.throttled, guests: mail.guests, archived: archived() }))

console.log('\n# B4. A worker killed while holding the lease')
await reset(); enqueue()
psql(`update reminder_worker_lease set holder = gen_random_uuid(), expires_at = now() + interval '3 seconds'`)
r = await work({ budgetMs: 2000 })
check('right after: the next worker steps back (busy)', r.body?.busy === true, JSON.stringify(r.body))
await sleep(3500)
r = await work({ budgetMs: 2000 })
check(`once the lease has run out (3 s): the next worker takes over and sends (${r.body?.sent})`, !r.body?.busy && r.body?.sent > 0, JSON.stringify(r.body))

console.log(`\n# Summary\n  B1 (stage 2 worker): ${b1.refused} refusals → ${b1.dead} healthy reminders dead-lettered, ${b1.reminded}/200 guests reminded\n  B2 (fix): 200/200 reminded, 0 refusals, 0 dead letters`)
console.log(`\n${failures === 0 ? 'All checks passed' : `${failures} check(s) FAILED`} (test data, queue and test emails reset)`)
process.exit(failures ? 1 : 0)
