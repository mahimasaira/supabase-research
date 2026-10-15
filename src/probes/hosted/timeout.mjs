// npm run hosted:timeout [-- <seconds>]: Edge Function time limits on the hosted project.
// Locally: the gateway answered 504 after 150 s while the function kept running (only a restart
// stopped it). Here: does the hosted gateway cut the request, when, and does the function keep
// running afterwards (heartbeats in hosted_probe_heartbeats tell)?
import { check, finish, note, probe, psql, requireLockdown } from './hosted-env.mjs'

requireLockdown()
const long = Number(process.argv[2]) || 200
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))

async function timed(seconds) {
  const run = `timeout-${seconds}-${Date.now()}`
  const t0 = Date.now()
  const r = await probe({ mode: 'sleep', seconds, run }).catch((e) => ({ status: 0, error: String(e) }))
  const elapsed = Math.round((Date.now() - t0) / 1000)
  return { run, status: r.status, elapsed }
}

// Waits until the heartbeats stop (no new beat for 30 s, or 'done'), max 10 minutes.
async function heartbeats(run) {
  let last = ''
  for (let waited = 0; waited < 600; waited += 10) {
    const now = psql(`select coalesce(max(second), -1) || '|' || bool_or(note = 'done') from hosted_probe_heartbeats where run_id = '${run}'`)
    if (now.endsWith('|t') || (now === last && waited >= 30)) return { lastSecond: Number(now.split('|')[0]), done: now.endsWith('|t') }
    last = now
    await sleep(10_000)
  }
  return { lastSecond: Number(last.split('|')[0]), done: false }
}

console.log('\n# 1. A short call (20 s) as a baseline')
let r = await timed(20)
check(`20 s sleep → ${r.status} after ${r.elapsed} s`, r.status === 200)

console.log(`\n# 2. A long call (${long} s)`)
r = await timed(long)
note(`the caller got ${r.status} after ${r.elapsed} s`)
const hb = await heartbeats(r.run)
note(`the function's last heartbeat: second ${hb.lastSecond}${hb.done ? ' (it finished: "done")' : ' (no "done": it was stopped)'}`)
if (r.status !== 200 && hb.lastSecond > r.elapsed + 5) note(`→ the function kept running ~${hb.lastSecond - r.elapsed} s after the caller got its error (same as locally)`)
else if (r.status !== 200) note('→ the function stopped at (about) the same time the caller got its error')
check('measured (record the NOTE lines in FRICTION_LOG / BLOG_REPORT)', true)
finish('timeout checks')
