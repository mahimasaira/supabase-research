// Proof script for feature 5 (bulk reminders), stage 2: Supabase Queues (pgmq). Local only.
// Run: npm run probe:reminders:proof:queue   (~2 min; resets the reminder test host before and after)
// Needs: `npm run probe:reminders:setup`, `npm run functions:serve`.
// The stage 1 failures again (now expected to be handled), plus queue-specific cases.
// Emails go to Mailpit only; only the test emails (…@reminder-test.example) are deleted afterwards.
import { execSync } from 'node:child_process'

const DB = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const HOST = '33333333-3333-4333-8333-333333333333'
const URL = process.env.VITE_SUPABASE_URL
const MAILPIT = 'http://127.0.0.1:54324/api/v1'
const TEST_MAIL = 'to:reminder-test.example'
const psql = (q) => execSync(`psql ${DB} -At -F'|' -c "${q.replace(/"/g, '\\"')}"`).toString().trim()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const secretKey = JSON.parse(execSync('npx supabase status -o json < /dev/null', { stdio: ['ignore', 'pipe', 'ignore'] }).toString()).SECRET_KEY

const clearMail = () => fetch(`${MAILPIT}/search?query=${encodeURIComponent(TEST_MAIL)}`, { method: 'DELETE' })
async function inbox() {
  const d = await fetch(`${MAILPIT}/search?query=${encodeURIComponent(TEST_MAIL)}&limit=5000`).then((r) => r.json())
  const perGuest = {}
  for (const m of d.messages) perGuest[m.To[0].Address] = (perGuest[m.To[0].Address] ?? 0) + 1
  const counts = Object.values(perGuest)
  return { total: d.messages_count, guests: counts.length, twice: counts.filter((c) => c >= 2).length, perGuest }
}
const marked = () => Number(psql(`select count(*) from bookings b join slots s on s.id = b.slot_id where s.host_id = '${HOST}' and b.reminder_sent_at is not null`))
const queueLength = () => Number(psql(`select queue_length from pgmq.metrics('reminders')`))
const archived = () => Number(psql(`select count(*) from pgmq.a_reminders`))
const enqueue = () => Number(psql(`select public.enqueue_reminders('${HOST}')`))
const reset = async () => { execSync('npm run -s probe:reminders:seed', { stdio: 'ignore' }); await clearMail() }
process.on('exit', () => { execSync('npm run -s probe:reminders:seed', { stdio: 'ignore' }); execSync(`curl -s -o /dev/null -X DELETE "${MAILPIT}/search?query=${encodeURIComponent(TEST_MAIL)}"`) })

// One worker run (like the scheduler's, but we wait for the answer). Runs with STAGE 2 settings:
// no pacing, no single-worker lease (both added in stage 3 and proven by proof-optout-limits).
// Counts runs the Edge runtime stopped on its own (546): each may repeat the ONE email in flight.
const STAGE2 = { vt: 3, ratePerSecond: 0, lease: false }
let terminations = 0
const work = (body = {}) => fetch(`${URL}/functions/v1/process-reminders`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ ...STAGE2, ...body }),
  signal: AbortSignal.timeout(120_000),
}).then(async (r) => {
  if (r.status === 546) terminations++
  return { status: r.status, body: await r.json().catch(() => null) }
})
// Keep running the worker (as the every-minute job would) until the queue is empty.
async function drain(body = {}, maxRuns = 30) {
  const runs = []
  for (let i = 0; i < maxRuns && queueLength() > 0; i++) {
    runs.push(await work(body))
    if (queueLength() > 0) await sleep(3500) // let crashed/failed messages become visible again (vt = 3 s)
  }
  return runs
}

let failures = 0
function check(name, ok, detail) {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `\n      → ${detail}` : ''}`)
}
const summary = []
const fnUp = await fetch(`${URL}/functions/v1/process-reminders`, { method: 'OPTIONS', signal: AbortSignal.timeout(20000) }).then(() => true).catch(() => false)
if (!fnUp) { console.error('FAIL  functions serve is not running (npm run functions:serve)'); process.exit(1) }

// ===========================================================================
console.log('\n# Enqueue')
await reset()
const [q1, q2] = await Promise.all([Promise.resolve(enqueue()), Promise.resolve(enqueue())])
check(`two overlapping enqueue runs queue each reminder once: ${q1} + ${q2} = ${queueLength()} messages`, q1 + q2 === 200 && queueLength() === 200)

console.log('\n# A. A quiet day')
let runs = await drain()
let mail = await inbox()
check(`${mail.total} reminders, each guest once, all marked, queue empty (${runs.length} worker run(s))`, mail.total === 200 && mail.twice === 0 && marked() === 200 && queueLength() === 0, JSON.stringify(mail.total))
summary.push(['A. quiet day', `200 emails, each once (stage 1: 200)`])

console.log('\n# B. Crash halfway, then the next run')
await reset(); enqueue()
let stops = terminations
let r = await work({ crashAfter: 120 })
check(`the run crashes after 120 emails (HTTP ${r.status}); those 120 are already marked and off the queue`, r.status >= 500 && marked() === 120, `marked ${marked()}`)
runs = await drain()
mail = await inbox()
check(`the next run sends only the other 80: ${mail.guests} guests reminded, ${mail.twice} twice (stage 1: 120 twice; ≤ ${terminations - stops} runtime stop(s))`,
  mail.guests === 200 && mail.twice <= terminations - stops, JSON.stringify({ total: mail.total, twice: mail.twice, stops: terminations - stops }))
summary.push(['B. crash + retry', `0 twice (stage 1: 120)`])

await reset(); enqueue()
r = await work({ crashAfter: 120, crashMode: 'after-send' })
const sentBeforeStop = (await inbox()).total
runs = await drain()
mail = await inbox()
// Two endings seen locally: our simulated crash right after email 121 (that one email is sent
// again), or the Edge runtime terminating the worker earlier on its own (HTTP 546, CPU/resource
// limit), wherever it happens to be. Either way: at most the ONE email in flight is repeated.
const ending = r.status === 546 ? `the runtime stopped the worker itself (546) after ${sentBeforeStop} emails` : `crash right after sending email ${sentBeforeStop}`
check(`worst moment (${ending}): ${mail.twice} guest(s) got it twice, at most the one email in flight; all 200 reached`,
  mail.guests === 200 && mail.twice <= 1 && mail.total === 200 + mail.twice, JSON.stringify({ status: r.status, total: mail.total, twice: mail.twice }))
summary.push(['B2. crash between send and record', `${mail.twice} twice (${ending}): at-least-once, the queue can't do exactly-once alone`])

console.log('\n# C. Slow provider, through the scheduler (pg_net, 30 s timeout)')
await reset(); enqueue()
const results = []
for (let i = 0; i < 20 && queueLength() > 0; i++) {
  // Exactly what the every-minute job runs, with 200 ms per email and a 20 s budget (stage 2 settings).
  const id = psql(`select public.process_reminders('{"delayMs": 200, "budgetMs": 20000, "vt": 3, "ratePerSecond": 0, "lease": false}')`)
  let resp = ''
  for (let t = 0; t < 45 && !resp; t++) {
    await sleep(1000)
    resp = psql(`select coalesce(status_code::text, '') || '|' || coalesce(left(error_msg, 40), '') || '|' || coalesce(content::text, '') from net._http_response where id = ${id}`)
  }
  results.push(resp)
}
mail = await inbox()
// A run either stops itself within its budget (200), or the Edge runtime terminates it on its own
// (546, resource limit); never the caller's 30 s timeout. A termination between sending and
// recording repeats that ONE email (at-least-once); everything else is picked up by the next run.
const codes = results.map((x) => x.split('|')[0])
const terminated = codes.filter((c) => c !== '200').length
check(`every run gets an HTTP answer (${codes.join(', ')}), never the caller's timeout (546 = stopped by the runtime, 503 = gateway)`,
  results.length > 0 && codes.every((c) => /^\d{3}$/.test(c)) && !results.some((x) => /timeout/i.test(x)), results.join(' / '))
check(`${results.length} runs drained the queue: all ${mail.guests} guests reminded, ${mail.twice} twice (≤ ${terminated} runtime termination(s)), all marked`,
  mail.guests === 200 && mail.twice <= terminated && marked() === 200, JSON.stringify({ total: mail.total, twice: mail.twice, terminated }))
summary.push(['C. slow provider', `${results.length} runs (${codes.join(', ')}), no caller timeout; 200 guests, ${mail.twice} twice`])

console.log('\n# D. Two workers overlap')
await reset(); enqueue()
stops = terminations
await Promise.all([work({ delayMs: 30 }), (async () => { await sleep(500); return work({ delayMs: 30 }) })()])
await drain()
mail = await inbox()
check(`two workers at once: ${mail.guests} guests reminded, ${mail.twice} twice (stage 1: 200 twice; ≤ ${terminations - stops} runtime stop(s))`,
  mail.guests === 200 && mail.twice <= terminations - stops, JSON.stringify({ total: mail.total, twice: mail.twice, stops: terminations - stops }))
summary.push(['D. overlapping runs', `0 twice (stage 1: 200)`])

console.log('\n# E. A long run ends on time (no runaway)')
await reset(); enqueue()
const t0 = Date.now()
r = await work({ delayMs: 3000, budgetMs: 10000 })
const took = Math.round((Date.now() - t0) / 1000)
const afterReturn = (await inbox()).total
await sleep(8000)
const later = (await inbox()).total
check(`3 s per email, 10 s budget: the run returned after ${took} s (sent ${r.body?.sent}, released ${r.body?.released}); no emails after it returned (${afterReturn} → ${later})`,
  r.status === 200 && took < 20 && later === afterReturn && r.body?.left > 0, JSON.stringify(r))
summary.push(['E. long run', `returned after ${took} s with work left on the queue; nothing sent in the background (stage 1: 504 + runaway)`])

console.log('\n# F. Cancelled after queuing')
await reset(); enqueue()
psql(`update bookings b set status = 'cancelled' from slots s where s.id = b.slot_id and s.host_id = '${HOST}' and b.guest_name in ('Guest 001','Guest 002','Guest 003','Guest 004','Guest 005')`)
// Keep running workers until the queue is empty (since stage 3 the worker paces itself at 10/s,
// so one 20 s run can't send 195; and the runtime may stop a run early).
await drain()
mail = await inbox()
const cancelledReminded = [1, 2, 3, 4, 5].filter((n) => mail.perGuest[`guest-00${n}@reminder-test.example`]).length
check(`5 bookings cancelled after queuing: ${mail.total} reminders, ${cancelledReminded} of the cancelled guests reminded, queue empty`,
  mail.total === 195 && mail.twice === 0 && cancelledReminded === 0 && queueLength() === 0, JSON.stringify({ total: mail.total, cancelledReminded, left: queueLength() }))

console.log('\n# G. One address always fails (dead letter)')
await reset(); enqueue()
runs = await drain({ failEmails: ['guest-007@reminder-test.example'], maxReads: 3 })
mail = await inbox()
check(`the other 199 are sent (${mail.total}); guest 007 is retried, then moved to the archive (${archived()} dead letter), queue empty`,
  mail.total === 199 && archived() === 1 && queueLength() === 0 && !mail.perGuest['guest-007@reminder-test.example'], JSON.stringify({ total: mail.total, archived: archived(), left: queueLength() }))
summary.push(['G. failing address', `199 sent, 1 dead letter in pgmq.a_reminders (stage 1: would fail the whole run)`])

console.log('\n# Summary (stage 2 vs. stage 1)')
for (const [k, v] of summary) console.log(`  ${k}: ${v}`)
console.log(`\n${failures === 0 ? 'All checks passed' : `${failures} check(s) FAILED`} (test data, queue and test emails reset)`)
process.exit(failures ? 1 : 0)
