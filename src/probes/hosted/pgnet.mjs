// npm run hosted:pgnet: pg_net timeouts against hosted Edge Functions.
// Locally (feature 4, stage 2): pg_net's default 5 s timeout lost requests to Edge Function cold
// starts, and a timed-out request can still have done its work (the caller thinks it failed).
//   A. 20 calls at once to a function that does nothing (default timeout): how many time out?
//      Run this after the function has been idle for ~10 minutes to include cold starts.
//   B. One 8 s call with the default 5 s timeout: pg_net gives up, does the function finish?
//   C. The same call with a 15 s timeout: succeeds.
// The probe token travels in the request headers through pg_net's queue table (deleted once sent).
import { URL, TOKEN, check, finish, note, psql, requireLockdown } from './hosted-env.mjs'

requireLockdown()
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))
const q = (s) => `'${String(s).replace(/'/g, "''")}'`
const headers = q(JSON.stringify({ 'Content-Type': 'application/json', 'x-probe-token': TOKEN }))
const post = (body, timeoutMs) => psql(`select net.http_post(url := ${q(`${URL}/functions/v1/hosted-probe`)}, body := ${q(JSON.stringify(body))}::jsonb,
  headers := ${headers}::jsonb${timeoutMs ? `, timeout_milliseconds := ${timeoutMs}` : ''})`)

// Waits for pg_net's answers (max 60 s).
async function responses(ids) {
  for (let i = 0; i < 30; i++) {
    const rows = psql(`select id, coalesce(status_code::text, ''), timed_out, coalesce(left(error_msg, 80), '') from net._http_response where id in (${ids.join(',')})`)
      .split('\n').filter(Boolean).map((l) => l.split('|'))
    if (rows.length === ids.length) return rows.map(([id, status, timedOut, error]) => ({ id, status, timedOut: timedOut === 't', error }))
    await sleep(2000)
  }
  throw new Error('pg_net did not answer within 60 s')
}

console.log('\n# A. 20 calls at once, default timeout (5 s)')
const ids = Array.from({ length: 20 }, (_, n) => post({ mode: 'sleep', seconds: 0, run: `pgnet-burst-${Date.now()}-${n}` }))
const burst = await responses(ids)
const ok = burst.filter((r) => r.status === '200').length
note(`${ok}/20 answered 200; ${burst.filter((r) => r.timedOut || /timeout|timed out/i.test(r.error)).length} timed out; other errors: ${[...new Set(burst.filter((r) => r.status !== '200' && !r.timedOut).map((r) => r.status || r.error))].join(', ') || 'none'}`)
check('burst measured (record the NOTE line; locally some cold-start calls timed out)', true)

console.log('\n# B. An 8 s call with the default 5 s timeout')
const runB = `pgnet-slow-${Date.now()}`
const [b] = await responses([post({ mode: 'sleep', seconds: 8, run: runB })])
await sleep(10_000)
const doneB = psql(`select count(*) from hosted_probe_heartbeats where run_id = '${runB}' and note = 'done'`) === '1'
note(`pg_net: ${b.status || 'no status'}${b.timedOut ? ', timed out' : ''} ${b.error}`)
check(`pg_net gave up, but the function still finished its work ("done" heartbeat: ${doneB})`, b.status !== '200' && doneB, JSON.stringify(b))

console.log('\n# C. The same call with a 15 s timeout')
const runC = `pgnet-slow-ok-${Date.now()}`
const [c] = await responses([post({ mode: 'sleep', seconds: 8, run: runC }, 15000)])
check(`answered ${c.status} (the timeout, not the function, decided the outcome in B)`, c.status === '200', JSON.stringify(c))

finish('pg_net checks')
