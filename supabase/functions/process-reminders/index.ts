// Feature 5 (bulk reminders): the queue worker (Supabase Queues / pgmq).
// public.enqueue_reminders() puts one message per due reminder on the queue `reminders`; this
// function works through it in small batches:
//
//   one worker at a time → a lease (reminder_worker_lease) that expires by itself       [stage 3]
//   read a batch         → pgmq hides those messages from other workers for `vt` seconds
//   per message          → skip it if cancelled, past, already reminded or opted out   [opt-out: stage 3]
//                          wait for its turn (steady pace for the provider's limit)     [stage 3]
//                          send; then mark as sent + delete the message (one transaction)
//   provider says 429    → put the message back with a delay, NOT counted as a failure, stop [stage 3]
//   other error          → leave the message: it reappears after vt and is retried
//   read too often       → move it to the archive (dead letter), stop retrying
//   time budget used     → stop; unprocessed messages go back as fresh ones (read count reset) [stage 3]
//
// Called by the database (pg_cron → public.process_reminders → pg_net) with the project's secret key.
// Options (body): budgetMs, batch, vt, maxReads; ratePerSecond (0 = unpaced), lease, throttleAware
// (false = stage 2 behaviour, for the probe's "before" run); provider 'mailpit' (direct) or 'test'
// (the rate-limited test provider). Test switches: delayMs, crashAfter + crashMode, failEmails.
import '@supabase/functions-js/edge-runtime.d.ts'
import postgres from 'postgres'

const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { max: 1, prepare: false })
// pgmq functions are overloaded (e.g. delete(queue, id) and delete(queue, ids[])): untyped
// parameters are ambiguous, so every pgmq call below casts its arguments.
const MAILPIT = Deno.env.get('MAILPIT_URL') ?? 'http://inbucket:8025'
const TEST_PROVIDER = Deno.env.get('TEST_MAIL_PROVIDER_URL') ?? 'http://kong:8000/functions/v1/test-mail-provider'
const APP_URL = Deno.env.get('APP_URL') ?? 'http://127.0.0.1:5173'
// Public base URL of the Edge Functions, for the one-click unsubscribe header (mail apps call it).
const PUBLIC_FUNCTIONS_URL = Deno.env.get('PUBLIC_FUNCTIONS_URL') ?? 'http://127.0.0.1:54321/functions/v1'
const QUEUE = 'reminders'
const secretKeys = [
  ...Object.values(JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}')),
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
].filter(Boolean) as string[]
const fmt = new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeStyle: 'short', timeZone: 'UTC' })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

class Throttled extends Error {
  constructor(public retryAfter: number) { super(`provider rate limit (retry after ${retryAfter} s)`) }
}

type Booking = { guest_email: string; guest_name: string; host: string; starts_at: Date; cancel_token: string }

function reminderEmail(b: Booking) {
  const unsubscribePage = `${APP_URL}/reminders/unsubscribe/${b.cancel_token}`
  return {
    From: { Email: 'reminders@booking.local', Name: 'Booking reminders' },
    To: [{ Email: b.guest_email, Name: b.guest_name }],
    Subject: `Reminder: your booking with ${b.host} tomorrow`,
    Text: `Hi ${b.guest_name},\n\nThis is a reminder of your booking with ${b.host} on ${fmt.format(b.starts_at)} (UTC).\n\n` +
      `Can't make it? Cancel here: ${APP_URL}/cancel/${b.cancel_token}\n\n` +
      `Don't want reminders? ${unsubscribePage}\n`,
    // The "Unsubscribe" button in Gmail / Apple Mail (RFC 2369 + RFC 8058 one-click).
    Headers: {
      'List-Unsubscribe': `<${PUBLIC_FUNCTIONS_URL}/reminders-unsubscribe?token=${b.cancel_token}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  }
}

async function send(email: ReturnType<typeof reminderEmail>, provider: string, failEmails: string[]) {
  if (failEmails.includes(email.To[0].Email)) throw new Error(`provider rejected ${email.To[0].Email} (test switch)`)
  const [url, headers] = provider === 'test'
    ? [TEST_PROVIDER, { Authorization: `Bearer ${secretKeys[0]}` }]
    : [`${MAILPIT}/api/v1/send`, {}]
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(email) })
  if (res.status === 429) throw new Throttled(Number(res.headers.get('retry-after')) || 1)
  if (!res.ok) throw new Error(`email provider: HTTP ${res.status}`)
}

Deno.serve(async (req) => {
  const bearer = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
  if (!bearer || !secretKeys.includes(bearer)) return Response.json({ error: 'Not allowed' }, { status: 401 })
  const {
    budgetMs = 20_000, batch = 20, vt = 60, maxReads = 5,
    ratePerSecond = 10, lease = true, throttleAware = true, provider = 'mailpit',
    delayMs = 0, crashAfter = null, crashMode = 'before-send', failEmails = [],
  } = await req.json().catch(() => ({}))

  const started = Date.now()
  const runId = crypto.randomUUID()
  const stats = { sent: 0, skipped: 0, optedOut: 0, failed: 0, throttled: 0, deadLettered: 0, released: 0 }

  // One worker at a time, so the send rate below is the rate the provider sees. The lease runs
  // out by itself (budget + 5 s), so a worker the runtime kills can't block the next one for long.
  if (lease) {
    const [got] = await sql`update public.reminder_worker_lease
                               set holder = ${runId}, expires_at = now() + make_interval(secs => ${budgetMs / 1000 + 5})
                             where id = 1 and expires_at < now()
                            returning 1`
    if (!got) return Response.json({ busy: true, ...stats })
  }

  try {
    let nextSendAt = 0
    outer: while (Date.now() - started < budgetMs) {
      const messages = await sql`select msg_id, read_ct, message from pgmq.read(${QUEUE}::text, ${vt}::int, ${batch}::int)`
      if (messages.length === 0) break
      // Hand unprocessed messages back. Not with set_vt: pgmq counts every READ (read_ct), not every
      // failure, so messages that are read and handed back again and again (budget used up, provider
      // throttling) would reach maxReads and be dead-lettered without ever failing. Re-sending them as
      // fresh messages (delete + send, one transaction) resets the count.
      const handBack = async (from: number) => {
        for (const rest of messages.slice(from)) {
          await sql.begin(async (tx) => {
            await tx`select pgmq.delete(${QUEUE}::text, ${rest.msg_id}::bigint)`
            await tx`select pgmq.send(${QUEUE}::text, ${rest.message}::jsonb, 0::int)`
          })
        }
        stats.released += messages.length - from
      }

      for (const [i, m] of messages.entries()) {
        // Out of time: hand the rest of the batch back right away (instead of after vt).
        if (Date.now() - started >= budgetMs) { await handBack(i); break outer }
        // Retried too often: stop trying, keep it in the archive for a human to look at.
        if (m.read_ct > maxReads) {
          await sql`select pgmq.archive(${QUEUE}::text, ${m.msg_id}::bigint)`
          stats.deadLettered++
          continue
        }

        const [b] = await sql`
          select b.id, b.guest_name, b.guest_email, b.cancel_token, b.status, b.reminder_sent_at,
                 s.starts_at, p.display_name as host, public.reminders_opted_out(b.guest_email) as opted_out
            from public.bookings b
            join public.slots s on s.id = b.slot_id
            join public.profiles p on p.id = s.host_id
           where b.id = ${m.message.booking_id}`
        // Nothing to send anymore: cancelled, deleted, started, reminded meanwhile, or opted out.
        if (!b || b.status !== 'confirmed' || b.reminder_sent_at || b.starts_at < new Date() || b.opted_out) {
          await sql`select pgmq.delete(${QUEUE}::text, ${m.msg_id}::bigint)`
          if (b?.opted_out) stats.optedOut++
          else stats.skipped++
          continue
        }

        if (crashAfter !== null && crashMode === 'before-send' && stats.sent >= crashAfter) throw new Error(`simulated crash after ${stats.sent} emails`)
        // Steady pace: at most ratePerSecond emails per second from this (the only) worker.
        if (ratePerSecond > 0) {
          const wait = nextSendAt - Date.now()
          if (wait > 0) await sleep(wait)
          nextSendAt = Math.max(Date.now(), nextSendAt) + 1000 / ratePerSecond
        }
        try {
          if (delayMs) await sleep(delayMs)
          await send(reminderEmail(b as Booking), provider, failEmails)
        } catch (err) {
          if (err instanceof Throttled && throttleAware) {
            // The provider says "slow down": nothing is wrong with this reminder. Put it back with a
            // delay as a NEW message (pgmq can't un-count a read, so retrying the old one would push
            // a healthy reminder towards the dead letter), hand back the batch, end this run.
            await sql.begin(async (tx) => {
              await tx`select pgmq.delete(${QUEUE}::text, ${m.msg_id}::bigint)`
              await tx`select pgmq.send(${QUEUE}::text, ${m.message}::jsonb, ${err.retryAfter}::int)`
            })
            stats.throttled++
            await handBack(i + 1)
            break outer
          }
          // Leave the message on the queue: it reappears after vt and is retried (up to maxReads).
          console.error('reminder failed:', err instanceof Error ? err.message : err)
          if (err instanceof Throttled) stats.throttled++
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
  } finally {
    if (lease) await sql`update public.reminder_worker_lease set expires_at = '-infinity' where holder = ${runId}`
  }

  const [{ queue_length }] = await sql`select queue_length from pgmq.metrics(${QUEUE}::text)`
  return Response.json({ ...stats, left: Number(queue_length), ms: Date.now() - started })
})
