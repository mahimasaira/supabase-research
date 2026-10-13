// Proof script for feature 4 (DocuSign), stage 2: sending the agreement. Local only.
// Run: npm run probe:docusign:proof:send   (resets the test data before and after)
// Needs: `npm run probe:docusign:setup` once, and `npm run functions:serve` running
// (restarted after the setup, so the functions see supabase/functions/.env).
//
// Section A never reaches DocuSign: the database's send URL points at an unreachable
// address while it runs. Section B creates REAL envelopes (DocuSign emails them) and only
// runs when DOCUSIGN_TEST_SIGNER_EMAIL is set in .env.local; nothing is sent anywhere else.
import { createClient } from '@supabase/supabase-js'
import { execSync } from 'node:child_process'
import { bookRecurringRpc } from '../../services/supabase/recurring/rpc.js'
import { listAuditHistory } from '../../services/supabase/audit/history.js'
import { groupHistory } from '../../features/audit/history.js'
import { docusign } from './docusign-api.mjs'

const DB = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const HOST = '11111111-1111-4111-8111-111111111111'
const FN = `${process.env.VITE_SUPABASE_URL}/functions/v1/docusign-send`
const TEST_EMAIL = (process.env.DOCUSIGN_TEST_SIGNER_EMAIL ?? '').trim()
const psql = (q) => execSync(`psql ${DB} -At -F'|' -c "${q.replace(/"/g, '\\"')}"`).toString().trim()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const client = () => createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY, { auth: { persistSession: false } })
const slotAt = (week) => psql(`select id || '|' || to_char(starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  from slots where host_id = '${HOST}' order by starts_at offset ${week - 1} limit 1`).split('|')
const reset = () => {
  execSync('npm run -s probe:audit:seed', { stdio: 'ignore' })
  psql(`update profiles set require_signature = true where id = '${HOST}'`)
}
const secretKey = JSON.parse(execSync('npx supabase status -o json < /dev/null', { stdio: ['ignore', 'pipe', 'ignore'] }).toString()).SECRET_KEY
const callFn = (body, key = secretKey) =>
  fetch(FN, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }))

let failures = 0
function check(name, ok, detail) {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `\n      → ${detail}` : ''}`)
}

// pg_net sends queued requests in the background after commit; count what it has processed.
async function requestsSentDuring(fn) {
  const before = Number(psql('select count(*) from net._http_response'))
  await fn()
  for (let i = 0; i < 40 && psql('select count(*) from net.http_request_queue') !== '0'; i++) await sleep(250)
  await sleep(1500)
  return Number(psql('select count(*) from net._http_response')) - before
}
const anon = client()
const book = (slotId, name, email = 'g@example.com') =>
  anon.from('bookings').insert({ slot_id: slotId, guest_name: name, guest_email: email, cancel_token: crypto.randomUUID() })

// ===========================================================================
console.log('\n# A. When is an agreement sent? (DocuSign unreachable during this section)')
reset()
const realUrl = psql(`select decrypted_secret from vault.decrypted_secrets where name = 'docusign_send_url'`)
if (!realUrl) { console.error('FAIL  run `npm run probe:docusign:setup` first'); process.exit(1) }
psql(`select vault.update_secret(id, 'http://127.0.0.1:9/unreachable') from vault.secrets where name = 'docusign_send_url'`)
try {
  psql(`update profiles set require_signature = false where id = '${HOST}'`)
  let n = await requestsSentDuring(() => book(slotAt(1)[0], 'Plain Guest'))
  check('host without opt-in: booking confirmed, no send request', n === 0 && psql(`select status from bookings where guest_name = 'Plain Guest'`) === 'confirmed', `requests: ${n}`)
  psql(`update profiles set require_signature = true where id = '${HOST}'`)

  n = await requestsSentDuring(() => book(slotAt(2)[0], 'Anna'))
  check('opt-in booking: exactly 1 send request, after commit', n === 1, `requests: ${n}`)

  const [w3, w3Start] = slotAt(3)
  n = await requestsSentDuring(async () => {
    const r = await bookRecurringRpc(anon, { hostId: HOST, firstSlot: { id: w3, starts_at: w3Start }, weeks: 2, guestName: 'Clash', guestEmail: 'c@example.com' })
    if (!r.clash) throw new Error('expected a clash in week 2 (week 4 is taken)')
  })
  check('recurring booking that rolls back (clash): 0 send requests (pg_net only sends after commit)', n === 0, `requests: ${n}`)
  const [w5, w5Start] = slotAt(5)
  n = await requestsSentDuring(() => bookRecurringRpc(anon, { hostId: HOST, firstSlot: { id: w5, starts_at: w5Start }, weeks: 2, guestName: 'Weekly', guestEmail: 'w@example.com' }))
  check('recurring booking (2 weeks): 1 send request for the whole series', n === 1, `requests: ${n}`)

} finally {
  // Real sending stays off until the fake-address bookings are gone (section B resets first):
  // since stage 4 the retry job (every minute) would otherwise send them for real.
  process.on('exit', () => psql(`select vault.update_secret(id, '${realUrl.replace(/'/g, "''")}') from vault.secrets where name = 'docusign_send_url'`))
}
const restoreSending = () => psql(`select vault.update_secret(id, '${realUrl.replace(/'/g, "''")}') from vault.secrets where name = 'docusign_send_url'`)

console.log('\n# A. Who may call the send function, and no double sends')
const annaId = psql(`select id from bookings where guest_name = 'Anna'`)
const noKey = await callFn({ booking_id: annaId }, null)
const anonKey = await callFn({ booking_id: annaId }, process.env.VITE_SUPABASE_ANON_KEY)
check('without the secret key: 401 (browsers can\'t trigger sends)', noKey.status === 401 && anonKey.status === 401, JSON.stringify({ noKey, anonKey }))
for (const state of ['sent', 'sending']) {
  psql(`update bookings set signature_status = '${state}' where id = '${annaId}'`)
  const again = await callFn({ booking_id: annaId })
  check(`booking already '${state}': nothing sent again`, again.status === 200 && again.body.sent === false, JSON.stringify(again))
}
const confirmedId = psql(`select id from bookings where guest_name = 'Plain Guest'`)
const notWaiting = await callFn({ booking_id: confirmedId })
check('confirmed booking (host without opt-in): nothing sent', notWaiting.body.sent === false, JSON.stringify(notWaiting))

// ===========================================================================
if (!TEST_EMAIL) {
  console.log('\nSKIP  B. real sending: add DOCUSIGN_TEST_SIGNER_EMAIL=<your address> to .env.local to run it')
} else {
  console.log(`\n# B. Real agreements, sent by DocuSign to the test address`)
  reset()
  restoreSending()
  const waitForSend = async (name) => {
    for (let i = 0; i < 60; i++) {
      const s = psql(`select string_agg(distinct coalesce(signature_status, '-'), ',') from bookings where guest_name = '${name}'`)
      if (s === 'sent' || s.includes('failed')) return s
      await sleep(1000)
    }
    return psql(`select string_agg(distinct coalesce(signature_status, '-'), ',') from bookings where guest_name = '${name}'`)
  }

  await book(slotAt(1)[0], 'Signer Test', TEST_EMAIL)
  const single = await waitForSend('Signer Test')
  const singleRow = psql(`select coalesce(envelope_id, '') || '|' || coalesce(signature_error, '') from bookings where guest_name = 'Signer Test'`).split('|')
  check('booking → signature_status sent, envelope_id recorded', single === 'sent' && !!singleRow[0],
    `${single} ${singleRow[1]}${/Missing environment variable/.test(singleRow[1]) ? '  (restart npm run functions:serve after the setup)' : ''}`)

  if (singleRow[0]) {
    const envelope = await docusign('GET', `/envelopes/${singleRow[0]}?include=recipients`)
    check('DocuSign has the envelope: status sent, addressed to the test email',
      envelope.status === 'sent' && envelope.recipients?.signers?.[0]?.email?.toLowerCase() === TEST_EMAIL.toLowerCase(),
      JSON.stringify({ status: envelope.status, error: envelope.errorCode }))
    const again = await callFn({ booking_id: psql(`select id from bookings where guest_name = 'Signer Test'`) })
    check('calling the function again sends nothing (no duplicate email)', again.body.sent === false, JSON.stringify(again))
  }

  const [w5, w5Start] = slotAt(5)
  await bookRecurringRpc(anon, { hostId: HOST, firstSlot: { id: w5, starts_at: w5Start }, weeks: 2, guestName: 'Series Signer', guestEmail: TEST_EMAIL })
  const series = await waitForSend('Series Signer')
  check('recurring booking (2 weeks) → ONE envelope shared by both weeks',
    series === 'sent' && psql(`select count(distinct envelope_id) || '|' || count(*) from bookings where guest_name = 'Series Signer'`) === '1|2', series)

  const host = client()
  await host.auth.signInWithPassword({ email: 'recurring-host@test.dev', password: 'password123' })
  const groups = groupHistory((await listAuditHistory(host, { hostId: HOST })).entries, HOST)
  const sentLines = groups.filter((g) => g.who === 'DocuSign' && g.text.startsWith('sent the agreement to'))
  check('History: "DocuSign sent the agreement…" (once per envelope, no "sending" noise)',
    sentLines.length === 2 && !groups.some((g) => /sending/.test(g.text)), JSON.stringify(groups.map((g) => `${g.who}: ${g.text}`)))
  for (const g of sentLines) console.log(`      ${g.who}: ${g.text}`)
  console.log(`      → 2 agreements emailed to the test address (DocuSign demo, not legally binding)`)
}

reset()
psql(`update profiles set require_signature = false where id = '${HOST}'`)
console.log(`\n${failures === 0 ? 'All checks passed' : `${failures} check(s) FAILED`} (test data reset)`)
process.exit(failures ? 1 : 0)

