// Feature 5 (bulk reminders), stage 2: the queue worker (Supabase Queues / pgmq).
// public.enqueue_reminders() puts one message per due reminder on the queue `reminders`; this
// function works through it in small batches:
//
//   read a batch      → pgmq hides those messages from other workers for `vt` seconds
//   per message       → load the booking; skip it if cancelled, past or already reminded;
//                       send the email; then mark as sent + delete the message (one transaction)
//   on an error       → leave the message: it reappears after vt and is retried
//   read too often    → move it to the archive (dead letter), stop retrying
//   time budget used  → stop; unprocessed messages are released at once for the next run
//
// Called by the database (pg_cron → public.process_reminders → pg_net) with the project's secret key.
// Emails go to the local Mailpit inbox. Test switches for the probe: delayMs, crashAfter +
// crashMode ('before-send' | 'after-send'), failEmails (addresses whose sending always fails).
import '@supabase/functions-js/edge-runtime.d.ts'
import postgres from 'postgres'

const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { max: 1, prepare: false })
// pgmq functions are overloaded (e.g. delete(queue, id) and delete(queue, ids[])): untyped
// parameters are ambiguous, so every pgmq call below casts its arguments.
const MAILPIT = Deno.env.get('MAILPIT_URL') ?? 'http://inbucket:8025'
const APP_URL = Deno.env.get('APP_URL') ?? 'http://127.0.0.1:5173'
const QUEUE = 'reminders'
const secretKeys = [
  ...Object.values(JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}')),
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
].filter(Boolean)
const fmt = new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeStyle: 'short', timeZone: 'UTC' })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function sendEmail(to: { email: string; name: string }, subject: string, text: string, failEmails: string[]) {
  if (failEmails.includes(to.email)) throw new Error(`provider rejected ${to.email} (test switch)`)
  const res = await fetch(`${MAILPIT}/api/v1/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ From: { Email: 'reminders@booking.local', Name: 'Booking reminders' }, To: [{ Email: to.email, Name: to.name }], Subject: subject, Text: text }),
  })
  if (!res.ok) throw new Error(`Mailpit: HTTP ${res.status}`)
}

Deno.serve(async (req) => {
  const bearer = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
  if (!bearer || !secretKeys.includes(bearer)) return Response.json({ error: 'Not allowed' }, { status: 401 })
  const {
    budgetMs = 20_000, batch = 20, vt = 60, maxReads = 5,
    delayMs = 0, crashAfter = null, crashMode = 'before-send', failEmails = [],
  } = await req.json().catch(() => ({}))

  const started = Date.now()
  const stats = { sent: 0, skipped: 0, failed: 0, deadLettered: 0, released: 0 }

  outer: while (Date.now() - started < budgetMs) {
    const messages = await sql`select msg_id, read_ct, message from pgmq.read(${QUEUE}::text, ${vt}::int, ${batch}::int)`
    if (messages.length === 0) break

    for (const [i, m] of messages.entries()) {
      // Out of time: hand the rest of the batch back right away (instead of after vt).
      if (Date.now() - started >= budgetMs) {
        for (const rest of messages.slice(i)) await sql`select pgmq.set_vt(${QUEUE}::text, ${rest.msg_id}::bigint, 0)`
        stats.released += messages.length - i
        break outer
      }
      // Retried too often: stop trying, keep it in the archive for a human to look at.
      if (m.read_ct > maxReads) {
        await sql`select pgmq.archive(${QUEUE}::text, ${m.msg_id}::bigint)`
        stats.deadLettered++
        continue
      }

      const [b] = await sql`
        select b.id, b.guest_name, b.guest_email, b.cancel_token, b.status, b.reminder_sent_at,
               s.starts_at, p.display_name as host
          from public.bookings b
          join public.slots s on s.id = b.slot_id
          join public.profiles p on p.id = s.host_id
         where b.id = ${m.message.booking_id}`
      // Nothing to send anymore (cancelled, deleted, started, or reminded meanwhile): done.
      if (!b || b.status !== 'confirmed' || b.reminder_sent_at || b.starts_at < new Date()) {
        await sql`select pgmq.delete(${QUEUE}::text, ${m.msg_id}::bigint)`
        stats.skipped++
        continue
      }

      if (crashAfter !== null && crashMode === 'before-send' && stats.sent >= crashAfter) throw new Error(`simulated crash after ${stats.sent} emails`)
      try {
        if (delayMs) await sleep(delayMs)
        await sendEmail(
          { email: b.guest_email, name: b.guest_name },
          `Reminder: your booking with ${b.host} tomorrow`,
          `Hi ${b.guest_name},\n\nThis is a reminder of your booking with ${b.host} on ${fmt.format(b.starts_at)} (UTC).\n\n` +
            `Can't make it? Cancel here: ${APP_URL}/cancel/${b.cancel_token}\n`,
          failEmails,
        )
      } catch (err) {
        // Leave the message on the queue: it reappears after vt and is retried (up to maxReads).
        console.error('reminder failed:', err instanceof Error ? err.message : err)
        stats.failed++
        continue
      }
      stats.sent++
      // The worst moment to crash: email sent, not yet recorded. The message reappears after vt
      // and this ONE email is sent again (at-least-once; exactly-once needs the provider's help).
      if (crashAfter !== null && crashMode === 'after-send' && stats.sent > crashAfter) throw new Error(`simulated crash right after sending email ${stats.sent}`)

      await sql.begin(async (tx) => {
        await tx`update public.bookings set reminder_sent_at = now() where id = ${b.id} and reminder_sent_at is null`
        await tx`select pgmq.delete(${QUEUE}::text, ${m.msg_id}::bigint)`
      })
    }
  }

  const [{ queue_length }] = await sql`select queue_length from pgmq.metrics(${QUEUE}::text)`
  return Response.json({ ...stats, left: Number(queue_length), ms: Date.now() - started })
})
