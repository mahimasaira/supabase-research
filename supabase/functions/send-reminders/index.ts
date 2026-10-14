// Feature 5 (bulk reminders), stage 1: the NAIVE version, written the way most tutorials do it.
// Shown to fail in src/probes/reminders/naive.mjs; stage 2 replaces it.
//
//   1. find confirmed bookings starting in 23–25 hours that haven't been reminded
//   2. send one email each, in a loop
//   3. mark them all as reminded, at the end
//
// Called by the database (pg_cron → public.run_reminders → pg_net) with the project's secret key.
// Emails go to the local Mailpit inbox (MAILPIT_URL, default http://inbucket:8025 inside Docker).
// Test switches for the demonstration only: hostId (limit to one host), crashAfter (throw after
// N emails), delayMs (pretend each email takes that long, like a real provider's API call).
import '@supabase/functions-js/edge-runtime.d.ts'
import postgres from 'postgres'

const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { max: 1, prepare: false })
const MAILPIT = Deno.env.get('MAILPIT_URL') ?? 'http://inbucket:8025'
const APP_URL = Deno.env.get('APP_URL') ?? 'http://127.0.0.1:5173'
const secretKeys = [
  ...Object.values(JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}')),
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
].filter(Boolean) as string[]
const fmt = new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeStyle: 'short', timeZone: 'UTC' })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// provider 'test' (feature 5, stage 4 comparison only): send through the rate-limited test provider
// (Edge Function test-mail-provider) instead of Mailpit directly. Still naive: a refusal (429) is
// just an error that ends the loop.
const TEST_PROVIDER = Deno.env.get('TEST_MAIL_PROVIDER_URL') ?? 'http://kong:8000/functions/v1/test-mail-provider'

async function sendEmail(to: { email: string; name: string }, subject: string, text: string, provider = 'mailpit') {
  const [url, auth] = provider === 'test' ? [TEST_PROVIDER, { Authorization: `Bearer ${secretKeys[0]}` }] : [`${MAILPIT}/api/v1/send`, {}]
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ From: { Email: 'reminders@booking.local', Name: 'Booking reminders' }, To: [{ Email: to.email, Name: to.name }], Subject: subject, Text: text }),
  })
  if (!res.ok) throw new Error(`email provider: HTTP ${res.status}`)
}

Deno.serve(async (req) => {
  const bearer = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
  if (!bearer || !secretKeys.includes(bearer)) return Response.json({ error: 'Not allowed' }, { status: 401 })
  const { hostId = null, crashAfter = null, delayMs = 0, provider = 'mailpit' } = await req.json().catch(() => ({}))
  const started = Date.now()

  // 1. Tomorrow's bookings that haven't been reminded yet.
  const due = await sql`
    select b.id, b.guest_name, b.guest_email, b.cancel_token, s.starts_at, p.display_name as host
      from public.bookings b
      join public.slots s on s.id = b.slot_id
      join public.profiles p on p.id = s.host_id
     where b.status = 'confirmed'
       and b.reminder_sent_at is null
       and s.starts_at between now() + interval '23 hours' and now() + interval '25 hours'
       and (${hostId}::uuid is null or s.host_id = ${hostId}::uuid)
     order by s.starts_at`

  // 2. One email each.
  let sent = 0
  for (const b of due) {
    if (crashAfter !== null && sent >= crashAfter) throw new Error(`simulated crash after ${sent} emails`)
    if (delayMs) await sleep(delayMs)
    await sendEmail(
      { email: b.guest_email, name: b.guest_name },
      `Reminder: your booking with ${b.host} tomorrow`,
      `Hi ${b.guest_name},\n\nThis is a reminder of your booking with ${b.host} on ${fmt.format(b.starts_at)} (UTC).\n\n` +
        `Can't make it? Cancel here: ${APP_URL}/cancel/${b.cancel_token}\n`,
      provider,
    )
    sent++
  }

  // 3. Mark them all as reminded, at the end.
  if (due.length) await sql`update public.bookings set reminder_sent_at = now() where id in ${sql(due.map((b) => b.id))}`
  return Response.json({ sent, ms: Date.now() - started })
})
