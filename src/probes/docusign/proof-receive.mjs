// Proof script for feature 4 (DocuSign), stage 3: receiving the result. Local only.
// Run: npm run probe:docusign:proof:receive   (resets the test data before and after)
// Needs: `npm run probe:docusign:setup` and `npm run functions:serve`.
//
// A. Simulated DocuSign Connect messages, signed with the local webhook key from
//    supabase/functions/.env. Sending is switched off; nothing reaches DocuSign.
// B. A REAL envelope (only with DOCUSIGN_TEST_SIGNER_EMAIL): sent, checked, voided through the
//    DocuSign API, checked again → booking cancelled. Signing itself needs a person (see TESTING.md).
import { createClient } from '@supabase/supabase-js'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { bookRecurringRpc } from '../../services/supabase/recurring/rpc.js'
import { listAuditHistory } from '../../services/supabase/audit/history.js'
import { groupHistory } from '../../features/audit/history.js'
import { docusign } from './docusign-api.mjs'

const DB = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const HOST = '11111111-1111-4111-8111-111111111111'
const URL = process.env.VITE_SUPABASE_URL
const ACCOUNT = (process.env.DOCUSIGN_ACCOUNT_ID ?? '').trim()
const TEST_EMAIL = (process.env.DOCUSIGN_TEST_SIGNER_EMAIL ?? '').trim()
const HMAC_KEY = readFileSync('supabase/functions/.env', 'utf8').match(/^DOCUSIGN_CONNECT_HMAC_KEY=(.+)$/m)?.[1]
if (!HMAC_KEY) { console.error('FAIL  run `npm run probe:docusign:setup` first'); process.exit(1) }

const psql = (q) => execSync(`psql ${DB} -At -F'|' -c "${q.replace(/"/g, '\\"')}"`).toString().trim()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const client = () => createClient(URL, process.env.VITE_SUPABASE_ANON_KEY, { auth: { persistSession: false } })
const slotAt = (week) => psql(`select id || '|' || to_char(starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  from slots where host_id = '${HOST}' order by starts_at offset ${week - 1} limit 1`).split('|')
const state = (name) => psql(`select string_agg(distinct b.status || '/' || coalesce(b.signature_status, '-'), ',') from bookings b where b.guest_name = '${name}'`)
const slotBooked = (name) => psql(`select bool_or(s.is_booked) from bookings b join slots s on s.id = b.slot_id where b.guest_name = '${name}'`) === 't'
const realSendUrl = psql(`select coalesce(max(decrypted_secret), '') from vault.decrypted_secrets where name = 'docusign_send_url'`)
const setSendUrl = (url) => psql(`select vault.update_secret(id, '${url.replace(/'/g, "''")}') from vault.secrets where name = 'docusign_send_url'`)
const reset = () => {
  execSync('npm run -s probe:audit:seed', { stdio: 'ignore' })
  psql(`update profiles set require_signature = true where id = '${HOST}'`)
}
process.on('exit', () => { if (realSendUrl) setSendUrl(realSendUrl) })

let failures = 0
function check(name, ok, detail) {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `\n      → ${detail}` : ''}`)
}

// A DocuSign Connect message ("SIM" JSON format), signed like DocuSign does.
const sign = (body, key = HMAC_KEY) => createHmac('sha256', key).update(body).digest('base64')
async function webhook(event, envelopeId, { key = HMAC_KEY, account = ACCOUNT, headers, tamper } = {}) {
  const body = JSON.stringify({ event, apiVersion: 'v2.1', generatedDateTime: new Date().toISOString(), data: { accountId: account, envelopeId } })
  const signed = key ? { 'X-DocuSign-Signature-1': sign(body, key) } : {}
  const res = await fetch(`${URL}/functions/v1/docusign-webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(headers ?? signed) },
    body: tamper ? body.replace(envelopeId, tamper) : body,
    signal: AbortSignal.timeout(60_000),
  })
  return { status: res.status, ...(await res.json().catch(() => ({}))) }
}
const anon = client()
const book = (week, name, email = 'g@example.com') =>
  anon.from('bookings').insert({ slot_id: slotAt(week)[0], guest_name: name, guest_email: email, cancel_token: crypto.randomUUID() })
// Pretend docusign-send already sent an envelope for these bookings.
const markSent = (name, envelopeId) => psql(`update bookings set signature_status = 'sent', envelope_id = '${envelopeId}' where guest_name = '${name}'`)

// ===========================================================================
console.log('\n# A. Webhook: only genuine DocuSign messages count')
reset()
if (realSendUrl) setSendUrl('http://127.0.0.1:9/unreachable')
await book(1, 'Anna'); markSent('Anna', 'env-anna')
await book(2, 'Ben'); markSent('Ben', 'env-ben')
const carlaToken = crypto.randomUUID()
await anon.from('bookings').insert({ slot_id: slotAt(3)[0], guest_name: 'Carla', guest_email: 'c@example.com', cancel_token: carlaToken })
markSent('Carla', 'env-carla')
const [w5, w5Start] = slotAt(5)
await bookRecurringRpc(anon, { hostId: HOST, firstSlot: { id: w5, starts_at: w5Start }, weeks: 2, guestName: 'Weekly', guestEmail: 'w@example.com' })
markSent('Weekly', 'env-weekly')

let r = await webhook('envelope-completed', 'env-anna', { key: null })
check('no signature → 401, nothing changes', r.status === 401 && state('Anna') === 'pending_signature/sent', JSON.stringify(r))
r = await webhook('envelope-completed', 'env-anna', { key: 'not-the-key' })
check('signed with the wrong key → 401', r.status === 401, JSON.stringify(r))
r = await webhook('envelope-completed', 'env-anna', { tamper: 'env-ben' })
check('body changed after signing (anna → ben) → 401', r.status === 401 && state('Ben') === 'pending_signature/sent', JSON.stringify(r))
r = await webhook('envelope-completed', 'env-anna', { account: '00000000-0000-4000-8000-000000000000' })
check('genuine signature but another DocuSign account → ignored', r.status === 200 && r.ignored === 'other account' && state('Anna') === 'pending_signature/sent', JSON.stringify(r))
r = await webhook('envelope-delivered', 'env-anna')
check('"delivered" (opened, not signed) → acknowledged, no change', r.status === 200 && !!r.ignored && state('Anna') === 'pending_signature/sent', JSON.stringify(r))

console.log('\n# A. Results')
r = await webhook('envelope-completed', 'env-anna')
check('signed → booking confirmed, slot stays booked', r.changed === 1 && state('Anna') === 'confirmed/completed' && slotBooked('Anna'), JSON.stringify(r))
r = await webhook('envelope-completed', 'env-anna')
check('same message again (DocuSign retry) → 200, no change', r.status === 200 && r.changed === 0 && state('Anna') === 'confirmed/completed', JSON.stringify(r))
r = await webhook('envelope-voided', 'env-anna')
check('late "voided" after signing → ignored, stays confirmed', r.changed === 0 && state('Anna') === 'confirmed/completed', JSON.stringify(r))
r = await webhook('envelope-declined', 'env-ben')
check('declined → booking cancelled, slot free again', r.changed === 1 && state('Ben') === 'cancelled/declined' && !slotBooked('Ben'), JSON.stringify(r))
await anon.rpc('cancel_booking', { p_cancel_token: carlaToken })
r = await webhook('envelope-completed', 'env-carla')
check('guest cancelled first, signs later → stays cancelled', r.changed === 0 && state('Carla').startsWith('cancelled/'), JSON.stringify({ r, carla: state('Carla') }))
r = await webhook('envelope-completed', 'env-weekly', { headers: { 'X-DocuSign-Signature-1': sign('{}'), 'X-DocuSign-Signature-2': sign(JSON.stringify({ event: 'envelope-completed', apiVersion: 'v2.1', generatedDateTime: 'x', data: {} })) } })
check('(signature on a different body in both headers → 401)', r.status === 401, JSON.stringify(r))
{
  const body = JSON.stringify({ event: 'envelope-completed', apiVersion: 'v2.1', data: { accountId: ACCOUNT, envelopeId: 'env-weekly' } })
  const res = await fetch(`${URL}/functions/v1/docusign-webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-DocuSign-Signature-1': sign(body, 'old-rotated-key'), 'X-DocuSign-Signature-2': sign(body) },
    body,
  }).then((x) => x.json())
  check('key rotation: valid signature in header -2 is accepted → whole series confirmed',
    res.changed === 2 && state('Weekly') === 'confirmed/completed', JSON.stringify(res))
}

const host = client()
await host.auth.signInWithPassword({ email: 'recurring-host@test.dev', password: 'password123' })
const groups = groupHistory((await listAuditHistory(host, { hostId: HOST })).entries, HOST)
const docusignLines = groups.filter((g) => g.who === 'DocuSign').map((g) => g.text)
check('History shows the results, as DocuSign',
  docusignLines.some((t) => t.startsWith('Anna signed the agreement')) && docusignLines.some((t) => t.startsWith('Ben declined the agreement'))
  && docusignLines.some((t) => t.startsWith('Weekly signed the agreement') && t.includes('+1 more week')),
  JSON.stringify(docusignLines))
for (const t of docusignLines) console.log(`      DocuSign: ${t}`)

console.log('\n# A. "Check signature status": who may ask')
const sync = (c, headers) => c.functions.invoke('docusign-sync', headers ? { headers } : undefined)
  .then(async ({ data, error }) => ({ data, status: error?.context?.status ?? 200 }))
let s = await sync(anon)
check('guest (no login) → 401', s.status === 401, JSON.stringify(s))
const other = client()
await other.auth.signUp({ email: `sync-other-${Date.now()}@test.dev`, password: 'secret123' })
psql(`update bookings set status = 'pending_signature', signature_status = 'sent' where guest_name = 'Anna'`) // one out again
s = await sync(other)
check('another host → checks 0 agreements (only their own)', s.status === 200 && s.data?.checked === 0, JSON.stringify(s))
psql(`delete from auth.users where email like 'sync-other-%@test.dev'`)
if (realSendUrl) setSendUrl(realSendUrl)

// ===========================================================================
if (!TEST_EMAIL) {
  console.log('\nSKIP  B. real envelope: add DOCUSIGN_TEST_SIGNER_EMAIL=<your address> to .env.local to run it')
} else {
  console.log('\n# B. A real envelope: sent → still waiting → voided in DocuSign → booking cancelled')
  reset()
  await book(1, 'Real Signer', TEST_EMAIL)
  for (let i = 0; i < 60 && !/sent|failed/.test(state('Real Signer')); i++) await sleep(1000)
  const envelopeId = psql(`select coalesce(envelope_id, '') from bookings where guest_name = 'Real Signer'`)
  check('agreement sent (stage 2)', state('Real Signer') === 'pending_signature/sent' && !!envelopeId, state('Real Signer'))
  if (envelopeId) {
    s = await sync(host)
    check('host checks: 1 agreement, still waiting → booking unchanged',
      s.data?.checked === 1 && s.data?.waiting === 1 && state('Real Signer') === 'pending_signature/sent', JSON.stringify(s))
    const voided = await docusign('PUT', `/envelopes/${envelopeId}`, { status: 'voided', voidedReason: 'Booking probe test (stage 3)' })
    check('envelope voided in DocuSign (API)', voided.status === 200, JSON.stringify(voided))
    s = await sync(host)
    check('host checks again → booking cancelled (voided), slot free',
      s.data?.cancelled === 1 && state('Real Signer') === 'cancelled/voided' && !slotBooked('Real Signer'), JSON.stringify(s))
    console.log('      → DocuSign emailed the test address twice (agreement + "voided" notice)')
  }
}

reset()
psql(`update profiles set require_signature = false where id = '${HOST}'`)
console.log(`\n${failures === 0 ? 'All checks passed' : `${failures} check(s) FAILED`} (test data reset)`)
console.log('Signing for real needs a person: see TESTING.md, feature 4, stage 3.')
process.exit(failures ? 1 : 0)
