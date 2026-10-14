// Feature 5 (bulk reminders), stage 4: the same scenarios against the three versions. Local only.
// Run: npm run probe:reminders:compare   (~4 min; resets the reminder test host before and after)
// Needs `npm run probe:reminders:setup` and `npm run functions:serve`.
//
//   naive    stage 1: one Edge Function loops and marks everything at the end (send-reminders)
//   queue    stage 2: pgmq queue + worker, no pacing / lease / throttling (process-reminders, stage 2 settings)
//   limits   stage 3: the same worker with pacing (10/s), single-worker lease, 429 = come back later
// After the first run of each scenario, "the scheduler's next run" happens as it would in practice:
// naive → one more run; queue versions → workers until the queue is empty.
// Emails go to Mailpit only; only the test emails (…@reminder-test.example) are deleted afterwards.
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
  return { guests: Object.keys(perGuest).length, twice: Object.values(perGuest).filter((c) => c > 1).length, perGuest }
}
const queueLength = () => Number(psql(`select queue_length from pgmq.metrics('reminders')`))
const archived = () => Number(psql(`select count(*) from pgmq.a_reminders`))
process.on('exit', () => { execSync('npm run -s probe:reminders:seed', { stdio: 'ignore' }); execSync(`curl -s -o /dev/null -X DELETE "${MAILPIT}/search?query=${encodeURIComponent(TEST_MAIL)}"`) })

const call = (fn, body) => fetch(`${URL}/functions/v1/${fn}`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(180_000),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))

let stops = 0 // runs the Edge runtime stopped on its own (546): each may repeat the ONE email in flight
const VERSIONS = {
  naive: {
    run: (o = {}) => call('send-reminders', { hostId: HOST, ...o }),
    next: async (o = {}) => { await call('send-reminders', { hostId: HOST, provider: o.provider }) },
  },
  queue: {
    settings: { vt: 2, ratePerSecond: 0, lease: false, throttleAware: false, maxReads: 3 },
  },
  limits: {
    settings: { vt: 2, maxReads: 3 },
  },
}
for (const v of ['queue', 'limits']) {
  const s = VERSIONS[v].settings
  VERSIONS[v].run = async (o = {}) => {
    const r = await call('process-reminders', { ...s, ...o })
    if (r.status === 546) stops++
    return r
  }
  VERSIONS[v].next = async (o = {}) => {
    for (let i = 0; i < 120 && queueLength() > 0; i++) {
      await VERSIONS[v].run({ provider: o.provider })
      if (queueLength() > 0) await sleep(1200)
    }
  }
}
async function setup(version) {
  execSync('npm run -s probe:reminders:seed', { stdio: 'ignore' })
  await clearMail()
  if (version !== 'naive') psql(`select public.enqueue_reminders('${HOST}')`)
}

const fnUp = await fetch(`${URL}/functions/v1/process-reminders`, { method: 'OPTIONS', signal: AbortSignal.timeout(20000) }).then(() => true).catch(() => false)
if (!fnUp) { console.error('FAIL  functions serve is not running (npm run functions:serve)'); process.exit(1) }

// ---- scenarios ----
const SCENARIOS = [
  ['Quiet day: time until all 200 sent', async (v, V) => {
    const t0 = Date.now(); await V.run(); await V.next()
    const m = await inbox()
    return { text: `${m.guests}/200 in ${((Date.now() - t0) / 1000).toFixed(1)} s`, ok: m.guests === 200 && m.twice === 0 }
  }],
  ['Crash after 120 emails, then the next run', async (v, V) => {
    const s0 = stops; await V.run({ crashAfter: 120 }); await V.next()
    const m = await inbox()
    return { text: `${m.twice} guests twice`, twice: m.twice, allowed: stops - s0, guests: m.guests }
  }],
  ['Two runs at the same time', async (v, V) => {
    const s0 = stops
    await Promise.all([V.run({ delayMs: 30 }), (async () => { await sleep(500); return V.run({ delayMs: 30 }) })()])
    await V.next()
    const m = await inbox()
    return { text: `${m.twice} guests twice`, twice: m.twice, allowed: stops - s0, guests: m.guests }
  }],
  ['Provider limit 20/s, two runs at once', async (v, V) => {
    await Promise.all([V.run({ provider: 'test' }), (async () => { await sleep(300); return V.run({ provider: 'test' }) })()])
    await V.next({ provider: 'test' })
    const m = await inbox()
    const dead = v === 'naive' ? 0 : archived()
    return { text: `${m.guests}/200 reminded${dead ? `, ${dead} dead letters` : ''}${m.twice ? `, ${m.twice} twice` : ''}`, guests: m.guests, dead, twice: m.twice }
  }],
  ['Guest opted out after queuing', async (v, V) => {
    const token = psql(`select cancel_token from bookings where guest_email = 'guest-002@reminder-test.example'`)
    await anon.rpc('unsubscribe_reminders', { p_cancel_token: token })
    await V.run(); await V.next()
    const m = await inbox()
    const got = m.perGuest['guest-002@reminder-test.example'] ?? 0
    return { text: got ? 'reminded anyway ❌' : 'not reminded ✅', got }
  }],
  ['Booking cancelled after queuing', async (v, V) => {
    psql(`update bookings set status = 'cancelled' where guest_email = 'guest-003@reminder-test.example'`)
    await V.run(); await V.next()
    const m = await inbox()
    const got = m.perGuest['guest-003@reminder-test.example'] ?? 0
    return { text: got ? 'reminded anyway ❌' : 'not reminded ✅', got }
  }],
]

const results = {}
for (const [name, scenario] of SCENARIOS) {
  results[name] = {}
  for (const v of Object.keys(VERSIONS)) {
    await setup(v)
    results[name][v] = await scenario(v, VERSIONS[v])
    console.log(`  ${name} · ${v}: ${results[name][v].text}`)
  }
}

// ---- table ----
const width = Math.max(...SCENARIOS.map(([n]) => n.length))
const col = (s) => String(s).padEnd(30)
console.log(`\n${''.padEnd(width)}  ${col('naive (stage 1)')}${col('queue (stage 2)')}${col('queue + limits (stage 3)')}`)
for (const [name] of SCENARIOS) console.log(`${name.padEnd(width)}  ${['naive', 'queue', 'limits'].map((v) => col(results[name][v].text)).join('')}`)

// ---- expected pattern ----
let failures = 0
const check = (name, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `\n      → ${detail}` : ''}`) }
const R = (n) => results[SCENARIOS.find(([x]) => x.startsWith(n))[0]]
console.log()
check('quiet day: all three deliver 200', ['naive', 'queue', 'limits'].every((v) => R('Quiet day')[v].ok))
check('crash + next run: naive repeats ~120, the queue versions at most one per runtime stop',
  R('Crash')['naive'].twice >= 100 && ['queue', 'limits'].every((v) => R('Crash')[v].twice <= R('Crash')[v].allowed && R('Crash')[v].guests === 200), JSON.stringify(R('Crash')))
check('two runs at once: naive reminds (almost) everyone twice, the queue versions at most one per runtime stop',
  R('Two runs')['naive'].twice >= 150 && ['queue', 'limits'].every((v) => R('Two runs')[v].twice <= R('Two runs')[v].allowed && R('Two runs')[v].guests === 200), JSON.stringify(R('Two runs')))
check('provider limit: naive and the stage 2 queue lose reminders; with limits all 200 arrive, no dead letters',
  (R('Provider')['naive'].guests < 200 || R('Provider')['naive'].twice > 0) && R('Provider')['queue'].dead > 0 && R('Provider')['limits'].guests === 200 && R('Provider')['limits'].dead === 0, JSON.stringify(R('Provider')))
check('opted out after queuing: naive reminds anyway (no opt-out), both queue versions don\'t (shared worker code checks it)',
  R('Guest opted out')['naive'].got > 0 && R('Guest opted out')['queue'].got === 0 && R('Guest opted out')['limits'].got === 0)
check('cancelled booking: nobody is reminded in any version', ['naive', 'queue', 'limits'].every((v) => R('Booking cancelled')[v].got === 0))
console.log(`\n${failures === 0 ? 'All checks passed' : `${failures} check(s) FAILED`} (test data, queue and test emails reset)`)
process.exit(failures ? 1 : 0)
