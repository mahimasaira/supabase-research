// Proof script for feature 4 (DocuSign), stage 4: when things go wrong. Local only.
// Run: npm run probe:docusign:proof:failures   (resets the test data before and after)
//
// Written BEFORE the fixes: its first run (recorded in FRICTION_LOG.md) shows the drawbacks
// of stages 1-3; the same checks pass once stage 4's fixes are in.
//   1. a send request that gets lost is never retried
//   2. a booking that's never signed holds the slot forever
//   3. cancelling a booking leaves the agreement signable in DocuSign
//   4. nothing runs on a schedule
// Sections 1-3 never reach DocuSign (function URLs point at an unreachable address).
// Section 5 uses ONE real envelope (only with DOCUSIGN_TEST_SIGNER_EMAIL).
import { createClient } from '@supabase/supabase-js'
import { execSync } from 'node:child_process'
import { docusign } from './docusign-api.mjs'

const DB = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const HOST = '11111111-1111-4111-8111-111111111111'
const TEST_EMAIL = (process.env.DOCUSIGN_TEST_SIGNER_EMAIL ?? '').trim()
const psql = (q) => execSync(`psql ${DB} -At -F'|' -c "${q.replace(/"/g, '\\"')}"`, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()
// Like psql(), but returns the error instead of throwing (e.g. "function does not exist" before the fixes).
const trySql = (q) => { try { return { value: psql(q) } } catch (err) { return { error: err.stderr.toString().split('\n')[0] } } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const client = () => createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY, { auth: { persistSession: false } })
const slotAt = (week) => psql(`select id || '|' || to_char(starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  from slots where host_id = '${HOST}' order by starts_at offset ${week - 1} limit 1`).split('|')
const state = (name) => psql(`select coalesce(string_agg(distinct b.status || '/' || coalesce(b.signature_status, '-'), ','), 'none') from bookings b where b.guest_name = '${name}'`)
const slotBooked = (name) => psql(`select bool_or(s.is_booked) from bookings b join slots s on s.id = b.slot_id where b.guest_name = '${name}'`) === 't'

// Function URLs in Vault: point them at an unreachable address while sections 1-3 run.
const vaultUrls = ['docusign_send_url', 'docusign_void_url']
const saved = Object.fromEntries(vaultUrls.map((n) => [n, psql(`select coalesce(max(decrypted_secret), '') from vault.decrypted_secrets where name = '${n}'`)]))
const setUrl = (name, url) => psql(`select vault.update_secret(id, '${url.replace(/'/g, "''")}') from vault.secrets where name = '${name}'`)
const offline = () => vaultUrls.forEach((n) => saved[n] && setUrl(n, 'http://127.0.0.1:9/unreachable'))
const online = () => vaultUrls.forEach((n) => saved[n] && setUrl(n, saved[n]))
process.on('exit', online)

let failures = 0
function check(name, ok, detail) {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `\n      → ${detail}` : ''}`)
}
// Requests pg_net processed while fn ran (it sends after commit, in the background).
async function drain() {
  for (let i = 0; i < 40 && psql('select count(*) from net.http_request_queue') !== '0'; i++) await sleep(250)
  await sleep(1500)
}
// Counts responses to requests newer than the start: pg_net deletes OLD responses now and then
// (so a before/after row count can go wrong), and rolled-back requests never get a response.
async function requestsDuring(fn) {
  await drain() // earlier requests (e.g. the booking's own send) must not be counted
  const lastId = psql('select last_value from net.http_request_queue_id_seq')
  const result = await fn()
  await drain()
  return { n: Number(psql(`select count(*) from net._http_response where id > ${lastId}`)), result }
}
const reset = () => {
  execSync('npm run -s probe:audit:seed', { stdio: 'ignore' })
  psql(`update profiles set require_signature = true where id = '${HOST}'`)
  offline()
}
const anon = client()
const book = (week, name, email = 'g@example.com', token = crypto.randomUUID()) =>
  anon.from('bookings').insert({ slot_id: slotAt(week)[0], guest_name: name, guest_email: email, cancel_token: token })
const markSent = (name, envelopeId) => psql(`update bookings set signature_status = 'sent', envelope_id = '${envelopeId}' where guest_name = '${name}'`)
const retry = (args = "p_min_age => '0 seconds'") => trySql(`select public.docusign_retry_sends(${args})`)

// ===========================================================================
console.log('\n# 1. A send request that gets lost')
reset()
let { n } = await requestsDuring(() => book(1, 'Lost'))
const lostError = psql(`select coalesce(error_msg, '') from net._http_response order by id desc limit 1`)
check('(setup) the send request fails, the booking keeps waiting', n === 1 && /connect/i.test(lostError) && state('Lost') === 'pending_signature/pending', `${n} ${lostError} ${state('Lost')}`)
let r
;({ n, result: r } = await requestsDuring(() => retry()))
check('a retry job sends it again', !r.error && n === 1, r.error ?? `requests: ${n}`)
const later = ['…but not immediately after a failure (backoff)', '…and again once the backoff has passed',
  '…and gives up after 5 attempts', 'a send that crashed half-way ("sending" for 10 min) is marked failed and retried']
if (r.error) {
  for (const name of later) check(name, false, 'no retry mechanism (and no attempt counter) exists')
} else {
  psql(`update bookings set signature_status = 'failed', signature_attempts = 2, signature_updated_at = now() where guest_name = 'Lost'`)
  ;({ n, result: r } = await requestsDuring(() => retry('')))
  check('…but not immediately after a failure (backoff)', !r.error && n === 0, r.error ?? `requests: ${n}`)
  psql(`update bookings set signature_updated_at = now() - interval '1 hour' where guest_name = 'Lost'`)
  ;({ n, result: r } = await requestsDuring(() => retry('')))
  check('…and again once the backoff has passed', !r.error && n === 1, r.error ?? `requests: ${n}`)
  psql(`update bookings set signature_status = 'failed', signature_attempts = 5, signature_updated_at = now() - interval '1 day' where guest_name = 'Lost'`)
  ;({ n, result: r } = await requestsDuring(() => retry()))
  check('…and gives up after 5 attempts', !r.error && n === 0, r.error ?? `requests: ${n}`)
  psql(`update bookings set signature_status = 'sending', signature_attempts = 1, signature_updated_at = now() - interval '10 minutes' where guest_name = 'Lost'`)
  ;({ n, result: r } = await requestsDuring(() => retry()))
  check('a send that crashed half-way ("sending" for 10 min) is marked failed and retried',
    !r.error && n === 1 && /failed/.test(state('Lost')), r.error ?? `requests: ${n}, ${state('Lost')}`)

}

// ===========================================================================
console.log('\n# 2. A booking that is never signed')
reset()
psql(`update profiles set require_signature = false where id = '${HOST}'`)
await book(1, 'Confirmed Guest')
psql(`update profiles set require_signature = true where id = '${HOST}'`)
await book(2, 'Never Signs')
psql(`update bookings set created_at = now() - interval '3 days' where guest_name = 'Never Signs'`)
await book(3, 'Fresh')
r = trySql(`select public.docusign_expire_unsigned()`)
check('unsigned for 3 days → cancelled as expired, slot free again',
  !r.error && state('Never Signs') === 'cancelled/expired' && !slotBooked('Never Signs'), r.error ?? state('Never Signs'))
check('…a fresh waiting booking and a confirmed one are left alone',
  state('Fresh') === 'pending_signature/pending' && state('Confirmed Guest') === 'confirmed/-', `${state('Fresh')} ${state('Confirmed Guest')}`)
psql(`insert into slots (host_id, starts_at, ends_at) values ('${HOST}', now() + interval '30 minutes', now() + interval '1 hour')`)
await anon.from('bookings').insert({ slot_id: psql(`select id from slots where host_id = '${HOST}' and starts_at < now() + interval '1 hour'`), guest_name: 'Last Minute', guest_email: 'l@example.com', cancel_token: crypto.randomUUID() })
r = trySql(`select public.docusign_expire_unsigned()`)
check('a waiting booking whose session starts within the hour → expired (no point signing after)',
  !r.error && state('Last Minute') === 'cancelled/expired', r.error ?? state('Last Minute'))

// ===========================================================================
console.log('\n# 3. Cancelling a booking whose agreement is out')
reset()
const doraToken = crypto.randomUUID()
await book(1, 'Dora', 'd@example.com', doraToken)
markSent('Dora', 'env-dora')
;({ n } = await requestsDuring(() => anon.rpc('cancel_booking', { p_cancel_token: doraToken })))
check('guest cancels → a request to withdraw (void) the agreement', n === 1, `requests: ${n}`)
const [w5, w5Start] = slotAt(5)
const { bookRecurringRpc } = await import('../../services/supabase/recurring/rpc.js')
await bookRecurringRpc(anon, { hostId: HOST, firstSlot: { id: w5, starts_at: w5Start }, weeks: 2, guestName: 'Series', guestEmail: 's@example.com' })
markSent('Series', 'env-series')
const [week5, week6] = psql(`select string_agg(id::text, '|' order by week_no) from bookings where guest_name = 'Series'`).split('|')
;({ n } = await requestsDuring(() => psql(`update bookings set status = 'cancelled' where id = '${week5}'`)))
check('recurring: cancelling ONE week keeps the agreement (it still covers week 2)', n === 0, `requests: ${n}`)
;({ n } = await requestsDuring(() => psql(`update bookings set status = 'cancelled' where id = '${week6}'`)))
check('…cancelling the last week withdraws it', n === 1, `requests: ${n}`)
await book(3, 'Erin'); markSent('Erin', 'env-erin')
;({ n } = await requestsDuring(() => psql(`select public.docusign_apply_envelope_status('env-erin', 'declined')`)))
check('declined by the guest → nothing to withdraw', n === 0, `requests: ${n}`)

// ===========================================================================
console.log('\n# 4. Scheduled jobs')
const jobs = trySql(`select string_agg(jobname || ' ' || schedule, ', ' order by jobname) from cron.job where jobname like 'docusign-%'`)
check('retry and expiry run on a schedule (pg_cron)',
  !jobs.error && jobs.value.includes('docusign-retry-sends') && jobs.value.includes('docusign-expire-unsigned'), jobs.error ?? jobs.value)
if (!jobs.error && jobs.value) {
  let ran = ''
  for (let i = 0; i < 75 && !ran; i++) {
    ran = psql(`select coalesce(max(d.status), '') from cron.job_run_details d join cron.job j on j.jobid = d.jobid
                where j.jobname = 'docusign-retry-sends' and d.start_time > now() - interval '2 minutes'`)
    if (!ran) await sleep(1000)
  }
  check('…and the retry job has actually run (within the last 2 minutes)', ran === 'succeeded', ran || 'no run')
}

// ===========================================================================
online()
if (!TEST_EMAIL) {
  console.log('\nSKIP  5. real envelope: add DOCUSIGN_TEST_SIGNER_EMAIL=<your address> to .env.local')
} else {
  console.log('\n# 5. Real envelope: the guest cancels, is the agreement withdrawn in DocuSign?')
  execSync('npm run -s probe:audit:seed', { stdio: 'ignore' })
  psql(`update profiles set require_signature = true where id = '${HOST}'`)
  const token = crypto.randomUUID()
  await book(1, 'Real Cancel', TEST_EMAIL, token)
  for (let i = 0; i < 60 && !/sent|failed/.test(state('Real Cancel')); i++) await sleep(1000)
  const envelopeId = psql(`select coalesce(envelope_id, '') from bookings where guest_name = 'Real Cancel'`)
  check('(setup) agreement sent', !!envelopeId, state('Real Cancel'))
  if (envelopeId) {
    await anon.rpc('cancel_booking', { p_cancel_token: token })
    let status = ''
    for (let i = 0; i < 30 && status !== 'voided'; i++) {
      await sleep(1000)
      status = (await docusign('GET', `/envelopes/${envelopeId}`)).status
    }
    check('after the guest cancels, DocuSign shows the envelope as voided (no longer signable)', status === 'voided', `DocuSign status: ${status}`)
    if (status !== 'voided') {
      await docusign('PUT', `/envelopes/${envelopeId}`, { status: 'voided', voidedReason: 'Booking probe cleanup' })
      console.log('      (voided by the test script afterwards, to clean up)')
    }
  }
}

execSync('npm run -s probe:audit:seed', { stdio: 'ignore' })
psql(`update profiles set require_signature = false where id = '${HOST}'`)
console.log(`\n${failures === 0 ? 'All checks passed' : `${failures} check(s) FAILED`} (test data reset)`)
process.exit(failures ? 1 : 0)
